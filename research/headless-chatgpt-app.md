# Headless ChatGPT macOS App Investigation

Date: 2026-04-23

Scope: local static/dynamic inspection of `/Applications/ChatGPT.app`
version `1.2026.104`, build `1776709323`, commit `13b4c04c63`.
No secret token values were read or written.

## Executive Summary

The installed app already contains a nearly ideal non-UI prompt API:

```text
ChatGPT.IntentService.activeAccountIntentService() throws -> IntentService
ChatGPT.IntentService.setUpNewChat() async throws -> ()
ChatGPT.IntentService.shouldAskForNewChat() async -> Bool
ChatGPT.IntentService.submit(prompt:retryCount:) async throws -> SendableMessage
ChatGPT.SendableMessage.text: String
ChatGPT.SendableMessage.messageId: String
ChatGPT.SendableMessage.conversationId: String
```

This is the same API the app's `AskIntent` shortcut uses. It is the simplest
internal route for a stdin/stdout, Unix socket, or local HTTP bridge.

The catch is auth/session reuse. The session is in OpenAI's keychain access
group:

```text
keychain-access-groups = 2DC432GLL2.com.openai.shared
application group = 2DC432GLL2.group.com.openai.chat
team id = 2DC432GLL2
```

A locally built or re-signed headless clone cannot read those keychain items.
Entitlements are granted to the signed process, not to `ChatGPT.framework`.
So a stripped third-party bundle can load the framework, but it will not
automatically reuse the existing login session unless it is signed with the
same OpenAI team/keychain entitlements or delegates execution back to the
original signed app.

Practical conclusion:

1. Best simple path: use the existing signed app's App Intent / Shortcuts
   surface, or a tiny wrapper around it, as the headless interface.
2. Best private-code path, if signing/auth can be solved: build a minimal
   process that loads `ChatGPT.framework` and calls `IntentService`.
3. Not recommended: talking to `ChatGPTHelper`; it is a status-bar/launcher
   XPC service, not a conversation service.
4. Not possible in the literal sense: loading `ChatGPT.framework` without
   loading AppKit/SwiftUI/WebKit. The framework links those libraries. A
   headless process can avoid creating windows/WebViews, but dyld will still
   map UI frameworks.

## Bundle Inventory

Main bundle metadata:

- Bundle ID: `com.openai.chat`
- Version: `1.2026.104`
- Build: `1776709323`
- Main executable: `Contents/MacOS/ChatGPT`
- Helper executable: `Contents/Resources/ChatGPTHelper`
- LaunchAgent: `Contents/Library/LaunchAgents/com.openai.chat-helper.plist`
- Main logic: `Contents/Frameworks/ChatGPT.framework/Versions/A/ChatGPT`

Important bundled dependencies:

```text
Contents/Frameworks/ChatGPT.framework
Contents/Frameworks/Assets.framework
Contents/Frameworks/Lottie.framework
Contents/Frameworks/LiveKitWebRTC.framework
Contents/Frameworks/Sparkle.framework
Contents/Frameworks/libwebrtc-audio-processing-2.1.dylib
Contents/Frameworks/libswiftCompatibilitySpan.dylib
```

`ChatGPT.framework` is about 89 MB on disk and has no shipped public headers,
`.swiftmodule`, `.swiftinterface`, or module map. It is therefore not cleanly
`import ChatGPT`-able from a new Swift target. The private Swift symbols are
still present in the Mach-O exports trie.

## Framework Loading

`otool -L` shows `ChatGPT.framework` depends directly on AppKit, SwiftUI,
WebKit, UserNotifications, AppIntents, CoreData, AuthenticationServices,
CFNetwork, Security, StoreKit, and many other system frameworks.

Direct `dlopen` from outside the bundle fails unless the embedded dependencies
are found through an `@rpath` equivalent. Testing with arm64 Python:

```text
dlopen(ChatGPT.framework/Versions/A/ChatGPT)
=> fails on @rpath/Lottie.framework/Versions/A/Lottie
```

Preloading these dependencies by absolute path succeeds:

```text
Lottie.framework/Versions/A/Lottie
LiveKitWebRTC.framework/Versions/A/LiveKitWebRTC
libwebrtc-audio-processing-2.1.dylib
Sparkle.framework/Versions/B/Sparkle
Assets.framework/Versions/A/Assets
libswiftCompatibilitySpan.dylib
ChatGPT.framework/Versions/A/ChatGPT
```

A real headless app bundle should instead copy the same `Contents/Frameworks`
layout and set an rpath such as:

```text
@executable_path/../Frameworks
```

The existing framework has rpaths for both app and nested helper layouts:

```text
@executable_path/../Frameworks
@executable_path/../../../../Frameworks
```

## Exported Swift Surface

`nm -gU` is misleading because it only showed `___cxa_throw`. The useful Swift
symbols are in the exports trie. Use:

```bash
xcrun llvm-objdump --macho --exports-trie \
  /Applications/ChatGPT.app/Contents/Frameworks/ChatGPT.framework/Versions/A/ChatGPT \
  | xcrun swift-demangle
```

Important exported areas:

- `ChatGPT.IntentService`
- `ChatGPT.SendableMessage`
- `APIClient.API`
- `APIClient.BaseAPI`
- `APIClient.Constants`
- `Auth.Auth`
- `Auth.Auth0Auth`
- `Auth.AuthCredentials`
- `Auth.Token`
- `Auth.KeychainValueStore`
- `Auth.DefaultAuthTokenEndpointClient`
- `Auth.DefaultIDTokenExchangeService`
- `Users.KeychainCurrentUserStore`
- `Conversations.DefaultConversationCoordinatorProvider`
- `Conversations.DefaultConversationCoordinator`
- `Conversations.DefaultMessageSendCoordinator`
- `Conversations.ConversationMessaging`
- `Conversations.DefaultConversationService`
- `ChatGPTXPC.XPCServer`
- `ChatGPTXPC.XPCConnection`

Most relevant prompt symbols:

```text
ChatGPT.IntentService.activeAccountIntentService() throws -> ChatGPT.IntentService
ChatGPT.IntentService.shouldAskForNewChat() async -> Swift.Bool
ChatGPT.IntentService.setUpNewChat() async throws -> ()
ChatGPT.IntentService.submit(prompt: Swift.String, retryCount: Swift.Int) async throws -> ChatGPT.SendableMessage
ChatGPT.SendableMessage.text.getter : Swift.String
ChatGPT.SendableMessage.messageId.getter : Swift.String
ChatGPT.SendableMessage.conversationId.getter : Swift.String
```

This is much simpler than constructing the lower-level conversation stack.
The lower-level route would require building an account-scoped dependency graph
around `Auth.Auth`, `APIClient.API`, `ConversationCoordinatorProvider`,
`DefaultConversationCoordinator`, model repositories, draft managers, file
upload services, and feature flag providers.

## Main Binary Bootstrap

The main executable is small and mostly delegates into `ChatGPT.framework`.
It links the same framework and calls:

```text
ChatGPT.ChatGPTApplication.createAppDelegate()
ChatGPT.ChatGPTApplication.useShortcutsProvider(...)
AppKit.NSApplicationMain(...)
```

It also contains App Intent code and strings:

```text
ChatGPTShortcuts
AskIntent
OpenNewChatInAppWidgetIntent
OpenNewChatInAppShortcutIntent
OpenVoiceModeIntent
Message to send to ChatGPT
What would you like to ask ChatGPT about?
Whether to enable back-and-forth chat or complete the Shortcut immediately after response
```

The main executable's undefined symbols confirm `AskIntent` calls the
`IntentService` API listed above. That is strong evidence that `IntentService`
is intended to work in an App Intents/background execution path without the
normal SwiftUI conversation window.

A minimal custom `main.swift` should not call `NSApplicationMain` or instantiate
`ChatGPTApplication`. It would run a plain Foundation run loop or async main,
open stdin/socket/HTTP, and dispatch prompts to `IntentService`.

The hard part is not event-loop design. The hard parts are:

- no importable Swift module interface;
- private Swift async ABI calls;
- private result type layout for `SendableMessage`;
- account/auth initialization;
- keychain entitlement access.

## Auth and Keychain

Relevant exported auth symbols:

```text
Auth.Auth.currentCredentials() async throws -> Auth.AuthCredentials
Auth.Auth.forceRenewCredentials(trigger:expectedAccessToken:) async throws -> Auth.Token
Auth.Auth0Auth.currentCredentials() async throws -> Auth.AuthCredentials
Auth.Auth0Auth.forceRenewCredentials(trigger:expectedAccessToken:) async throws -> Auth.Token
Auth.AuthCredentials(accessToken:tokenType:idToken:refreshToken:expiration:...)
Auth.Token.authorizationHeader.getter
Auth.KeychainValueStore.retrieve() throws -> A?
Auth.KeychainValueStore.updateOrDelete(A?) throws
Users.KeychainCurrentUserStore
```

Relevant strings:

```text
UserAccessTokenKey
accessToken
tokenType
idToken
refreshToken
No refresh token found.
performCredentialRenewal(expectedAccessToken:)
refreshCredentials(refreshToken:clientID:url:scope:additionalHeaders:)
token_exchange
AuthTokenEndpointClient
DefaultIDTokenExchangeService
2DC432GLL2.com.openai.shared
2DC432GLL2.group.com.openai.chat
```

The app entitlement dump confirms:

```text
com.apple.application-identifier = 2DC432GLL2.com.openai.chat
com.apple.security.application-groups = 2DC432GLL2.group.com.openai.chat
keychain-access-groups = 2DC432GLL2.com.openai.shared
```

This means a third-party headless app can use the same filesystem paths and
bundle resources, but not the same keychain credentials. Reusing the existing
login session requires running code in a process signed by OpenAI with the same
keychain access group.

Local non-keychain state exists under:

```text
~/Library/Application Support/com.openai.chat
~/Library/Preferences/com.openai.chat.plist
~/Library/HTTPStorages/com.openai.chat
~/Library/Caches/com.openai.chat
```

These include cached conversations/models/helper state, but they are not a
substitute for refresh credentials.

## ChatGPTHelper and XPC

LaunchAgent:

```text
Label = com.openai.chat-helper
BundleProgram = Contents/Resources/ChatGPTHelper
MachServices = com.openai.chat-helper
KeepAlive = true
RunAtLoad = true
LSUIElement = true
```

`launchctl print gui/$(id -u)/com.openai.chat-helper` showed it running with
endpoint `com.openai.chat-helper`.

Helper-linked protocols/classes:

```text
ChatGPTXPC.ChatGPTXPCAgent.updatedAppState(ChatGPTXPCAppState)
ChatGPTXPC.ChatGPTXPCApp.handle(action: StatusBarAction)
ChatGPTXPC.XPCConnection
ChatGPTXPC.XPCServer
ChatGPTXPC.StatusBarCoordinator
ChatGPTXPC.ChatGPTXPCAppState
```

Observed action strings:

```text
openChat
toggleLauncher
keyboardShortcutToggleLauncher
keyboardShortcutTogglePairedLauncher
openSettings
checkForUpdates
applyAppUpdateNow
updatedDesktopMenuBarBehavior
quit
```

Assessment: the helper is useful for the menu bar, launcher, app activation,
settings/update/quit actions, and app state mirroring. I found no symbols or
strings indicating prompt submission, response streaming, token retrieval, or
conversation APIs. Talking to the helper is not the path for headless chat.

## Candidate Build Paths

### Path A: Wrapper over the existing signed App Intent

This is the simplest path that preserves auth.

Use the existing `AskIntent` exposed by `com.openai.chat` and wrap it with a
CLI/local HTTP process. The wrapper can provide stdin/stdout, Unix socket, or
HTTP, but actual prompt execution stays in the original signed app/intents
process.

Pros:

- Reuses current login session.
- Uses the app's own `IntentService`.
- Avoids private Swift ABI calls from our code.
- Avoids windows in normal App Intent execution.
- Does not talk to `ChatGPTHelper`.

Cons:

- Depends on App Intents/Shortcuts plumbing.
- May have Shortcut permission/UX prompts.
- Less control over streaming and structured events.
- Still launches/loads the original app/framework code.

This is the path I would try first.

### Path B: Private-symbol host around `IntentService`

Bundle shape:

```text
HeadlessChatGPT.app/
  Contents/Info.plist
  Contents/MacOS/headless-chatgpt
  Contents/Frameworks/ChatGPT.framework
  Contents/Frameworks/Assets.framework
  Contents/Frameworks/Lottie.framework
  Contents/Frameworks/LiveKitWebRTC.framework
  Contents/Frameworks/Sparkle.framework
  Contents/Frameworks/libwebrtc-audio-processing-2.1.dylib
  Contents/Frameworks/libswiftCompatibilitySpan.dylib
```

The executable should be arm64, have `@rpath @executable_path/../Frameworks`,
and avoid `NSApplicationMain`. It can expose JSON over stdin/stdout, a Unix
socket, or local HTTP.

The intended call flow:

```text
load embedded frameworks
obtain active service:
  IntentService.activeAccountIntentService()
optionally:
  shouldAskForNewChat()
  setUpNewChat()
for each prompt:
  submit(prompt:retryCount:)
return:
  SendableMessage.text
  SendableMessage.messageId
  SendableMessage.conversationId
```

Open problems:

- The app ships no Swift module interface, so direct Swift imports are not
  available.
- Calls would need `_silgen_name` or lower-level `dlsym` against mangled Swift
  symbols, including async/throws calling conventions.
- `SendableMessage` is a private Swift value type. Its getters are exported,
  but the return ABI/layout still needs careful validation.
- Auth will fail unless this process has OpenAI's keychain entitlement or an
  alternate credential path.

This is technically interesting, but not the simplest production path unless
signing/auth is solved.

### Path C: Lower-level APIClient/Conversation stack

This means constructing `Auth.Auth`, `APIClient.API`,
`DefaultConversationCoordinatorProvider`, `DefaultConversationCoordinator`, and
using `ConversationMessaging.submit(...)`.

This is worse than Path B. It requires many private dependencies and feature
services. `IntentService` already wraps the relevant path for App Intents.

### Path D: Talk to ChatGPTHelper

Not viable for prompt/response. The helper XPC surface appears status-bar
oriented.

## Recommended Next Experiment

Do not start by building a new signed app bundle. Start by proving the existing
signed non-UI prompt path:

1. Create or inspect a macOS Shortcut that invokes ChatGPT's `AskIntent`.
2. Run it from `shortcuts run ...` with input.
3. Verify whether it returns `SendableMessage.text` without showing a window.
4. Wrap that in the repo's daemon/local HTTP interface if it behaves.

If App Intents are too constrained, the next experiment is a tiny arm64
Foundation executable that links the copied framework set and calls
`IntentService` private Swift symbols. That experiment should first prove only:

```text
activeAccountIntentService()
current auth state / logged-in detection
submit("ping", retryCount: 0)
SendableMessage.text getter
```

Expect auth failure in an unsigned/re-signed process unless it runs with
OpenAI's entitlements.

## Bottom Line

The networking/auth/conversation code is reusable in principle, and the exact
high-level submission API is present. The limiting factor is not finding the
API; it is running it in a process that can access the existing OpenAI keychain
session. A true stripped standalone app bundle cannot preserve that session
under a third-party signature. The simplest working headless route is therefore
to delegate prompt execution to the original signed app's App Intent path, or
keep using the original signed app as the auth-bearing process.
