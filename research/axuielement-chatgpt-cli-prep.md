# AXUIElement ChatGPT Desktop Reference

Reference repo: https://github.com/toby1991/chatgpt-cli

Local checkout: `/Users/fredluz/Code/chatgpt-cli`

Checked out commit: `785fa68`

Build status: compiles locally with `/opt/homebrew/bin/go`.

Built binary: `/Users/fredluz/Code/chatgpt-cli/build/gpt`

Smoke checks:

- `build/gpt version` returns `gpt version 0.1.0`
- `build/gpt status` returns `mode: running`, so it can detect the installed ChatGPT macOS app
- `build/gpt dump com.openai.chat` currently cannot read windows from this shell: `kAXWindowsAttribute AXError=-25211`. Grant Accessibility permission to the terminal/Codex host before using AX tree inspection or control.

Diagnostic dump path:

- `/Users/fredluz/Code/exocortex-chatgpt-connector/research/chatgpt-ax-dump.txt`

## Useful Pieces To Reuse

- `automation/ax.m`: Objective-C `AXUIElement` implementation for app discovery, window selection, tree traversal, element press actions, clipboard access, text area setting, and response text extraction.
- `automation/ax.go`: Go/cgo wrapper around the Objective-C AX functions.
- `driver/chatgpt.go`: ChatGPT-specific flow for app launch, window restore, new chat, model selection, send, generation polling, and response extraction.
- `cmd/mcp.go`: Minimal stdio MCP server using `github.com/mark3labs/mcp-go`.
- `cmd/dump.go`: AX tree dump command; important for reverse-engineering ChatGPT UI changes.

## Main Gaps For Our Version

- Locale dependence: upstream currently matches Chinese labels such as `新聊天`, `发送`, `停止生成`, and `搜索`. Our version should support English and be label-configurable.
- Conversation operations: upstream starts a fresh chat, but does not implement robust list/switch/rename for existing ChatGPT conversations.
- Concurrency model: upstream drives one visible ChatGPT app session. Our connector currently uses multiple Chrome tabs for async requests, so the AX version needs an explicit queue/lock model.
- Response extraction: upstream strips the echoed query from a full AX text dump. We should preserve structured extraction metadata where possible and keep raw dumps for debugging.
- Image generation/downloads: upstream is text-first. Our current connector supports image mode; desktop AX support needs separate design.
- MCP compatibility: upstream exposes `search` and `list_models`; our connector exposes `query`, `submit_pro`, `submit_image`, `status`, and `fetch`.

## Recommended Direction

Build a new native backend rather than transplanting upstream wholesale.

Use upstream's low-level AX patterns, but expose an internal interface closer to our existing controller:

- `status()`
- `newChat()`
- `sendPrompt(prompt, options)`
- `waitForCompletion(options)`
- `readResponse()`
- `listConversations()`
- `switchConversation(id|title|index)`
- `renameConversation(id|title|index, newTitle)`
- `dumpTree()`

For async requests, keep the current mailbox model, but serialize ChatGPT Desktop access with one worker. Native ChatGPT does not provide independent browser tabs, so parallel requests need to become queued conversations rather than simultaneous visible UI sessions.

## Implementation Notes

- Keep MIT attribution if code is reused.
- Prefer stable AX attributes over visible labels where available.
- Add a label map for English/Portuguese/Chinese UI strings instead of hardcoding button names.
- Add diagnostic commands before high-level behavior: tree dump, button list, conversation candidate dump.
- Treat Accessibility permission and WindowServer/display availability as first-class status fields.
