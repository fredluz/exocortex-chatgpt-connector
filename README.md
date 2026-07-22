# Exocortex ChatGPT Connector

Browser-backed ChatGPT connector for MACX Exocortex workflows.

This version uses the ChatGPT web app through a persistent Chrome/Patchright browser session. The native macOS app controller remains in the repository as experimental code, but it is no longer the default runtime path.

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

## Documentation

Detailed maintenance and operations docs live in:

- [Architecture](docs/ARCHITECTURE.md)
- [Operations](docs/OPERATIONS.md)
- [E2E Verification](docs/E2E_VERIFICATION.md)

## Safety Model

The daemon creates one browser tab per async request, with one in-flight request per agent. Successful tabs are closed after the response is written to disk; error tabs are left open for inspection.

Browser state is stored under the shared Exocortex runtime home, so CLI, MCP, and daemon processes attach to the same authenticated session.

## Setup

Requirements:

- macOS
- Google Chrome installed
- Node.js 20+
- ChatGPT signed in once in the connector browser profile

Install the CLI link:

```bash
cd /Users/fredluz/Code/exocortex-chatgpt-connector
npm link
```

First run visible mode and sign in:

```bash
exocortex-chatgpt launch --visible
```

Leave that browser owner running, or let `submit` auto-start an off-screen owner
when no owner is already available.

Then verify:

```bash
exocortex-chatgpt check
```

Expected checks include the browser DOM selectors for the ChatGPT composer,
conversation, model switcher, and thinking controls.

## Async Flow

```bash
request_id=$(exocortex-chatgpt submit --agent "$MACX_AGENT" "Prompt text")
exocortex-chatgpt status "$request_id"
exocortex-chatgpt fetch "$request_id"
```

Queued submissions start a fresh ChatGPT conversation by default. Pass
`--no-fresh` only when a request should intentionally continue the currently
selected conversation.

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

Image requests default to Pro routing. Callers can still pass another visible
model name when they deliberately want to override that default.

## Browser Runtime

The browser controller uses Patchright with a persistent profile at:

```text
~/.exocortex/chatgpt/profile/
```

It writes the browser CDP endpoint to:

```text
~/.exocortex/chatgpt/cdp
```

Prompts are sent as-is; the connector does not inject request IDs or tracking
tokens into ChatGPT messages.

## MCP Tools

The MCP adapter exposes:

- `submit_pro`
- `submit_image`
- `query`
- `status`
- `fetch`

For agents, prefer `submit_pro` / `submit_image` plus direct file reads from the returned paths. `submit_image` uses Pro by default.

## State

All connector state lives under `$EXOCORTEX_HOME/chatgpt/`, defaulting to:

```text
~/.exocortex/chatgpt/
```

This repo uses `MACX_AGENT` for per-agent output routing.

## License

MIT
