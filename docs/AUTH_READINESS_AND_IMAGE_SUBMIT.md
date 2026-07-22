# Auth Readiness and Image Submit Fix

Date: 2026-04-28

## Problem

`submit_image` could return a successful-looking payload:

```json
{ "request_id": "...", "image_dir": "..." }
```

even when the browser worker was going to fail before dispatching the prompt. The user-visible symptom was a set of blank ChatGPT tabs and a later request status error:

```text
not_logged_in: run `exocortex-chatgpt launch --visible` and sign in
```

This was a false auth failure. Fred was logged in.

## Root Cause

The browser controller used a too-simple auth check:

1. Open or reuse a ChatGPT page.
2. If the current URL looked like a login URL, report `not_logged_in`.
3. Otherwise, check immediately for `#prompt-textarea`.
4. If the composer was missing, also report `not_logged_in`.

That conflated two different states:

- genuinely logged out
- ChatGPT page loaded enough for `domcontentloaded`, but the app had not hydrated/rendered the prompt composer yet

During parallel image submissions, the daemon opened tabs and checked too early. A missing composer was labeled as logout, so the request failed after submission even though the session was authenticated.

## Fix

The browser controller now waits for a positive page capability signal before deciding auth state:

- login URL or login marker means `not_logged_in`
- `#prompt-textarea` or the contenteditable textbox means the page is prompt-capable
- neither signal means `loading`, not logged out
- unexpected inspection failures report `error`, not logged out

`submit_image` now performs a submit-time session preflight before writing the mailbox request. If ChatGPT is truly logged out, not ready, or not inspectable, the tool call fails immediately and does not return a fake `request_id`.

The daemon-side request processing still performs its own page capability assertion before typing, so queued requests remain protected if the session changes after submission.

## Image Routing

Image requests are intentionally routed to Pro:

```js
{ model: 'pro', mode: 'image', fresh: true }
```

The mailbox default for `mode: 'image'` is also `pro`, and explicit Pro model aliases such as `gpt-5-pro` are accepted. Do not change `submit_image` to route to non-Pro GPT-5 unless the product decision changes.

## Verification

The fix was verified with live ChatGPT submissions after restarting the mailbox daemon:

- a direct CLI image request dispatched into ChatGPT and produced `/tmp/chatgpt-mcp-auth-debug-smoke/01.png`
- an MCP-tool-style `submit_image` call dispatched into ChatGPT and produced `/tmp/chatgpt-mcp-auth-debug-mcp/01.png`
- both prompts appeared as user messages in ChatGPT rather than blank tabs
- unit tests cover submit-time failure before queueing when session status is `not_logged_in`

