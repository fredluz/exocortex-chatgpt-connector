# Exocortex ChatGPT Connector

MACX Exocortex integration for ChatGPT Pro. Built on [`chatgpt-mcp`](https://github.com/fredluz/chatgpt-mcp) with deeper multi-agent support. Designed to work alongside [`exocortex-subagent-management-mcp`](https://github.com/fredluz/exocortex-subagent-management-mcp) — the subagent orchestration layer that spawns, monitors, and communicates with AI agents.

## Part of the Exocortex Stack

```
┌─────────────────────────────────────────────┐
│  Your MCP Client (Claude Code, etc.)        │
├──────────────────────┬──────────────────────┤
│  exocortex-subagent- │  exocortex-chatgpt-  │
│  management-mcp      │  connector           │
│  ─────────────────── │  ──────────────────── │
│  Spawn AI agents     │  GPT-5 Pro reasoning │
│  Read/send messages  │  Image generation    │
│  Sleep/wake signals  │  Async submit/fetch  │
│  Agent registry      │  Per-agent routing   │
└──────────────────────┴──────────────────────┘
         │                       │
         ▼                       ▼
    tmux sessions          Chrome/ChatGPT
    (AI agents)            (GPT-5 Pro)
```

Both MCPs share `EXOCORTEX_HOME` (`~/.exocortex/`) and the agent identity system (`MACX_AGENT`). When a subagent spawned by the management MCP calls `submit_pro`, the connector automatically routes the response to that agent's output directory and wakes it when done.

## What This Adds Over chatgpt-mcp

| Feature | chatgpt-mcp | exocortex-chatgpt-connector |
|---------|-------------|----------------------------|
| State directory | `~/.chatgpt-mcp/` | `~/.exocortex/chatgpt/` |
| Config env var | `CHATGPT_MCP_HOME` | `EXOCORTEX_HOME` |
| Agent detection | Manual `agent` param | Auto from `MACX_AGENT` env var |
| Wake signals | `send-to-agent.sh` notify | Same, integrated by default |
| Output routing | `agents/<name>/pro/` | Same, auto-routed via `MACX_AGENT` |

If you're not running a multi-agent system, use [`chatgpt-mcp`](https://github.com/fredluz/chatgpt-mcp) instead — it's the same core with generic defaults.

## Setup

```bash
npm install -g exocortex-chatgpt-connector
exocortex-chatgpt launch --visible   # login once
exocortex-chatgpt launch             # headless daemon
```

Register in your MCP config:

```json
{
  "mcpServers": {
    "chatgpt": {
      "type": "stdio",
      "command": "exocortex-chatgpt",
      "args": ["server"]
    }
  }
}
```

## MACX_AGENT Auto-Detection

When `MACX_AGENT` is set (standard in agents spawned by `exocortex-subagent-management-mcp`), all tools automatically route output to that agent's directory:

```
~/.exocortex/chatgpt/agents/phillip/pro/     # Phillip's reasoning responses
~/.exocortex/chatgpt/agents/phillip/images/   # Phillip's generated images
~/.exocortex/chatgpt/agents/homer/pro/        # Homer's reasoning responses
```

No need to pass `agent` manually — the connector reads it from the environment.

## EXOCORTEX_HOME

All state lives under `$EXOCORTEX_HOME/chatgpt/` (defaults to `~/.exocortex/chatgpt/`). This keeps ChatGPT state alongside other exocortex services:

```
~/.exocortex/
├── chatgpt/          # This connector
│   ├── profile/      # Chrome session data
│   ├── requests/     # Pending async requests
│   ├── agents/       # Per-agent output dirs
│   └── daemon.pid
├── data/             # Subagent management MCP
│   └── session-store.json
└── ...
```

## MCP Tools (5)

Same tools as `chatgpt-mcp` — the interface is identical:

1. **`submit_pro`** — Async GPT-5 Pro with Extended Thinking. Returns `{ request_id, response_path }`.
2. **`submit_image`** — Async image generation. Returns `{ request_id, image_dir }`.
3. **`query`** — Sync one-shot (blocking). For interactive use.
4. **`status`** — Session or request status.
5. **`fetch`** — Retrieve async request results.

## Wake Signals

When an async request completes, the daemon calls `~/.clawd/bin/send-to-agent.sh` to notify the requesting agent. This integrates with the sleep/wake system from `exocortex-subagent-management-mcp` — sleeping agents get woken up when their ChatGPT results are ready, without polling.

## Prerequisites

- ChatGPT Pro subscription
- Chrome installed
- Node.js 20+
- [`exocortex-subagent-management-mcp`](https://github.com/fredluz/exocortex-subagent-management-mcp) (recommended)

## Relationship to chatgpt-mcp

This is the exocortex-branded distribution of [`chatgpt-mcp`](https://github.com/fredluz/chatgpt-mcp). The generic version works standalone with any MCP client. This version adds MACX-specific defaults and conventions for multi-agent orchestration.

## License

MIT
