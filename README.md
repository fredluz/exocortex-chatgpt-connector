# Exocortex ChatGPT Connector

Native macOS ChatGPT connector for MACX Exocortex workflows.

This version controls the ChatGPT macOS desktop app through Accessibility UI scripting. The old Chrome/Patchright backend is deprecated and has been removed from the executable path.

## Interface

The primary interface is the CLI:

```bash
exocortex-chatgpt status
exocortex-chatgpt daemon
exocortex-chatgpt submit --agent manfred "Analyze this..."
exocortex-chatgpt fetch <request_id>
exocortex-chatgpt query "Blocking one-shot prompt"
exocortex-chatgpt image "Generate an icon"
```

The MCP server still exists as an adapter for clients that want it:

```bash
exocortex-chatgpt server
```

## Safety Model

The daemon uses one serial UI queue. ChatGPT can generate in multiple background conversations, but only one operation can touch the visible app at a time.

Detailed restart/handoff notes live in:

```text
research/native-mcp-handoff.md
```

Read that file before running native end-to-end tests or starting the daemon from a new tmux session.

Native UI operations now follow two rules:

- If Accessibility permission is missing, the daemon refuses to activate or control ChatGPT.
- When a UI operation does activate ChatGPT, it restores the previously frontmost app in a `finally` path.

This means `submit` can safely queue a request even before Accessibility is granted, but the daemon will not run that request until permission is available.

## Setup

Requirements:

- macOS
- ChatGPT desktop app installed and signed in
- Node.js 20+
- Accessibility permission granted to the terminal/process running the daemon

Grant Accessibility permission in:

System Settings -> Privacy & Security -> Accessibility

Then verify:

```bash
exocortex-chatgpt check
```

Expected checks:

- `native.ax_trusted`
- `native.chatgpt_process`
- `native.notifications_db`

## Async Flow

```bash
request_id=$(exocortex-chatgpt submit --agent "$MACX_AGENT" "Prompt text")
exocortex-chatgpt status "$request_id"
exocortex-chatgpt fetch "$request_id"
```

`submit` writes a request file under:

```text
~/.exocortex/chatgpt/requests/
```

Completed responses are written under:

```text
~/.exocortex/chatgpt/agents/<agent>/pro/
```

Image outputs are written under:

```text
~/.exocortex/chatgpt/agents/<agent>/images/
```

## Notifications

The native daemon watches ChatGPT's registered macOS notification records as a completion hint. Request IDs are embedded in prompts so notification text or payloads can be matched when ChatGPT surfaces them.

Notifications are not the source of truth. They only move a request to the front of the probe queue. Final completion still requires a serial UI probe and response extraction.

## MCP Tools

The MCP adapter exposes:

- `submit_pro`
- `submit_image`
- `query`
- `status`
- `fetch`

For agents, prefer `submit_pro` / `submit_image` plus direct file reads from the returned paths.

## State

All connector state lives under `$EXOCORTEX_HOME/chatgpt/`, defaulting to:

```text
~/.exocortex/chatgpt/
```

This repo uses `MACX_AGENT` for per-agent output routing.

## License

MIT
