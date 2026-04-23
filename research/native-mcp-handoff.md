# Native ChatGPT MCP/CLI Handoff

Last updated: 2026-04-23

This document is the restart handoff for the native ChatGPT macOS connector in
`/Users/fredluz/Code/exocortex-chatgpt-connector`.

It is intentionally detailed. The goal is that a future tmux/Codex session can
resume work without rediscovering the architecture, the permission failure, the
notification state, or the safety constraints.

## Critical Status

Current state as of this handoff:

- The browser/Patchright backend is deprecated in this repo and has been removed
  from the executable path.
- The new native backend is implemented in `native-controller.mjs`.
- The CLI/MCP flow is now mailbox/daemon based:
  - submit request file
  - daemon serializes UI work
  - ChatGPT generates in background conversations
  - daemon writes response JSON
  - MCP/CLI fetches response JSON
- Unit tests pass after the latest safety fixes:
  - `npm test`
  - 46 tests passed in the last run.
- A real end-to-end native submit/read test has NOT been completed yet.
- The current Codex/terminal process still lacks the real System Events
  Accessibility permission:
  - `node cli.mjs status` now correctly reports
    `state=needs_accessibility_permission`
  - `/usr/bin/osascript -e 'tell application "System Events" to return UI elements enabled'`
    returns `false`
  - direct AX/System Events calls fail with `-25211`.
- No ChatGPT-control daemon should be running at this handoff.

Most important: do not run `submit`, `query`, `image`, `last`, `new`, `model`,
or `stop` against the real home mailbox until the permission and focus policy are
understood. The previous focus-stealing failure came from a daemon retry loop.
That specific retry loop has been patched, but a trusted daemon can still focus
ChatGPT for normal probes unless a daytime focus policy is added.

## Emergency Stop

If ChatGPT starts stealing focus again, run:

```bash
pgrep -fl 'node .*cli\.mjs daemon|node .*daemon\.mjs|exocortex-chatgpt.*daemon'
```

Then kill only the matching ChatGPT connector daemon process:

```bash
kill -TERM <pid>
sleep 1
kill -KILL <pid> 2>/dev/null || true
```

If the pid file is stale, remove it only after verifying the process is dead:

```bash
rm -f ~/.exocortex/chatgpt/daemon.pid
```

Do not kill arbitrary `node` processes. Codex, MCP servers, tmux helpers, and
other developer tools may also be Node processes.

## Why This Exists

The product goal is to let agents use the ChatGPT macOS desktop app as a local
backend for:

- long-running Pro reasoning prompts
- ordinary text prompts
- image generation
- asynchronous workflows where the caller gets a request id immediately
- eventual MCP access for agent tools

MCP is not the core architecture. The core should be a standard CLI plus a
file-backed daemon. MCP is just one adapter over that CLI/mailbox.

This is important because MCP sessions can restart, tmux can restart, and agents
can go away. A filesystem mailbox lets work survive those boundaries.

## The Architecture In One Sentence

Use one serial UI worker to operate the visible ChatGPT app, but let ChatGPT
itself generate responses in multiple background conversations in parallel.

## The Central Constraint

The ChatGPT macOS app has one visible window and one visible conversation at a
time. AX/System Events can only interact with the visible UI. Therefore:

- creating a chat is a UI operation
- switching conversations is a UI operation
- typing/pasting a prompt is a UI operation
- pressing send is a UI operation
- reading final text through AX is a UI operation

Those operations must be serialized.

But response generation is not a UI operation after the prompt is submitted.
The app can continue streaming in background conversations while another
conversation is visible. That is the opening for parallelism.

## Desired Flow

For each request:

1. Caller submits prompt through CLI or MCP.
2. Request JSON is written to the mailbox.
3. Daemon claims one pending request.
4. Daemon briefly controls ChatGPT:
   - create or switch to a conversation
   - inject a request id sentinel
   - paste the prompt
   - send
5. Daemon records local metadata and releases the UI.
6. ChatGPT generates in that conversation, possibly in the background.
7. Completion is detected by one of:
   - ChatGPT macOS notification record
   - local app database/cache/log signal
   - conservative timed/idle probe
   - explicit foreground/overnight probe
8. Daemon queues a serial read operation.
9. Daemon switches to the conversation and extracts response text or downloads
   images.
10. Daemon writes response JSON.
11. MCP/CLI caller reads response JSON or receives a routed notification.

## Repository Files

Main implementation files:

- `cli.mjs`
  - Single executable entry point.
  - Commands include `status`, `daemon`, `submit`, `fetch`, `query`, `image`,
    `last`, `new`, `model`, `thinking`, `stop`, `check`.

- `native-controller.mjs`
  - Native ChatGPT app controller.
  - Uses `/usr/bin/osascript` and System Events for UI automation.
  - Uses `/usr/bin/open -b com.openai.chat` to launch/activate ChatGPT.
  - Reads ChatGPT defaults for `lastSelectedConversation`.
  - Scans the macOS `usernoted` SQLite database for ChatGPT notifications.

- `daemon.mjs`
  - Long-running mailbox worker.
  - Serializes submit/probe/read work.
  - Applies notification hints.
  - Owns the active-generation scheduling loop.

- `daemon-core.mjs`
  - Testable core state transitions for submit and probe.
  - Converts successful probes into response JSON.
  - Converts terminal failures into error response JSON.

- `mailbox.mjs`
  - File-backed request/response storage.
  - Request ids, paths, locking, response verification, daemon pid management.
  - `ensureDaemonRunning()`.

- `mcp-tools.mjs`
  - MCP adapter.
  - Registers:
    - `query`
    - `submit_pro`
    - `submit_image`
    - `status`
    - `fetch`

- `http-api.mjs`
  - HTTP adapter over the same mailbox/controller behavior.

- `runtime-paths.mjs`
  - Centralizes `$EXOCORTEX_HOME/chatgpt` paths.

Research and docs:

- `research/parallel-native-architecture.md`
  - Original architecture investigation.
  - Notification and AX research.

- `research/axuielement-chatgpt-cli-prep.md`
  - Notes from the reference repo.

- `research/chatgpt-ax-dump.txt`
  - Placeholder/failed AX dump from an untrusted process.

- `research/native-mcp-handoff.md`
  - This handoff.

Deleted/deprecated browser files:

- `browser-controller.mjs`
- `launcher.mjs`
- `selectors.json`
- `tests/selectors.test.mjs`
- browser-specific blueprint/spec files

## Mailbox Layout

Default state root:

```text
~/.exocortex/chatgpt/
```

If `EXOCORTEX_HOME` is set, the root becomes:

```text
$EXOCORTEX_HOME/chatgpt/
```

Important paths:

```text
~/.exocortex/chatgpt/requests/
~/.exocortex/chatgpt/responses/
~/.exocortex/chatgpt/agents/<agent>/pro/
~/.exocortex/chatgpt/agents/<agent>/images/
~/.exocortex/chatgpt/daemon.pid
```

Request file shape:

```json
{
  "request_id": "1776936515898-37dc-agent",
  "state": "pending",
  "prompt": "Prompt text",
  "agent": "agent",
  "model": "pro",
  "thinking": "extended",
  "fresh": true,
  "mode": "text",
  "response_path": "/Users/fredluz/.exocortex/chatgpt/agents/agent/pro/<id>.json",
  "output_dir": null,
  "image_dir": null,
  "created_at": "2026-04-23T..."
}
```

Response file shape:

```json
{
  "request_id": "1776936515898-37dc-agent",
  "state": "complete",
  "agent": "agent",
  "response_path": "/Users/fredluz/.exocortex/chatgpt/agents/agent/pro/<id>.json",
  "text": "assistant response",
  "files": [],
  "mode": "text",
  "image_dir": null,
  "created_at": "2026-04-23T...",
  "started_at": "2026-04-23T...",
  "finished_at": "2026-04-23T...",
  "elapsed_ms": 123456
}
```

Error response shape:

```json
{
  "request_id": "1776936515898-37dc-agent",
  "state": "error",
  "text": "",
  "files": [],
  "error": "native_accessibility_permission_missing"
}
```

## MCP Tool Semantics

`submit_pro`

- Non-blocking.
- Preferred for agents.
- Writes a request and returns `request_id` plus `response_path`.
- Routes to Pro-style model settings by default.
- Caller should sleep/wait and then read response JSON.

`submit_image`

- Non-blocking.
- Preferred for image work.
- Writes a request and returns `request_id` plus `image_dir`.
- Response JSON still exists in the agent `pro` directory and includes `files`.

`query`

- Blocking.
- Uses submit/poll/fetch underneath.
- Should be reserved for interactive/manual use.
- Not recommended for agent loops because it burns context/tool time.

`status`

- For a request id, checks request/response state.

`fetch`

- Returns response text/files when complete.
- Returns `complete=false` while pending/generating.

## Native Controller Details

Bundle id:

```text
com.openai.chat
```

App/process name:

```text
ChatGPT
```

The controller's important operations:

- `status()`
  - Checks whether ChatGPT is running.
  - Checks whether System Events UI scripting is enabled for this process.
  - Must not focus ChatGPT.

- `launch()`
  - Opens ChatGPT intentionally.

- `submitRequest(request)`
  - Requires AX permission.
  - Activates ChatGPT.
  - Optionally selects model.
  - Creates a new chat unless `fresh=false`.
  - Writes request id/sentinel into the prompt.
  - Sends the prompt.
  - Restores the previously frontmost app afterward.

- `probeRequest(request)`
  - Requires AX permission.
  - Activates ChatGPT.
  - Switches to the target conversation by URL if available, otherwise by
    search/sentinel.
  - Checks for the stop button.
  - If not generating, reads visible text and extracts the assistant response.
  - Restores previous frontmost app afterward.

- `scanNotifications(requests, sinceRecordId)`
  - Reads the private macOS `usernoted` SQLite database.
  - Looks for notification records for `com.openai.chat` or
    `com.openai.chatgpt`.
  - Extracts printable strings from the notification payload.
  - Matches request ids, sentinels, or conversation titles.
  - Returns hints; it does not write final responses.

## Request Sentinel

Every prompt currently includes:

```text
Request ID: <request_id>
Tracking token: ECX_REQUEST_ID:<request_id>
Keep the tracking token out of your final answer unless explicitly asked.

<actual prompt>
```

Why:

- Enables local search if conversation mapping is lost.
- Gives notifications a possible request id to include.
- Helps extract/remove prompt text from the AX-collected final transcript.

Important limitation:

The conversation is not currently renamed in the ChatGPT UI. The code stores a
local `conversation_title` like `ECX <request_id> ...`, but it does not yet
perform the UI operation to rename the conversation. If ChatGPT notifications use
conversation title but not prompt body, notification matching may fail until
conversation renaming is implemented.

## Permission Model

There are two macOS permission families relevant here:

1. Accessibility
   - Required for System Events UI scripting.
   - Needed to inspect/click/type into ChatGPT's UI.
   - Failure often appears as:
     - `System Events got an error: osascript is not allowed assistive access`
     - error number `-25211` or `-1719`

2. Automation / Apple Events
   - May be prompted when a process tells ChatGPT or System Events to do
     something.
   - Check System Settings -> Privacy & Security -> Automation if macOS prompts.

Practical finding:

The error message may blame `osascript`, but the permission usually belongs to
the app launching it. If the command is run from Terminal, Terminal may need
Accessibility permission. If it is run from iTerm, iTerm may need it. If it is
run from a wrapper app, the wrapper app needs it. If it is run from a LaunchAgent
or background daemon, the responsible executable/app identity may differ.

Known useful references:

- Apple `AXIsProcessTrusted()` docs:
  https://developer.apple.com/documentation/applicationservices/1460720-axisprocesstrusted
- Stack Overflow answer explaining that GUI scripting authorization is at the
  application level and the `osascript` wording can be misleading:
  https://stackoverflow.com/questions/32907909/allow-applescript-script-to-run-without-asking-for-permission
- Ask Different discussion where some setups also needed `osascript` added:
  https://apple.stackexchange.com/questions/291574/osascript-is-not-allowed-assistive-access-1728

## How To Grant Permissions

First grant Accessibility to the GUI app that owns the shell running the daemon:

- Terminal.app
- iTerm.app
- Ghostty.app
- WezTerm.app
- VS Code.app
- Cursor.app
- the Codex/agent wrapper app, if it is a GUI app
- any custom wrapper app that launches the daemon

Path:

```text
System Settings -> Privacy & Security -> Accessibility
```

Enable the app, then quit and relaunch that app. Restart tmux afterward if tmux
was already running inside the old process tree.

Then test:

```bash
/usr/bin/osascript -e 'tell application "System Events" to return UI elements enabled'
```

Expected:

```text
true
```

Then test:

```bash
/usr/bin/osascript -e 'tell application "System Events" to tell process "ChatGPT" to return count of windows'
```

Expected:

- a number if ChatGPT is running
- a normal "process not found" style error if ChatGPT is not running
- not `-25211`

If the first command still returns `false`, try adding `/usr/bin/osascript` to
Accessibility as well:

1. Open System Settings -> Privacy & Security -> Accessibility.
2. Press `+`.
3. Use `Cmd+Shift+G`.
4. Enter `/usr/bin`.
5. Select `osascript`.
6. Enable it.
7. Quit/reopen the terminal app and restart tmux.

If the daemon is started by LaunchAgent, do not assume Terminal's permission
applies. Use a small signed `.app` wrapper or run it from a known AX-trusted
interactive terminal first. LaunchAgent/TCC identity is a separate problem and
should not be the first E2E path.

## Correct Permission Checks

Use this non-focusing check:

```bash
node cli.mjs status
```

Expected before E2E:

```text
state=ready
```

Also use:

```bash
/usr/bin/osascript -e 'tell application "System Events" to return UI elements enabled'
```

Expected:

```text
true
```

Do not rely on a weak check like asking System Events for the frontmost process.
That produced a false positive earlier.

The code has been patched so `native-controller.mjs` now uses:

```applescript
tell application "System Events" to return UI elements enabled
```

## The Focus-Stealing Incident

What happened:

1. A real `submit` command was run while the process did not have proper AX
   permission.
2. The daemon tried to submit through the native controller.
3. `submitRequest()` activated ChatGPT before failing.
4. The failure was written as `submit_error`.
5. `daemon.mjs` treated `submit_error` as pending.
6. The daemon retried.
7. Each retry activated ChatGPT again.
8. The user could not keep another window active.

Fixes already applied:

- `native-controller.axTrusted()` now uses `UI elements enabled`.
- `daemon-core.submitNativeRequest()` now writes an error response and removes
  the request on submit failure.
- `daemon.mjs.isPending()` now returns true only for `pending`, not
  `submit_error`.
- Tests include a terminal submit-failure path.

Remaining risk:

If AX permission is granted and the daemon is running, normal probes still focus
ChatGPT briefly, then restore the previous app. That is acceptable for overnight
runs but still bad for daytime use. Add a focus policy before using the daemon
for regular interactive work.

## Required Focus Policy Work

This is the next implementation priority before real daily use.

Add an explicit focus policy in `daemon.mjs`, probably with an env var:

```text
CHATGPT_NATIVE_FOCUS_POLICY=interactive|idle|always|notification_only
```

Suggested semantics:

- `interactive` default
  - May submit only when the user explicitly requested it or when ChatGPT is
    already frontmost.
  - Does not run scheduled probes while another app is active.
  - Uses notifications/local signals only as hints.

- `idle`
  - May touch ChatGPT only when user idle time exceeds a threshold.
  - Suggested env:
    - `CHATGPT_NATIVE_IDLE_SECONDS=120`

- `always`
  - Overnight/batch mode.
  - Current behavior: daemon can focus ChatGPT for submit and probes.
  - Must be opt-in.

- `notification_only`
  - Never scheduled-probe.
  - Only reads when a ChatGPT completion notification or local database signal
    says the response is likely complete.
  - May still need to focus ChatGPT for final extraction unless response text can
    be recovered from local files/notification payload.

Non-focusing helpers to add/export from `native-controller.mjs`:

```js
export async function frontmostBundleId()
export async function userIdleSeconds()
```

Frontmost check can use System Events but must not activate ChatGPT.

Idle time can be read without focusing:

```bash
ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print int($NF/1000000000); exit}'
```

Daemon scheduling rule:

```text
if policy does not allow focus right now:
  leave request state as-is
  set next_probe_at to a later time
  do not call submitRequest()
  do not call probeRequest()
```

This is separate from AX permission. A process can be AX-trusted and still
should not steal focus during interactive use.

## Notification System Findings

The implementation includes a notification scanner, but notification completion
is not proven end-to-end yet.

Local database path:

```text
~/Library/Group Containers/group.com.apple.usernoted/db2/db
```

Observed schema:

```text
app
categories
dbinfo
delivered
displayed
record
requests
```

Observed local app rows:

```text
106|com.openai.codex
116|com.openai.chat
```

Observed ChatGPT notification categories include strings such as:

```text
jawboneResponse
codexFinished
odyssey_final_answer
odyssey_final_answer_with_confirmation
odyssey_final_answer_with_takeover
odyssey_final_answer_with_login
chatMessage
chatMessageReply
openConversation
target_url
```

This strongly suggests ChatGPT has a final-answer notification path and may
include an open-conversation target URL in the notification payload.

Observed problem:

```text
SELECT count(*) FROM record WHERE app_id=116;
```

returned zero during investigation. So ChatGPT is registered for notifications,
but this machine did not yet have delivered ChatGPT notification records in
`record`.

Likely explanations:

- No background ChatGPT completion happened during the test window.
- ChatGPT notifications are disabled in macOS settings.
- ChatGPT suppresses completion notifications when its window/conversation is
  foreground.
- Focus mode/notification settings suppress or avoid writing records.
- The app writes to `requests`, `delivered`, or `displayed` blobs instead of
  `record` for some cases.
- Notification content exists only in WAL until checkpoint; the current query
  should still see WAL through SQLite, but this should be verified.

## Notification Test Plan

Run this only after AX permission is fixed and with an isolated mailbox.

Before the test:

1. Open System Settings -> Notifications -> ChatGPT.
2. Enable notifications.
3. Enable notification previews if possible.
4. Disable Focus modes that suppress ChatGPT.
5. Make sure ChatGPT is signed in.

Capture baseline:

```bash
sqlite3 -readonly "$HOME/Library/Group Containers/group.com.apple.usernoted/db2/db" \
  "SELECT COALESCE(MAX(r.rec_id), 0)
   FROM record r JOIN app a USING(app_id)
   WHERE lower(a.identifier) IN ('com.openai.chat','com.openai.chatgpt');"
```

Submit a request with a unique visible token:

```text
Please wait three seconds, then answer exactly:
ECX_NOTIFY_TEST_<timestamp>
```

Important: for notification testing, do not ask the model to hide the token.
We want to know whether notification title/body/preview includes it.

Immediately switch away from ChatGPT and keep another app frontmost.

After response should complete, query:

```bash
sqlite3 -readonly -separator $'\t' "$HOME/Library/Group Containers/group.com.apple.usernoted/db2/db" \
  "SELECT r.rec_id,
          a.identifier,
          datetime(coalesce(r.delivered_date,r.request_date), 'unixepoch'),
          length(r.data),
          hex(r.data)
   FROM record r JOIN app a USING(app_id)
   WHERE lower(a.identifier) IN ('com.openai.chat','com.openai.chatgpt')
     AND r.rec_id > <baseline>
   ORDER BY r.rec_id ASC;"
```

Decode strings:

```bash
sqlite3 -readonly "$HOME/Library/Group Containers/group.com.apple.usernoted/db2/db" \
  "SELECT hex(r.data)
   FROM record r JOIN app a USING(app_id)
   WHERE lower(a.identifier)='com.openai.chat'
   ORDER BY r.rec_id DESC LIMIT 1;" |
xxd -r -p |
strings -a
```

Things to look for:

- request id
- `ECX_REQUEST_ID`
- visible unique token
- conversation title
- answer preview
- `target_url`
- `chatgpt://` URL
- `openai://` URL
- `https://chatgpt.com/...`

If records appear:

- update `scanNotifications()` to parse the payload more deliberately
- store `target_url` on the request
- use notification as a high-confidence completion signal
- consider writing a response directly if full answer text is present

If records do not appear:

- do not block on notifications
- continue with local conversation cache research and idle/overnight probes

## Local Cache/Database Alternative

The best daytime architecture may be:

```text
UI only for submit + final extraction
non-UI local signals for completion detection
```

Potential local sources:

```text
~/Library/Application Support/com.openai.chat/
~/Library/Application Support/com.openai.chat/conversations-v3-*/
~/Library/Containers/com.openai.chat/
~/Library/Group Containers/2DC432GLL2.group.com.openai.chat/
```

Research questions:

- Does ChatGPT persist background streaming deltas to a local SQLite database?
- Does a conversation file mtime update while background generation streams?
- Is there a final/completed flag?
- Can the request id sentinel be found in local cache after submit?
- Can the assistant answer be read from local cache without AX?
- Is image generation metadata/download URL stored locally?

Suggested commands:

```bash
find "$HOME/Library/Application Support/com.openai.chat" -maxdepth 4 -type f \
  -mtime -1 -print
```

```bash
rg -a "ECX_REQUEST_ID|<request_id>|<unique token>" \
  "$HOME/Library/Application Support/com.openai.chat" \
  "$HOME/Library/Group Containers" \
  2>/dev/null
```

```bash
find "$HOME/Library/Application Support/com.openai.chat" -type f -name '*.sqlite' -o -name '*.db'
```

If local cache works, it is better than AX polling:

- no focus stealing
- no ChatGPT window switching
- completion can be detected by file changes
- final text may be recoverable directly

But do not assume this works until tested with a live request id.

## Current End-To-End Test Plan

Only run after:

```bash
node cli.mjs status
```

returns:

```text
state=ready
```

and:

```bash
/usr/bin/osascript -e 'tell application "System Events" to return UI elements enabled'
```

returns:

```text
true
```

Use an isolated mailbox so real queued requests are not touched:

```bash
export EXOCORTEX_HOME="$(mktemp -d /tmp/exo-chatgpt-e2e.XXXXXX)"
export CHATGPT_NATIVE_MAX_ACTIVE=1
export CHATGPT_NATIVE_TEXT_PROBE_MS=3000
```

Start with a simple non-Pro text request:

```bash
request_id=$(node cli.mjs submit --agent e2e "Reply with exactly: ECX_E2E_OK")
echo "$request_id"
```

Watch state:

```bash
for i in {1..120}; do
  node cli.mjs status "$request_id"
  node cli.mjs fetch "$request_id"
  sleep 2
done
```

Expected final fetch:

```json
{
  "text": "ECX_E2E_OK",
  "files": [],
  "complete": true
}
```

After the test, stop the isolated daemon:

```bash
if test -f "$EXOCORTEX_HOME/chatgpt/daemon.pid"; then
  kill -TERM "$(cat "$EXOCORTEX_HOME/chatgpt/daemon.pid")" 2>/dev/null || true
fi
```

Do not run the E2E from the real mailbox first. Use `EXOCORTEX_HOME` until
submit/probe/read behavior is proven.

## Current Code Safety State

Already fixed:

- wrong AX trust check
- submit failure retry loop
- submit failure now creates terminal error response
- daemon no longer treats `submit_error` as pending

Still needed before daytime use:

- explicit focus policy
- no scheduled probes while user is active in another app
- better notification/local-cache completion signal
- explicit E2E command or script that:
  - uses temp mailbox
  - starts daemon
  - submits one prompt
  - polls response
  - kills daemon
  - prints ChatGPT notification records observed during the run

Recommended new script:

```text
scripts/e2e-native-smoke.sh
```

Requirements for that script:

- refuse to run unless `node cli.mjs status` is `state=ready`
- require `--allow-focus` flag
- set temporary `EXOCORTEX_HOME`
- submit a deterministic prompt
- capture notification baseline and post-run records
- always stop daemon in `trap`
- print response path and payload

## Implementation Notes For Next Session

Patch order recommended:

1. Add focus policy helpers.
2. Add focus policy scheduling in `daemon.mjs`.
3. Add tests for policy blocking submit/probe.
4. Add isolated E2E smoke script.
5. Grant/fix Accessibility.
6. Run isolated E2E with `--allow-focus`.
7. Run notification capture during the E2E.
8. Implement conversation rename if notification payload lacks request id.
9. Investigate local cache if notification records are missing.

## Focus Policy Test Cases

Add tests around pure functions if possible.

Cases:

- `always` allows submit and probe.
- `interactive` allows if ChatGPT is frontmost.
- `interactive` blocks if another app is frontmost.
- `idle` allows if idle seconds >= threshold.
- `idle` blocks if idle seconds < threshold.
- `notification_only` blocks scheduled probe without notification hint.
- `notification_only` allows read/probe only when `notification_hint_at` exists.
- blocked work updates `next_probe_at` but does not call native controller.

Do not test by launching ChatGPT. Test the scheduler with injected deps.

## Conversation Mapping

Current mapping is weak:

- `readLastSelectedConversation()` reads ChatGPT defaults.
- `submitRequest()` stores whatever `lastSelectedConversation` returns.
- `conversation_url` is currently `null`.
- `switchToRequestConversation()` prefers a stored URL, then falls back to
  search by sentinel/request id.

Better mapping options:

1. Use notification `target_url` if available.
2. Find local app database conversation id after submit.
3. Rename conversation to include request id.
4. Store ChatGPT local conversation id if `lastSelectedConversation` includes it.
5. Add an explicit `open <request_id>` command for debugging.

Conversation rename is important for notification matching. The current prompt
sentinel may not appear in notification title/body because the model is asked not
to include it in the final answer.

## Image Generation

Current image flow is preliminary:

- `submit_image` creates image-mode request.
- `native-controller.probeRequest()` clicks download buttons when a request is
  complete.
- `collectDownloadedImagesSince()` scans the output directory for images.

Risks:

- ChatGPT image UI may not expose stable download button labels.
- Browser/download destination behavior differs from native app behavior.
- Download buttons may require hover or menu interactions.
- Generated image files may land in Downloads instead of `image_dir` unless the
  app honors the selected destination.

E2E image should wait until text E2E is stable.

## Model Selection

Current model selection is best-effort:

- `maybeSetModel(model)` clicks a model button and then a matching label.
- Pro labels include guesses like `GPT-5.4 Pro`, `GPT-5 Pro`, `Pro`.
- If `CHATGPT_NATIVE_REQUIRE_MODEL=1`, model selection failure throws.
- Otherwise model selection failure is non-fatal and included in metadata.

Model UI labels change often. Keep this best-effort unless exact model routing is
mission critical.

## Why MCP Should Stay Thin

Do not put the real state machine inside MCP request handlers.

Reasons:

- MCP clients restart.
- Long-running work outlives tool calls.
- A CLI can be used by humans, agents, tests, and MCP.
- Filesystem responses are easy to inspect and recover.
- The daemon can be restarted independently.

MCP should:

- validate inputs
- call `ensureDaemonRunning()`
- call mailbox `submit()`, `status()`, `fetch()`, or `query()`
- return paths and ids

MCP should not:

- own a ChatGPT UI session
- block for long Pro generations by default
- keep response state only in memory

## Verification Commands

Static checks:

```bash
node --check native-controller.mjs
node --check daemon-core.mjs
node --check daemon.mjs
```

Tests:

```bash
npm test
```

No-daemon status:

```bash
node cli.mjs status
node cli.mjs check
```

Daemon process check:

```bash
pgrep -fl 'node .*cli\.mjs daemon|node .*daemon\.mjs|exocortex-chatgpt.*daemon' || true
```

Notification app registration:

```bash
sqlite3 -readonly "$HOME/Library/Group Containers/group.com.apple.usernoted/db2/db" \
  "SELECT app_id, identifier FROM app
   WHERE lower(identifier) LIKE '%chatgpt%'
      OR lower(identifier) LIKE '%openai%'
   ORDER BY app_id;"
```

ChatGPT notification record count:

```bash
sqlite3 -readonly "$HOME/Library/Group Containers/group.com.apple.usernoted/db2/db" \
  "SELECT count(*), max(rec_id)
   FROM record
   WHERE app_id=(SELECT app_id FROM app WHERE identifier='com.openai.chat');"
```

## Known Dirty Worktree

The worktree is intentionally dirty. Do not revert user or existing generated
changes.

Expected current categories of changes:

- modified docs:
  - `README.md`
  - `ASYNC_PATTERN.md`
  - `MIGRATION_NOTES.md`
- removed browser backend files
- added native backend file
- modified CLI/daemon/mailbox/MCP files
- added native tests
- added research docs

Before committing, inspect:

```bash
git status --short
git diff --stat
git diff -- native-controller.mjs daemon-core.mjs daemon.mjs mailbox.mjs cli.mjs mcp-tools.mjs
```

## Do Not Repeat These Mistakes

- Do not run real `submit` from the default mailbox just to "see what happens".
- Do not start a daemon unless you know whether it can focus ChatGPT.
- Do not rely on `status=ready` unless the status check uses real System Events
  UI scripting permission.
- Do not treat submit errors as retryable pending work.
- Do not make notifications the only source of truth until an E2E proves records
  contain request ids or target URLs.
- Do not assume MCP is required. CLI first is simpler and safer.
- Do not assume `osascript` is the only process needing permission.
- Do not run destructive git commands to clean the worktree.

## Source Links

Accessibility and AppleScript/TCC references used for this handoff:

- Apple `AXIsProcessTrusted()`:
  https://developer.apple.com/documentation/applicationservices/1460720-axisprocesstrusted
- GUI scripting requires the calling app, such as Terminal.app, to be authorized:
  https://stackoverflow.com/questions/32907909/allow-applescript-script-to-run-without-asking-for-permission
- Some setups also need `osascript` explicitly authorized:
  https://apple.stackexchange.com/questions/291574/osascript-is-not-allowed-assistive-access-1728

Primary local architecture research:

- `research/parallel-native-architecture.md`
- `research/axuielement-chatgpt-cli-prep.md`

