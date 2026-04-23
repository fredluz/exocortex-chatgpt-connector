# ChatGPT macOS Private API Reverse Engineering

Date: 2026-04-23

Scope: local inspection of `/Applications/ChatGPT.app` version `1.2026.104`
(`CFBundleVersion` `1776709323`, commit hash `13b4c04c63`) plus a public
GitHub/web survey. Secret material was deliberately not written here. Any live
token/cookie checks below report only status, key names, counts, and lengths.

## Executive Summary

The macOS app contains enough endpoint and model/request type information to
map the rough private API surface, but I did not find a reusable plaintext
ChatGPT access token or refresh token.

The app is a native Swift app, not a thin browser wrapper. Its real logic is in
`ChatGPT.framework`, a 93 MB monolithic Swift framework that contains modules
named `APIClient`, `Auth`, `ChatGPTLogin`, `Conversations`, `ConversationsCore`,
`Account`, `FileUploadService`, `ChatGPTVoice`, and many more. The top-level
`ChatGPT` executable is only about 207 KB and mostly delegates into that
framework.

Authentication is native Auth0/OpenAI OAuth, not the old web
`__Secure-next-auth.session-token` flow. The app has keychain access group
`2DC432GLL2.com.openai.shared`; the data-protection keychain contains encrypted
items for that access group, but our CLI process cannot read them because it is
not OpenAI-signed with that access group. The app's cookie store has device and
Cloudflare cookies, but no web session token and no `accessToken` from
`/api/auth/session`.

The installed `ChatGPTHelper` is an XPC/status-bar helper. It can activate or
restart the app and exchange app state such as logged-in status, shortcuts, and
menu-bar behavior. I found no evidence that it exposes conversation submission,
model calls, token retrieval, or a general private API bridge.

The best headless option is not "talk to the helper"; it would be either:

1. Reimplement the private HTTP API and auth/attestation stack, which is
   brittle and currently blocked by inaccessible refresh credentials.
2. Instrument the real app to observe requests, which is feasible as research
   with invasive tooling but not a clean production client.
3. Continue with native app UI/accessibility automation, which is less elegant
   but reuses the supported logged-in app state without crossing the auth
   boundary.

## App Bundle Inventory

Important bundle metadata:

- Bundle ID: `com.openai.chat`
- Version: `1.2026.104`
- Build: `1776709323`
- Commit hash: `13b4c04c63`
- URL schemes: `com.openai.chat`, `openai`, `chatgpt`
- Associated domains include `chatgpt.com`, `chat.openai.com`,
  `platform.openai.com`, `chat.com`, and web credentials for `openai.com` and
  `api.openai.org`
- Keychain access group: `2DC432GLL2.com.openai.shared`
- App group: `2DC432GLL2.group.com.openai.chat`

Top-level bundle files:

- `/Applications/ChatGPT.app/Contents/MacOS/ChatGPT`
- `/Applications/ChatGPT.app/Contents/Resources/ChatGPTHelper`
- `/Applications/ChatGPT.app/Contents/Library/LaunchAgents/com.openai.chat-helper.plist`
- `/Applications/ChatGPT.app/Contents/Frameworks/ChatGPT.framework`
- `/Applications/ChatGPT.app/Contents/Frameworks/Assets.framework`
- `/Applications/ChatGPT.app/Contents/Frameworks/LiveKitWebRTC.framework`
- `/Applications/ChatGPT.app/Contents/Frameworks/Lottie.framework`
- `/Applications/ChatGPT.app/Contents/Frameworks/Sparkle.framework`
- `/Applications/ChatGPT.app/Contents/Frameworks/libwebrtc-audio-processing-2.1.dylib`
- `/Applications/ChatGPT.app/Contents/Frameworks/libswiftCompatibilitySpan.dylib`

Framework sizes:

| Component | Size | Notes |
| --- | ---: | --- |
| `ChatGPT.framework` | 93 MB | Main app/auth/API/conversation logic |
| `Assets.framework` | 16 MB | Assets and resource bundles |
| `LiveKitWebRTC.framework` | 12 MB | Voice/realtime stack |
| `libwebrtc-audio-processing-2.1.dylib` | 2.6 MB | Audio processing |
| `Sparkle.framework` | 2.2 MB | Auto-update, includes Sparkle XPC services |
| `Lottie.framework` | 2.2 MB | Animation |
| `libswiftCompatibilitySpan.dylib` | 56 KB | Swift compatibility |

`ChatGPT.framework` has no `.swiftmodule`, `.swiftinterface`, public headers, or
module map in the shipped bundle. It can be loaded by path, but not cleanly
imported as a Swift module.

I tested a minimal `dlopen()`:

```text
clang -arch arm64 ... /tmp/dlopen_chatgpt_arm64
DYLD_FRAMEWORK_PATH=/Applications/ChatGPT.app/Contents/Frameworks \
DYLD_LIBRARY_PATH=/Applications/ChatGPT.app/Contents/Frameworks \
  /tmp/dlopen_chatgpt_arm64

=> dlopen ok
```

Without both framework and library search paths, `dlopen` fails on
`@rpath/libwebrtc-audio-processing-2.1.dylib`. This proves standalone loading is
possible at the Mach-O level, but not that the useful services are callable.
Calling the auth/API stack would require reverse engineering private Swift
symbols and initializing the same dependency container the app uses.

## Code Signing and Injection Constraints

The app, helper, and framework are Developer ID signed by OpenAI:

- Authority: `Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)`
- Hardened runtime flag: `runtime`
- No `get-task-allow`
- No `com.apple.security.cs.allow-dyld-environment-variables`
- No `com.apple.security.cs.disable-library-validation`
- No debug/injection entitlements

Implications:

- `DYLD_INSERT_LIBRARIES` against the signed app is expected to be blocked or
  ignored under the hardened runtime.
- Loading arbitrary non-OpenAI libraries into the signed process is constrained
  by library validation.
- Attaching a debugger or injecting into the running process is likely blocked
  without elevated privileges, special entitlements, or disabling macOS security
  features.
- Re-signing a copied app to allow injection would break the OpenAI team ID and
  keychain access group. That is useful for research but likely destroys the
  authenticated state we want to reuse.

The framework also includes certificate pinning code:

- `CertificatePinningSessionTaskDelegate`
- `CertificatePinningURLProtocol`
- `UniversalPinningConfiguration`
- `com.openai.pinned_cert_hash_list`
- Failure strings such as `No certificate in the chain matched one of the expected public keys`

That makes transparent HTTPS interception less reliable than a normal proxy
setup, depending on which sessions use the pinning delegate.

## ChatGPTHelper and XPC

LaunchAgent:

```text
Label: com.openai.chat-helper
Program: Contents/Resources/ChatGPTHelper
MachServices: com.openai.chat-helper
KeepAlive: true
RunAtLoad: true
LSUIElement: true
```

`launchctl print gui/501/com.openai.chat-helper` showed a running service with
the endpoint `com.openai.chat-helper`.

Relevant helper/framework strings and demangled symbol names:

- `ChatGPTXPC`
- `ChatGPTXPCAgent`
- `ChatGPTXPCApp`
- `ChatGPTXPCAppState`
- `XPCServer`
- `XPCConnection`
- `StatusBarCoordinator`
- `StatusBarAction`
- `StatusBarClient`
- `updatedAppState:completionHandler:`
- `statusBarButtonClicked:`
- `toggleLauncher`
- `keyboardShortcutToggleLauncher`
- `keyboardShortcutTogglePairedLauncher`
- `desktopMenuBarBehavior`
- `Failed to send app state to ChatGPTHelper agent`
- `Failed to get ChatGPTHelper build date`
- `Failed to restart ChatGPTHelper agent`

The helper cache at
`~/Library/Application Support/com.openai.chat/ChatGPTHelper/helper_cache.data`
is a binary plist containing:

```text
desktopMenuBarBehavior: appRunning
loggedIn: true
toggleLauncherShortcut: carbonKeyCode 49, carbonModifiers 2048
togglePairedLauncherShortcut: carbonKeyCode 18, carbonModifiers 2560
updateAvailable: false
```

`lsof` for `ChatGPTHelper` showed no established network sockets. It had the app
frameworks mapped and the ChatGPT HTTP storage SQLite files open, but no active
ChatGPT API connection.

Assessment: the helper is a status-bar/launcher companion, not a headless
conversation service. A client could probably speak NSXPC to it after
reconstructing the protocols, but the exposed behavior appears limited to
activation, restart/build-date, app state, and status-bar actions.

## Native Headless App Possibility

There is a string/key `HIDE_MAIN_WINDOW_ON_LAUNCH`, and the app has extensive
launcher/background code. That suggests the real app can be launched with its
main window hidden, but this is still the real GUI app. It is not a CLI or
network daemon mode.

A minimal custom app that links or `dlopen`s `ChatGPT.framework` is technically
possible, but it hits several walls:

- No shipped Swift module interfaces or headers.
- Auth and API classes are private Swift symbols.
- The dependency graph includes AppKit, SwiftUI, WebKit, StoreKit, DeviceCheck,
  LocalAuthentication, Security, and many feature modules.
- The useful auth tokens are in OpenAI's keychain access group.
- A third-party app cannot legitimately claim `2DC432GLL2.com.openai.shared`.
- Reusing the same bundle identifier may reuse preference/cookie paths, but it
  does not grant the OpenAI keychain access group.
- Some request paths involve app/device attestation (`/ios/attestation_challenge`
  and `/ios/verify_attestation`) and sentinel/proof headers.

Conclusion: a "minimal headless app bundle" is a plausible reverse-engineering
project, but it is not a practical shortcut. It would still need OpenAI-signed
entitlements or a separate login/token flow.

## Auth Findings

### Entitlements

Main app entitlements include:

- `keychain-access-groups`: `2DC432GLL2.com.openai.shared`
- `com.apple.security.application-groups`: `2DC432GLL2.group.com.openai.chat`
- Associated domains for `chatgpt.com`, `chat.openai.com`, `platform.openai.com`,
  `chat.com`, and `openai.com`

`ChatGPTHelper` has only:

- `com.apple.application-identifier`: `2DC432GLL2.com.openai.chat-helper`

It does not advertise the same keychain access group in its entitlements.

### Auth0/OAuth strings in the framework

The framework contains:

- `https://auth.openai.com/oauth/token`
- `https://auth.openai.com/api/accounts/authorize`
- `https://auth.openai.com/api/first_party_authorize/next`
- `https://api.openai.com/auth`
- `https://api.openai.com/mfa`
- `Auth0Auth`
- `Auth0WebAuth`
- `DefaultAuthTokenEndpointClient`
- `AuthTokenEndpointCredentialsResponse`
- `RefreshTokenRequest`
- `RevokeTokenRequest`
- `IDTokenExchangeService`
- `WorkspaceTokenExchangeService`
- `urn:ietf:params:oauth:grant-type:token-exchange`
- `authorization_code`
- `refresh_token`
- `id_token`
- `access_token`
- `token_revoked`
- `refresh_token_expired`
- `refresh_token_invalidated`
- `refresh_token_reused`

This is a native OAuth/Auth0 implementation, not a NextAuth browser session.

### UserDefaults

`defaults read com.openai.chat` showed non-secret account/app state:

- Active user/workspace IDs.
- App build/version keys.
- Last selected conversation local ID.
- Last account settings JSON.
- Last notification settings JSON.
- Last-used model config, including:
  - `gpt-5-4-pro`
  - `gpt-5-4-thinking`
  - `gpt-5-3`
  - `gpt-5-2-pro`
  - `gpt-5-2-thinking`
  - `gpt-5-1-thinking`
  - `gpt-5-thinking`

No plaintext access token or refresh token was found in UserDefaults.

### App data directory

`~/Library/Application Support/com.openai.chat` contains encrypted/binary local
caches:

- `conversations-v3-<workspace-id>/*.data`
- `models-<workspace-id>/response.data`
- `system-hints-<workspace-id>/response.data`
- `gizmos-<workspace-id>/bootstrap.data`
- `gizmos-<workspace-id>/projects.data`
- `ChatGPTHelper/helper_cache.data`

The conversation/model cache files look encrypted or otherwise binary-encoded.
Plain `strings`, `plutil`, and simple token greps did not reveal bearer,
refresh, or session tokens.

### Keychain

Simple searches returned no named generic or internet password entries:

- `security find-generic-password -s com.auth0.credentialsmanager.serial`
- `security find-generic-password -s com.openai.chat`
- `security find-generic-password -s Auth0`
- `security find-internet-password -s chatgpt.com`

However, the data-protection keychain
`~/Library/Keychains/<UUID>/keychain-2.db` does contain rows with access group:

```text
2DC432GLL2.com.openai.shared
```

The `genp` service/account/label fields for those rows are encrypted binary
from our process. This is consistent with OpenAI storing auth credentials in
the access group, but not readable by a third-party CLI.

### Cookies and HTTP storage

`~/Library/HTTPStorages/com.openai.chat.binarycookies` contains these cookie
names only:

- `GCLB`
- `__cf_bm`
- `__cflb`
- `oai-sc`
- `oai-did`
- `_devicecheck`
- `_puid`
- `unified_session_manifest`

No `__Secure-next-auth.session-token`, no bearer token, and no refresh token
were present in the cookie store.

Controlled probes with cookie values kept private:

| Probe | Result |
| --- | --- |
| `GET https://chatgpt.com/api/auth/session` with app cookies | `200`, JSON keys only `WARNING_BANNER`, `accessToken_len = 0` |
| `GET https://chat.openai.com/api/auth/session` with app cookies | `200`, JSON keys only `WARNING_BANNER`, `accessToken_len = 0` |
| `GET https://chatgpt.com/backend-api/conversations?offset=0&limit=1&order=updated` with app-like `ChatGPT/... CFNetwork` UA and app cookies | `200`, `items_len = 0`, `total = 0` |
| Same conversations endpoint with generic browser UA | `403` Cloudflare HTML |
| `GET https://chatgpt.com/backend-api/models` with app-like UA and app cookies | `200`, generic model list |

The `/backend-api/models` response shape:

```text
keys: categories, default_model_slug, icons, internal_groups,
      model_picker_version, models, secondary_title, title, versions
default_model_slug: auto
models_len: 7
categories_len: 4
versions_len: 3
```

Model slugs returned by that unauth/generic probe:

- `gpt-5-3`
- `gpt-5-2`
- `gpt-5-1`
- `gpt-5`
- `gpt-5-mini`
- `gpt-5-3-mini`
- `auto`

This did not prove access to Fred's Pro/Plus session. The empty conversation
list and missing `/api/auth/session` access token indicate the app cookies alone
are insufficient for a real authenticated headless client.

## API Domains Found

Important domains/URLs in the app:

- `https://chatgpt.com`
- `https://chat.com`
- `https://chat.openai.com`
- `https://ios.chat.openai.com`
- `https://api.openai.com`
- `https://api.openai.com/v1`
- `https://api.openai.com/auth`
- `https://api.openai.com/mfa`
- `https://api.openai.com/profile`
- `https://auth.openai.com`
- `https://auth.openai.com/oauth/token`
- `https://auth.openai.com/api/accounts/authorize`
- `https://auth.openai.com/api/first_party_authorize/next`
- `https://realtime.chatgpt.com`
- `https://ab.chatgpt.com`
- `https://featureassets.org/v1/initialize`
- `https://prodregistryv2.org/v1/rgstr`
- `https://cdn.platform.openai.com/deployments/widgets/index.html`
- `https://skybridge.oaistatic.com`
- `https://sora.chatgpt.com`
- `https://register.appattest.apple.com`

## Endpoint Inventory from `ChatGPT.framework`

I found these API path fragments in the native framework. Some are full paths,
some are mounted below a base such as `/backend-api`.

### Account/auth/settings

- `/accounts/add_email/begin`
- `/accounts/add_email/verify`
- `/accounts/check/v4-2023-04-27`
- `/accounts/data_export`
- `/accounts/data_usage_for_training`
- `/accounts/deactivate`
- `/accounts/logout_all`
- `/accounts/mfa/enroll`
- `/accounts/mfa/user/activate_enrollment`
- `/accounts/mfa/user/disable_in_house`
- `/accounts/mfa/user/passkey/enrollment/finish`
- `/accounts/mfa/user/passkey/enrollment/start`
- `/accounts/mfa/user/sms/resend_otp_for_enrollment`
- `/accounts/mfa_info`
- `/accounts/personal`
- `/accounts/sessions`
- `/accounts/sessions/revoke`
- `/accounts/v1/phone_registry/enroll/finish`
- `/accounts/v1/phone_registry/enroll/start`
- `/action_settings`
- `/clear_settings_cache`
- `/features`
- `/security-settings`
- `/settings_layout`
- `/user_action_settings`
- `/user_system_message_trait_pills`

### Conversation/chat

- `/backend-api`
- `/backend-api/sentinel/heartbeat`
- `/conversation/init`
- `/conversation/new_branch`
- `/conversation/video_gen`
- `/conversations/batch`
- `/experimental/generate_autocompletions`
- `/experimental/generate_autocompletions_anon`
- `/experimental/generate_trending_suggestions`
- `/message_feedback`
- `/sidebar/conversation`
- `/stop_conversation`
- `/unified_user_signals`
- `/user_feedback/submit_feedback`

### Sentinel, attestation, app status

- `/sentinel/heartbeat`
- `/ios/attestation_challenge`
- `/ios/verify_attestation`
- `/preauth_devicecheck`
- `/public-api`
- `/public-api/mobile/app_support_status/v1`
- `/public-api/mobile/server_status/v1`
- `/mobile/app_support_status/v1`
- `/mobile/server_status/v1`

### Files, interpreter, messages

- `/estuary/upload_content_and_finalize`
- `/estuary/upload_content_bytes`
- `/files/library/nodes`
- `/interpreter/download`
- `/message/code-blocks`
- `/message/code-blocks/magic-edit`
- `/message/writing-blocks`
- `/message/writing-blocks/feedback`
- `/message/writing-blocks/magic-edit`

### Images/video/media

- `/image-gen/image-paragen-dismiss`
- `/image-gen/image-paragen-display`
- `/image-gen/image-paragen-submit`
- `/images/bootstrap`
- `/my/recent/image_gen`
- `/my/recent/uploaded_images`
- `/paragen_submission`

### Voice/meeting/Hive

- `/hive`
- `/hive/calendar/next_events`
- `/hive/diarize`
- `/session_status`
- `/transcript/async`
- `/transcript/stream`

### Connectors, OAuth, commerce, other

- `/connectors/directory`
- `/moodeng/account_linking`
- `/moodeng/account_linking/pre_check`
- `/load-page-with-auth`
- `/mail/deeplink/compose`
- `/payments/checkout_session`
- `/payments/customer_portal`
- `/payments/rc/ios/verify/v4-2023-04-27`
- `/search/product_carousel_descriptions`
- `/search/product_info_variants`
- `/search/product_update`
- `/share/post/link`
- `/shopping`
- `/trusted-contact/`
- `/public/countries`
- `/invites/request`
- `/announcements/personality_onboarding`
- `/automations/remove`
- `/bazaar/feedback-form`
- `/cfc-verification`
- `/hmp-verification`
- `/intermediate-v2`
- `/jawbones/set_status`
- `/mobile/age-verification`
- `/mobile/age-verification/result`
- `/notifications/activity/update_token`
- `/notifications/settings`
- `/notifications/subscription/deregister`
- `/notifications/subscription/deregister/token`
- `/notifications/subscription/register`
- `/onboarding/create_account`
- `/onboarding/interests`
- `/onboarding/interests/profile`
- `/onboarding/login`
- `/onboarding/phone/check`
- `/onboarding/phone/verify`
- `/onboarding/steps`
- `/onboarding/verify_email`
- `/personality_trait_types`

## Conversation API Shape

The native app does not embed a simple old
`/backend-api/conversation` string in the way the web app did. Instead it has
typed native endpoints and request models:

- `ConversationStreamRequest`
- `ConversationStreamRequestAction`
- `ResumeStreamingConversationRequest`
- `ConversationStreamData`
- `ResumeConversationToken`
- `ConversationStreamStatusResponse`
- `ConversationSidebarRequest`
- `InitializeConversationRequest`
- `BranchConversationRequest`
- `StopConversationRequest`
- `ConversationBatchRequest`
- `UpdateConversationTitleRequest`
- `UpdateConversationVisibilityRequest`
- `UpdateConversationArchivedRequest`
- `UpdateConversationPinningRequest`
- `UpdateConversationDoNotRememberRequest`
- `ModelsRetrievalAPI`
- `ModelsResponse`
- `SanitizedModelsResponse`

Nearby strings indicate these operations:

- `initializeConversation(conversationID:conversationOwnerID:gizmoID:)`
  using `/conversation/init`
- `streamingConversation(request:additionalHeaders:enableSharedSessionRequests:taskDelegate:timeoutInterval:isMangoChat:)`
- `resumableStreamingConversation(with:createRequest:enableSharedSessionRequests:dontRetryOnNoInternetConnection:taskDelegate:timeoutInterval:isMangoChat:)`
- `branchConversation(conversationID:messageID:)` using `/conversation/new_branch`
- `conversationList(using:)` using `/conversations/batch`
- `stopConversation(id:requestTrackingData:)` using `/stop_conversation`
- `streamingSidebar(request:)` using `/sidebar/conversation`
- `attestationChallenge(...)` using `/ios/attestation_challenge`
- `verifyAttestation(...)` using `/ios/verify_attestation`

Request/response fields visible in strings and type names include:

- `action`
- `messages`
- `conversation_id`
- `conversationId`
- `conversationID`
- `parent_message_id`
- `message_id`
- `model_slug`
- `modelSlug`
- `defaultModelSlug`
- `conversationMode`
- `historyAndTrainingDisabled`
- `timezone`
- `timezone_offset_min`
- `requestTrackingData`
- `turn_session_id`
- `turn_trace_id`
- `turn_exchange_id`
- `conversationSessionID`
- `resumeConversationToken`
- `resumeSSEEndpoint`
- `lastConduitToken`
- `attestedToken`
- `assertionAttemptCount`
- `assertionFailure`
- `assertionSuccess`

Streaming/parser strings:

- `CHATGPT_MESSAGE_TRANSPORT_SSE_STREAM`
- `CHATGPT_MESSAGE_TRANSPORT_CONVERSATION_FETCH`
- `EventSourceMessage`
- `messages(resumingFrom:decoder:)`
- `missing_done_message`
- `ios.sse.done_required`
- `Error decoding JSONPatch delta during streaming`
- `Error applying JSONPatch diff`
- `lastJSONMessageByChannel`
- `message_stream_complete`
- `conversation_resuming.start`
- `conversation_resuming.recover_with_fetch`

Inference: the modern native app uses a more complex flow than the early web
`POST /backend-api/conversation` body. It still uses SSE-like streaming, but it
also supports resumable streams, JSON Patch deltas, app/device attestation,
conduit tokens, and separate init/batch/branch endpoints.

## Public Reverse Engineering References

Existing public work confirms the historical API shape and the trend toward
additional anti-abuse/auth layers:

- `abacaj/unofficial-chatgpt-api`:
  <https://github.com/abacaj/unofficial-chatgpt-api>
  - Old Node client.
  - README says ChatGPT has anti-bot measures and browser-managed sessions may
    be required.
  - Uses old `__Secure-next-auth.session-token` cookies and Cloudflare clearance
    token.

- `kurtseifried/ChatGPT-API` / `revChatGPT`:
  <https://github.com/kurtseifried/ChatGPT-API>
  - Reverse-engineered ChatGPT API client lineage.
  - Documents a session-token/access-token style and proxy approaches.
  - Warns about Cloudflare bypass/proxy rate limits.

- `Gavincent1/chatgpt-api`:
  <https://github.com/Gavincent1/chatgpt-api>
  - Distinguishes official OpenAI API from `ChatGPTUnofficialProxyAPI`.
  - Notes the unofficial path uses ChatGPT's backend API via reverse proxy and
    requires an OpenAI access token.
  - Documents old manual token retrieval from `/api/auth/session`.

- `terminalcommandnewsletter/everything-chatgpt`:
  <https://github.com/terminalcommandnewsletter/everything-chatgpt>
  - Documents older web endpoints:
    - `GET /backend-api/conversations?offset=0&limit=28`
    - `GET /backend-api/conversation/<conversation ID>`
    - `POST /backend-api/conversation`
    - `PATCH /backend-api/conversation/<conversation ID>`
    - `POST /backend-api/conversation/message_feedback`
  - Shows old request body fields such as `action`, `messages`, `model`, and
    `parent_message_id`.

- `sdmunozsierra/chatgpt-conversation-manager`:
  <https://github.com/sdmunozsierra/chatgpt-conversation-manager>
  - Simple scripts for `https://chatgpt.com/backend-api/conversations`.
  - Uses bearer authorization header supplied by the user.

- DeepWiki summaries of current proxy projects:
  - <https://deepwiki.com/realasfngl/ChatGPT/9-openai-backend-endpoints>
  - <https://deepwiki.com/lanqian528/chat2api/2.3-chatgpt-proxy-functionality>
  - These document newer sentinel/proof/conduit-token flows:
    - requirements token
    - proof-of-work token
    - turnstile token
    - conduit token
    - `x-conduit-token`
    - `openai-sentinel-chat-requirements-token`

- SSE overview:
  <https://ahmed-n-abdeltwab.github.io/blog/2025/08/25/chatgpt-sse-architecture.html>
  - Describes ChatGPT's streamed responses as fetch-plus-readable-stream rather
    than browser `EventSource`.

The public references mostly cover the web app or proxy ecosystem. They do not
solve the macOS native app's keychain/Auth0/App Attest problem.

## Feasibility Assessment

### Direct private HTTP CLI

Technically possible only if we can obtain and refresh the native ChatGPT access
token and reproduce required headers. Current blockers:

- No plaintext access token found.
- No plaintext refresh token found.
- Web `/api/auth/session` does not return an access token for the native app
  cookies.
- Auth credentials appear to be in OpenAI's keychain access group.
- Conversation submission likely requires app attestation and sentinel/conduit
  tokens, not just `Authorization: Bearer`.
- Certificate pinning may block simple proxy introspection.

Risk: high. This path will be brittle across app releases and may trigger
Cloudflare/OpenAI anti-abuse systems.

### Reuse app framework headlessly

Technically interesting but not a shortcut:

- `ChatGPT.framework` can be loaded standalone with correct `DYLD_*` paths.
- There are no public Swift interfaces.
- Auth/networking are private Swift internals inside a monolithic framework.
- Keychain access still requires OpenAI signing.
- A re-signed host app loses the OpenAI keychain access group.
- A copied app with altered entitlements breaks the very auth state we need.

Risk: very high for production. Useful only for reverse-engineering experiments.

### Talk to ChatGPTHelper

Not sufficient for chat:

- XPC exists and is likely approachable.
- Exposed behavior appears limited to app state/status bar/launcher/restart.
- No token, model, conversation, or network methods found.
- Helper has no established network sockets in the observed run.

Risk: low to investigate, low payoff for headless chat.

### Dylib injection or runtime hooks

Useful for research, poor as a deployed client:

- Hardened runtime and missing dyld/library-validation entitlements block clean
  `DYLD_INSERT_LIBRARIES`.
- Attaching/injecting into the signed app is gated by macOS security.
- Re-signing/copying the app for injection likely loses keychain access.
- A fishhook/Frida-style hook could capture `URLSession` request metadata if
  security is relaxed, but this is operationally fragile and exposes secrets if
  mishandled.

### Native app UI/accessibility automation

Still the most practical replacement for Chrome automation:

- Reuses the actual logged-in app and its private auth/session machinery.
- Avoids reimplementing unstable private endpoints.
- Avoids handling bearer/refresh tokens directly.
- Uses much less memory than Chrome/Playwright.
- Downsides are UI brittleness, single-user desktop session requirement, and
  slower interaction compared with raw HTTP.

## Recommended Next Steps

1. Prefer the native app accessibility approach for a working connector.
2. Keep private HTTP reverse engineering as a side research track, not the main
   implementation path.
3. If more API mapping is needed, instrument the real app in a controlled lab
   environment:
   - copy the app,
   - accept that auth may break,
   - re-sign for debugging/injection,
   - hook `URLSession` request construction or delegate methods,
   - redact all auth headers and bodies before logging.
4. Investigate the `HIDE_MAIN_WINDOW_ON_LAUNCH` key/argument only as a way to
   run the official app less visibly, not as a real headless mode.
5. Do not build a CLI around extracted tokens unless the auth refresh and
   sentinel/attestation path is fully understood and can be kept stable.

