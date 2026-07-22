#import <ApplicationServices/ApplicationServices.h>
#import <Foundation/Foundation.h>

int main(int argc, const char * argv[]) {
  @autoreleasepool {
    NSFileManager *fm = [NSFileManager defaultManager];
    NSString *home = NSHomeDirectory();
    NSString *exoHome = [[[NSProcessInfo processInfo] environment] objectForKey:@"EXOCORTEX_HOME"] ?: [home stringByAppendingPathComponent:@".exocortex"];
    NSString *root = @"/Users/fredluz/Code/exocortex-chatgpt-connector";
    NSString *node = @"/opt/homebrew/bin/node";
    NSString *cli = [root stringByAppendingPathComponent:@"cli.mjs"];
    NSString *helper = [[[NSBundle mainBundle] bundlePath] stringByAppendingPathComponent:@"Contents/MacOS/chatgpt-ax-helper"];
    NSString *logDir = [exoHome stringByAppendingPathComponent:@"chatgpt/logs"];
    NSString *logFile = [logDir stringByAppendingPathComponent:@"daemon-wrapper.log"];

    [fm createDirectoryAtPath:logDir withIntermediateDirectories:YES attributes:nil error:nil];
    if (![fm fileExistsAtPath:logFile]) {
      [@"" writeToFile:logFile atomically:YES encoding:NSUTF8StringEncoding error:nil];
    }

    NSFileHandle *logHandle = [NSFileHandle fileHandleForWritingAtPath:logFile];
    [logHandle seekToEndOfFile];

    BOOL axTrusted = AXIsProcessTrusted();
    NSString *start = [NSString stringWithFormat:@"==== %@ ExocortexChatGPTDaemon native launcher starting ====\nROOT=%@\nNODE=%@\nHELPER=%@\nEXOCORTEX_HOME=%@\nAXIsProcessTrusted=%@\n", [[NSDate date] descriptionWithLocale:nil], root, node, helper, exoHome, axTrusted ? @"true" : @"false"];
    [logHandle writeData:[start dataUsingEncoding:NSUTF8StringEncoding]];

    NSTask *task = [[NSTask alloc] init];
    task.executableURL = [NSURL fileURLWithPath:node];
    task.arguments = @[cli, @"daemon"];
    task.currentDirectoryURL = [NSURL fileURLWithPath:root];

    NSMutableDictionary *env = [[[NSProcessInfo processInfo] environment] mutableCopy];
    env[@"PATH"] = @"/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin";
    env[@"EXOCORTEX_HOME"] = exoHome;
    env[@"CHATGPT_NATIVE_AX_HELPER"] = helper;
    if (!env[@"CHATGPT_NATIVE_MAX_ACTIVE"]) env[@"CHATGPT_NATIVE_MAX_ACTIVE"] = @"3";
    task.environment = env;
    task.standardOutput = logHandle;
    task.standardError = logHandle;

    NSError *error = nil;
    if (![task launchAndReturnError:&error]) {
      NSString *msg = [NSString stringWithFormat:@"launcher failed: %@\n", error.localizedDescription ?: @"unknown error"];
      [logHandle writeData:[msg dataUsingEncoding:NSUTF8StringEncoding]];
      [logHandle closeFile];
      return 1;
    }

    [task waitUntilExit];
    int status = task.terminationStatus;
    NSString *end = [NSString stringWithFormat:@"==== child exited status=%d ====\n", status];
    [logHandle writeData:[end dataUsingEncoding:NSUTF8StringEncoding]];
    [logHandle closeFile];
    return status;
  }
}
