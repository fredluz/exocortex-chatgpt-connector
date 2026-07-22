#import <ApplicationServices/ApplicationServices.h>
#import <AppKit/AppKit.h>
#import <Foundation/Foundation.h>

static const int MAX_DEPTH = 60;

static NSString *stringAttr(AXUIElementRef element, CFStringRef attr) {
  CFTypeRef value = NULL;
  AXError err = AXUIElementCopyAttributeValue(element, attr, &value);
  if (err != kAXErrorSuccess || !value) return nil;
  NSString *out = nil;
  if (CFGetTypeID(value) == CFStringGetTypeID()) {
    out = [(__bridge NSString *)value copy];
  } else if (CFGetTypeID(value) == CFNumberGetTypeID()) {
    out = [(__bridge NSNumber *)value stringValue];
  }
  CFRelease(value);
  return out;
}

static NSArray<NSString *> *textCandidates(AXUIElementRef element) {
  NSMutableArray<NSString *> *items = [NSMutableArray array];
  for (id attr in @[
    (__bridge id)kAXDescriptionAttribute,
    (__bridge id)kAXTitleAttribute,
    (__bridge id)kAXValueAttribute,
    (__bridge id)kAXHelpAttribute,
    (__bridge id)kAXIdentifierAttribute,
  ]) {
    NSString *value = stringAttr(element, (__bridge CFStringRef)attr);
    if (value.length > 0) [items addObject:value];
  }
  return items;
}

static BOOL matchesLabels(AXUIElementRef element, NSArray<NSString *> *labels) {
  NSArray<NSString *> *candidates = textCandidates(element);
  for (NSString *label in labels) {
    if (label.length == 0) continue;
    for (NSString *candidate in candidates) {
      if ([candidate isEqualToString:label] || [candidate containsString:label]) return YES;
    }
  }
  return NO;
}

static pid_t pidForBundle(NSString *bundleId) {
  NSArray<NSRunningApplication *> *apps = [NSRunningApplication runningApplicationsWithBundleIdentifier:bundleId];
  if (apps.count > 0) return apps.firstObject.processIdentifier;

  NSTask *task = [[NSTask alloc] init];
  task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/pgrep"];
  task.arguments = @[@"-x", @"ChatGPT"];
  NSPipe *pipe = [NSPipe pipe];
  task.standardOutput = pipe;
  task.standardError = [NSPipe pipe];
  NSError *error = nil;
  if (![task launchAndReturnError:&error]) return -1;
  [task waitUntilExit];
  if (task.terminationStatus != 0) return -1;
  NSData *data = [[pipe fileHandleForReading] readDataToEndOfFile];
  NSString *raw = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  return (pid_t)[raw integerValue];
}

static AXUIElementRef appElement(NSString *bundleId) {
  pid_t pid = pidForBundle(bundleId);
  if (pid <= 0) return NULL;
  return AXUIElementCreateApplication(pid);
}

static AXUIElementRef firstWindow(NSString *bundleId) {
  AXUIElementRef app = appElement(bundleId);
  if (!app) return NULL;

  CFTypeRef windowsValue = NULL;
  AXError err = AXUIElementCopyAttributeValue(app, kAXWindowsAttribute, &windowsValue);
  CFRelease(app);
  if (err != kAXErrorSuccess || !windowsValue || CFGetTypeID(windowsValue) != CFArrayGetTypeID()) {
    if (windowsValue) CFRelease(windowsValue);
    return NULL;
  }

  CFArrayRef windows = (CFArrayRef)windowsValue;
  AXUIElementRef fallback = NULL;
  CFIndex count = CFArrayGetCount(windows);
  for (CFIndex i = 0; i < count; i++) {
    AXUIElementRef window = (AXUIElementRef)CFArrayGetValueAtIndex(windows, i);
    NSString *role = stringAttr(window, kAXRoleAttribute) ?: @"";
    NSString *subrole = stringAttr(window, kAXSubroleAttribute) ?: @"";
    if ([role isEqualToString:@"AXApplication"]) continue;
    if ([subrole isEqualToString:@"AXDialog"]) continue;
    if ([subrole isEqualToString:@"AXStandardWindow"]) {
      CFRetain(window);
      CFRelease(windowsValue);
      return window;
    }
    if (!fallback) fallback = window;
  }

  if (fallback) CFRetain(fallback);
  CFRelease(windowsValue);
  return fallback;
}

static void walk(AXUIElementRef element, int depth, void (^visitor)(AXUIElementRef element, int depth, BOOL *stop), BOOL *stop) {
  if (!element || *stop || depth > MAX_DEPTH) return;
  visitor(element, depth, stop);
  if (*stop) return;

  CFTypeRef childrenValue = NULL;
  AXError err = AXUIElementCopyAttributeValue(element, kAXChildrenAttribute, &childrenValue);
  if (err != kAXErrorSuccess || !childrenValue || CFGetTypeID(childrenValue) != CFArrayGetTypeID()) {
    if (childrenValue) CFRelease(childrenValue);
    return;
  }

  CFArrayRef children = (CFArrayRef)childrenValue;
  CFIndex count = CFArrayGetCount(children);
  for (CFIndex i = 0; i < count; i++) {
    walk((AXUIElementRef)CFArrayGetValueAtIndex(children, i), depth + 1, visitor, stop);
    if (*stop) break;
  }
  CFRelease(childrenValue);
}

static NSArray<NSString *> *splitLabels(NSString *raw) {
  if (!raw.length) return @[];
  return [raw componentsSeparatedByString:@"|||"];
}

static int activate(NSString *bundleId) {
  NSArray<NSRunningApplication *> *apps = [NSRunningApplication runningApplicationsWithBundleIdentifier:bundleId];
  if (apps.count > 0) {
#pragma clang diagnostic push
#pragma clang diagnostic ignored "-Wdeprecated-declarations"
    if ([apps.firstObject activateWithOptions:NSApplicationActivateIgnoringOtherApps]) return 0;
#pragma clang diagnostic pop
  }
  NSTask *task = [[NSTask alloc] init];
  task.executableURL = [NSURL fileURLWithPath:@"/usr/bin/open"];
  task.arguments = @[@"-b", bundleId];
  NSError *error = nil;
  if (![task launchAndReturnError:&error]) return 1;
  [task waitUntilExit];
  return task.terminationStatus;
}

static int cmdTrusted(void) {
  printf("%s\n", AXIsProcessTrusted() ? "1" : "0");
  return 0;
}

static int cmdPid(NSString *bundleId) {
  pid_t pid = pidForBundle(bundleId);
  if (pid <= 0) return 1;
  printf("%d\n", pid);
  return 0;
}

static int cmdFrontmost(void) {
  NSString *bundleId = NSWorkspace.sharedWorkspace.frontmostApplication.bundleIdentifier ?: @"";
  printf("%s\n", bundleId.UTF8String);
  return 0;
}

static int cmdHasButton(NSString *bundleId, NSArray<NSString *> *labels) {
  AXUIElementRef window = firstWindow(bundleId);
  if (!window) return 2;
  __block BOOL found = NO;
  BOOL stop = NO;
  walk(window, 0, ^(AXUIElementRef element, int depth, BOOL *innerStop) {
    NSString *role = stringAttr(element, kAXRoleAttribute) ?: @"";
    if ([role isEqualToString:@"AXButton"] && matchesLabels(element, labels)) {
      found = YES;
      *innerStop = YES;
    }
  }, &stop);
  CFRelease(window);
  printf("%s\n", found ? "1" : "0");
  return 0;
}

static int cmdClickButtons(NSString *bundleId, NSArray<NSString *> *labels) {
  AXUIElementRef window = firstWindow(bundleId);
  if (!window) return 2;
  __block int clicked = 0;
  BOOL stop = NO;
  walk(window, 0, ^(AXUIElementRef element, int depth, BOOL *innerStop) {
    NSString *role = stringAttr(element, kAXRoleAttribute) ?: @"";
    if ([role isEqualToString:@"AXButton"] && matchesLabels(element, labels)) {
      if (AXUIElementPerformAction(element, kAXPressAction) == kAXErrorSuccess) clicked += 1;
    }
  }, &stop);
  CFRelease(window);
  printf("%d\n", clicked);
  return 0;
}

static int cmdClickButton(NSString *bundleId, NSArray<NSString *> *labels) {
  AXUIElementRef window = firstWindow(bundleId);
  if (!window) return 2;
  __block int clicked = 0;
  BOOL stop = NO;
  walk(window, 0, ^(AXUIElementRef element, int depth, BOOL *innerStop) {
    NSString *role = stringAttr(element, kAXRoleAttribute) ?: @"";
    if ([role isEqualToString:@"AXButton"] && matchesLabels(element, labels)) {
      if (AXUIElementPerformAction(element, kAXPressAction) == kAXErrorSuccess) clicked = 1;
      *innerStop = YES;
    }
  }, &stop);
  CFRelease(window);
  printf("%d\n", clicked);
  return 0;
}

static int cmdSetTextarea(NSString *bundleId, NSString *text) {
  AXUIElementRef window = firstWindow(bundleId);
  if (!window) return 2;
  __block AXUIElementRef textAreaTarget = NULL;
  __block AXUIElementRef textFieldTarget = NULL;
  BOOL stop = NO;
  walk(window, 0, ^(AXUIElementRef element, int depth, BOOL *innerStop) {
    NSString *role = stringAttr(element, kAXRoleAttribute) ?: @"";
    if ([role isEqualToString:@"AXTextArea"]) {
      if (textAreaTarget) CFRelease(textAreaTarget);
      textAreaTarget = element;
      CFRetain(textAreaTarget);
    } else if ([role isEqualToString:@"AXTextField"]) {
      if (textFieldTarget) CFRelease(textFieldTarget);
      textFieldTarget = element;
      CFRetain(textFieldTarget);
    }
  }, &stop);
  CFRelease(window);

  AXUIElementRef target = textAreaTarget ?: textFieldTarget;
  if (!target) {
    printf("0\n");
    return 0;
  }

  AXUIElementSetAttributeValue(target, kAXFocusedAttribute, kCFBooleanTrue);
  AXError err = AXUIElementSetAttributeValue(target, kAXValueAttribute, (__bridge CFStringRef)text);
  if (textAreaTarget && textAreaTarget != target) CFRelease(textAreaTarget);
  if (textFieldTarget && textFieldTarget != target) CFRelease(textFieldTarget);
  CFRelease(target);
  printf("%s\n", err == kAXErrorSuccess ? "1" : "0");
  return 0;
}

static int cmdCollectTexts(NSString *bundleId) {
  AXUIElementRef window = firstWindow(bundleId);
  if (!window) return 2;
  NSMutableOrderedSet<NSString *> *texts = [NSMutableOrderedSet orderedSet];
  BOOL stop = NO;
  walk(window, 0, ^(AXUIElementRef element, int depth, BOOL *innerStop) {
    NSString *role = stringAttr(element, kAXRoleAttribute) ?: @"";
    if (![role isEqualToString:@"AXStaticText"] && ![role isEqualToString:@"AXTextArea"]) return;
    for (NSString *candidate in textCandidates(element)) {
      NSString *trimmed = [candidate stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceAndNewlineCharacterSet];
      if (trimmed.length > 2) [texts addObject:trimmed];
    }
  }, &stop);
  CFRelease(window);
  NSString *joined = [[texts array] componentsJoinedByString:@"\n\n"];
  printf("%s\n", joined.UTF8String ?: "");
  return 0;
}

static int cmdDump(NSString *bundleId) {
  AXUIElementRef window = firstWindow(bundleId);
  if (!window) return 2;
  BOOL stop = NO;
  walk(window, 0, ^(AXUIElementRef element, int depth, BOOL *innerStop) {
    NSString *role = stringAttr(element, kAXRoleAttribute) ?: @"";
    NSString *desc = stringAttr(element, kAXDescriptionAttribute) ?: @"";
    NSString *title = stringAttr(element, kAXTitleAttribute) ?: @"";
    NSString *value = stringAttr(element, kAXValueAttribute) ?: @"";
    NSMutableString *indent = [NSMutableString string];
    for (int i = 0; i < depth; i++) [indent appendString:@"  "];
    printf("%s%s desc=%s title=%s value=%s\n", indent.UTF8String, role.UTF8String, desc.UTF8String, title.UTF8String, value.UTF8String);
  }, &stop);
  CFRelease(window);
  return 0;
}

int main(int argc, const char * argv[]) {
  @autoreleasepool {
    if (argc < 2) {
      fprintf(stderr, "usage: chatgpt-ax-helper <trusted|pid|frontmost|activate|has-button|click-button|click-buttons|set-textarea|collect-texts|dump> [args]\n");
      return 64;
    }

    NSString *cmd = [NSString stringWithUTF8String:argv[1]];
    NSString *bundleId = argc > 2 ? [NSString stringWithUTF8String:argv[2]] : @"com.openai.chat";

    if ([cmd isEqualToString:@"trusted"]) return cmdTrusted();
    if ([cmd isEqualToString:@"pid"]) return cmdPid(bundleId);
    if ([cmd isEqualToString:@"frontmost"]) return cmdFrontmost();
    if ([cmd isEqualToString:@"activate"]) return activate(bundleId);
    if ([cmd isEqualToString:@"set-textarea"]) return cmdSetTextarea(bundleId, argc > 3 ? [NSString stringWithUTF8String:argv[3]] : @"");
    if ([cmd isEqualToString:@"collect-texts"]) return cmdCollectTexts(bundleId);
    if ([cmd isEqualToString:@"dump"]) return cmdDump(bundleId);

    NSArray<NSString *> *labels = argc > 3 ? splitLabels([NSString stringWithUTF8String:argv[3]]) : @[];
    if ([cmd isEqualToString:@"has-button"]) return cmdHasButton(bundleId, labels);
    if ([cmd isEqualToString:@"click-button"]) return cmdClickButton(bundleId, labels);
    if ([cmd isEqualToString:@"click-buttons"]) return cmdClickButtons(bundleId, labels);

    fprintf(stderr, "unknown command: %s\n", argv[1]);
    return 64;
  }
}
