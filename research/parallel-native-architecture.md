# Parallel Native Architecture For ChatGPT macOS

Date: 2026-04-23

Reference repo: `/Users/fredluz/Code/chatgpt-cli` (`github.com/toby1991/chatgpt-cli`)

Target: replace the Chrome/Patchright backend with a native ChatGPT macOS controller using AXUIElement and a CLI-first daemon. MCP can be an adapter later; it should not be the core abstraction.

## Executive Summary

The serial UI / parallel generation architecture is viable.

The ChatGPT macOS app has one visible conversation surface, so all UI automation must be serialized. But the app also tracks background streaming conversations, and OpenAI documents background completion notifications for the macOS app. That means the daemon can submit prompt A, switch away, submit prompt B, and let both conversations generate concurrently inside ChatGPT.

Completion detection should not depend on notifications. Notifications exist, but they are best treated as wake-up hints. The reliable design is a file-backed CLI daemon with:

- one global UI queue for all AX operations
- a submit worker that releases the UI immediately after sending
- an active generation table
- a completion watcher that schedules short serial UI probes
- a read worker that switches to completed conversations and extracts text/images
- response JSON files as the source of truth

This preserves parallel model work while accepting that UI access is a scarce serial resource.

## Existing Reference Implementation

The `chatgpt-cli` repo is a synchronous single-flight driver.

Important files:

- `automation/ax.m`: Objective-C AX implementation.
- `automation/ax.go`: Go/cgo wrappers.
- `driver/chatgpt.go`: ChatGPT-specific UI flow.
- `driver/search.go`: thin dispatcher.
- `cmd/mcp.go`: stdio MCP wrapper around the dispatcher.

Current flow in `driver/chatgpt.go`:

1. `NavigateToHome()` clicks the new-chat button.
2. Optional `SetModel()` and `SetWebSearch()`.
3. `Ask()` sets the first visible `AXTextArea`.
4. It clicks the send button.
5. It waits for visible `停止生成` to appear and disappear.
6. It reads visible response text via `ReadResponseText()`.

Useful low-level patterns from `automation/ax.m`:

- Finds ChatGPT by bundle id `com.openai.chat`.
- Gets `kAXWindowsAttribute` directly to avoid recursive AX app self-reference bugs.
- Uses `AXUIElementPerformAction(..., kAXPressAction)` for buttons.
- Sets the prompt by writing `kAXValueAttribute` on an `AXTextArea`.
- Reads response text from `kAXDescriptionAttribute` on `AXStaticText`.
- Handles headless/window-server failure modes explicitly.

Limitations for our architecture:

- It only handles the currently visible conversation.
- It waits synchronously before returning.
- It has no conversation list/switch/rename primitives.
- It hardcodes Chinese UI labels (`新聊天`, `发送`, `停止生成`, `搜索`).
- It does not support background completion, image extraction, or request-to-conversation mapping.

## Local ChatGPT App Findings

Installed app:

- Bundle id: `com.openai.chat`
- Version: `1.2026.104`
- Build: `1776709323`
- URL schemes: `com.openai.chat`, `openai`, `chatgpt`
- `sdef /Applications/ChatGPT.app` fails with error `-192`, so there is no usable AppleScript scripting dictionary.

Frameworks and entitlements:

- Links `AppKit`, `SwiftUI`, `WebKit`, `ApplicationServices`, `UserNotifications`, `AppIntents`, `CoreData`.
- Has production APNS entitlement: `com.apple.developer.aps-environment = production`.
- Has app group: `2DC432GLL2.group.com.openai.chat`.
- Has `com.apple.security.automation.apple-events = true`.

Local defaults expose useful state:

- `lastSelectedConversation` contains a local conversation id and selected model slug.
- `lastNotificationSettingsResponse_...` includes a "Responses" notification category:
  `"Get notified when ChatGPT responds to requests that take time, like research or image generation."`

Local cache:

- Conversations are under:
  `~/Library/Application Support/com.openai.chat/conversations-v3-<workspace-id>/`
- Files are opaque `.data` blobs. They are not a practical response extraction API.
- File mtimes can be used as a weak activity hint, not as the source of truth.

Binary strings show first-class background generation concepts:

- `BackgroundStreamingState`
- `isStreamingResponseInBackground`
- `RecentlyStreamedConversationObserver`
- `RecentlyStreamedConversationPlugin`
- `TriggerAsyncStatusPollingConversationObserver`
- `ConversationPollingManager`
- `conversationStreamStatus(id:requestTrackingData:)`
- `finished_streaming`
- `message_stream_complete`
- `side-menu-conversation-progress`

This strongly supports the premise that the app can keep multiple conversations generating while only one is visible.

## Notification Investigation

OpenAI's official macOS app release notes say the October 30, 2024 release added notifications "for when the assistant finishes replying in the background."

Source: https://help.openai.com/en/articles/9703738-desktop-app-release-notes

Local evidence also supports this:

- ChatGPT links `UserNotifications.framework`.
- ChatGPT has a production APNS entitlement.
- The app's UserDefaults say "Responses" push notifications are enabled.
- The macOS `usernoted` database has registered ChatGPT notification categories.

Decoded ChatGPT categories in:

`~/Library/Group Containers/group.com.apple.usernoted/db2/db`

Registered category ids include:

- `odyssey_final_answer`
- `odyssey_final_answer_with_login`
- `odyssey_final_answer_with_takeover`
- `odyssey_final_answer_with_confirmation`
- `jawboneResponse`
- `chatMessage`
- `codexFinished`
- `target_url`

Several categories include an `openConversation` action. `chatMessage` includes a text reply action.

### Can We Use NSDistributedNotificationCenter?

Probably not.

`NSDistributedNotificationCenter` is an interprocess `NSNotification` broadcast mechanism, not the macOS user-notification delivery mechanism. I found no evidence that ChatGPT posts response-completion events there. A broad local listener saw no relevant idle events, and the app binary mostly indicates ordinary in-process `NotificationCenter` and `UserNotifications` usage.

Apple reference: https://developer.apple.com/documentation/foundation/distributednotificationcenter

### Can We Use NSUserNotificationCenter Or UNUserNotificationCenter?

Not as a clean public API for another app's notifications.

Apple's `UNUserNotificationCenter` APIs are scoped to "your app's" notification center. They can fetch/remove notifications delivered by the calling app, not arbitrary notifications from ChatGPT.

Apple reference: https://developer.apple.com/documentation/usernotifications/unusernotificationcenter

Older `NSUserNotificationCenter` has the same practical limitation. Third-party reports also confirm `deliveredNotifications` only returns notifications raised by the calling app:

https://stackoverflow.com/questions/23169650/trying-to-check-notifications-from-other-apps

### Can We Watch The Private Notification DB?

Yes, as an optional wake-up hint.

The private `usernoted` SQLite database has `app`, `record`, `delivered`, `displayed`, and `categories` tables. A watcher could poll or FSEvents-watch:

`~/Library/Group Containers/group.com.apple.usernoted/db2/db`

When a new `record` appears for app identifier `com.openai.chat` with a category like `odyssey_final_answer`, the daemon can enqueue immediate probes for active requests.

This should not be the primary completion mechanism because:

- It is private and undocumented.
- Notification previews/focus settings may suppress content.
- ChatGPT may suppress notifications for the currently visible conversation.
- There were no existing delivered ChatGPT notification records on this machine at test time.
- I could not live-generate a new notification from this Codex process because it lacks Accessibility permission (`AXIsProcessTrusted()` was false and `kAXWindowsAttribute` returned `-25211`).

### Can We Put Request IDs In Notification Text?

Maybe, but it should be opportunistic.

If we rename a conversation to include a request id, the notification title/body may include that id. If not, the notification action payload may still include a target URL or conversation id. Neither is guaranteed by a public contract.

Recommendation: include the request id in the conversation title and first prompt for searchability, but do not require notification content to map completions.

## AX Completion Detection

### Can We Poll A Non-Visible Conversation's AX Tree?

Likely no.

AX exposes the current app/window accessibility tree. ChatGPT uses SwiftUI/WebKit-like virtualized views. The existing driver reads only visible `AXStaticText` and visible buttons. Non-visible conversation content is not expected to exist in the AX tree.

Possible visible-sidebar signals:

- The sidebar may expose a progress indicator for visible rows (`side-menu-conversation-progress` appears in the binary).
- Rows may expose `isStreamingResponseInBackground`, unread state, or progress through accessibility labels.

These may help when the relevant row is visible, but they are not enough for a robust many-request queue because rows can be offscreen or filtered.

### Reliable Completion Probe

The reliable mechanism is to briefly switch to the conversation and inspect visible state:

1. Switch to request conversation.
2. Check for the localized stop-generating button (`Stop generating`, `停止生成`, etc.).
3. If stop is present, mark still generating and reschedule.
4. If stop is absent, read assistant text/images.
5. Confirm stability with a short second read or content hash.
6. Mark complete and write the response file.

This uses serial UI time, but it does not prevent parallel generation. The app keeps other conversations generating while the daemon probes.

## Request To Conversation Mapping

Use multiple mapping layers because no single one is guaranteed.

Recommended primary mapping:

- Generate a request id, for example `ecx-20260423-abc123`.
- Prefix or embed a sentinel in the initial prompt:
  `Request ID: ecx-20260423-abc123. Do not include this ID in your answer.`
- After send, rename the conversation to `ECX abc123 - <short title>` if the UI supports a reliable rename path.
- Persist local metadata in the daemon store.

Why include the request id in the prompt:

- ChatGPT's conversation search can find message text.
- It works even if the automatic conversation title changes.
- It helps repair lost mappings after daemon restart.

Why still rename:

- It makes sidebar switching faster and more human-debuggable.
- It can make notification titles useful when background replies finish.

Switching strategy:

1. Prefer conversation search by request id.
2. Select the first matching result.
3. Verify by reading visible conversation text and finding the sentinel or title.
4. Fallback to visible sidebar row title if search fails.
5. Fallback to manual recovery state rather than guessing.

## Proposed CLI-First Architecture

Build a daemon-backed CLI. MCP can call the CLI or daemon API later, but users and agents do not need MCP for the main workflow.

Example CLI:

```bash
chatgpt-native daemon
chatgpt-native submit --model "GPT-5.4" "prompt text"
chatgpt-native wait <request-id>
chatgpt-native fetch <request-id>
chatgpt-native ask "prompt text"
chatgpt-native image "image prompt"
chatgpt-native status
chatgpt-native dump-ax
chatgpt-native open <request-id>
```

Suggested output from `submit`:

```json
{
  "request_id": "ecx-20260423-abc123",
  "state": "queued",
  "response_path": "~/.chatgpt-native/responses/ecx-20260423-abc123.json",
  "image_dir": null
}
```

`ask` is just a synchronous wrapper around `submit` plus `wait`.

### Core Components

`RequestStore`

- File-backed JSON or SQLite.
- Persists request, state, prompt, options, request id, conversation title, last probe, hashes, response path, image dir, errors.

`UIQueue`

- The only code allowed to call AX or synthesize UI input.
- Provides atomic operations:
  - ensure app/window
  - new conversation
  - switch conversation
  - rename conversation
  - set model/options
  - paste prompt
  - send
  - probe current conversation
  - read response
  - download/extract images
  - dump AX tree

`SubmitWorker`

- Dequeues pending requests.
- Acquires the UI queue.
- Creates/switches conversation.
- Inserts request-id sentinel.
- Sends prompt.
- Records `generating`.
- Releases UI immediately.

`CompletionWatcher`

- Maintains all active generations.
- Uses notifications/private DB/log/file mtime/sidebar signals only as wake-up hints.
- Schedules serial UI probes with adaptive backoff.
- Enqueues complete requests for reading.

`ReadWorker`

- Acquires UI queue.
- Switches to the conversation.
- Extracts final text and images.
- Writes `response_path`.
- Marks request `complete` or `error`.
- Notifies caller/agent if configured.

### State Machine

```text
queued
  -> submitting
  -> generating
  -> completion_hint     optional
  -> probing
  -> reading
  -> complete

Any state -> error
Any active state -> cancelled
```

`probing` and `reading` are short UI jobs. They must not monopolize the UI while there are fresh pending submissions.

### Scheduling Policy

The daemon should optimize for starting parallel generation quickly:

1. If active generations are below `max_active_generations`, prioritize pending submits.
2. Once the active cap is reached, interleave probes.
3. Probe intervals should be adaptive:
   - first normal text probe: 5-10 seconds after submit
   - first reasoning/pro probe: 20-45 seconds after submit
   - image/deep research: 30-60 seconds after submit
   - cap steady-state probe interval around 30-60 seconds
4. Notification hints move a request to the front of the probe queue, but do not mark it complete by themselves.

Suggested default cap:

- `max_active_generations = 3` initially.
- Make it configurable.
- Increase only after measuring ChatGPT account/model behavior.

### Why One UI Queue, Not Separate Submit And Read Locks

Submit and read are logical queues, but they use the same physical resource: the visible ChatGPT UI.

Implementation should use one global UI mutex/queue with priorities:

1. emergency stop/cancel
2. submit, while active count is below cap
3. read confirmed-complete requests
4. probe active requests
5. diagnostics

This avoids accidental concurrent AX operations while still giving the scheduler control.

## Image Responses

Image support should use the same request lifecycle.

Differences:

- Completion usually takes longer, so probe less frequently.
- The read job must extract files, not just text.
- Preferred extraction order:
  1. Use visible ChatGPT download controls via AX.
  2. Use copy/share controls if download is not exposed.
  3. As a last resort, inspect rendered image URLs or WebKit cache.

The response JSON should include both `text` and `files`, matching the current connector's async pattern.

## Failure And Recovery

Persist enough data to recover after daemon restart:

- request id
- prompt hash and prompt sentinel
- conversation title
- options/model/mode
- current state
- last known response hash/length
- next probe time
- response path
- any notification target URL or conversation id if discovered

On startup:

1. Rebuild active generation set from store.
2. For `submitting` requests, verify whether a conversation exists by searching for the sentinel.
3. If found, move to `generating`.
4. If not found, retry submit or mark `needs_recovery`.
5. Probe active requests in order.

Avoid guessing if multiple conversations match a sentinel. Mark ambiguous and expose a repair command.

## Implementation Direction

Best path:

1. Build a standalone native CLI/daemon first.
2. Use Go + cgo/Objective-C from `chatgpt-cli` for AX primitives.
3. Add a request store and scheduler around those primitives.
4. Add conversation search/switch/rename primitives.
5. Add localized label maps:
   - English
   - Chinese, because the reference repo currently uses Chinese labels
   - any other configured UI language
6. Add diagnostic commands before high-level automation:
   - `dump-ax`
   - `buttons`
   - `conversation-search <query>`
   - `probe <request-id>`
   - `read <request-id>`

The existing Node connector can either:

- call the CLI as a subprocess, or
- replace `browser-controller.mjs` with a `native-controller.mjs` that talks to the daemon.

MCP should remain optional:

- MCP tool `submit_pro` can call `chatgpt-native submit`.
- MCP tool `fetch` can read the response JSON.
- Direct CLI usage remains the primary interface.

## Open Questions To Validate With Accessibility Permission

This Codex process currently lacks Accessibility permission, so live AX tests returned `kAXWindowsAttribute AXError=-25211`.

Need to validate from an AX-authorized terminal:

1. Exact English AX labels for new chat, send, stop, search, rename, download image.
2. Whether conversation search has stable AX elements.
3. Whether request-id sentinel search reliably finds the right conversation.
4. Whether switching away truly preserves multiple simultaneous generations for the target models.
5. Whether sidebar rows expose a usable progress/unread indicator through AX.
6. Whether a finished background response creates a `usernoted.record` row with a useful payload.
7. Whether notification title/body includes renamed conversation title or request id.
8. Whether image generation completion uses the same `odyssey_final_answer` category.

## Bottom Line

Do not block on notifications.

Use a CLI daemon with a serial AX UI queue and a persistent active-generation table. Submit quickly, release the UI, let ChatGPT generate in multiple background conversations, and use scheduled switch-and-probe jobs to discover completion. Add notification/database/log watchers only as accelerators.

That gives us the important property: serial UI control without serializing model generation.
