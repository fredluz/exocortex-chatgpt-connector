# Operations

This document explains how to install, run, use, and troubleshoot the connector.

## Requirements

- macOS
- Google Chrome installed
- Node.js 20 or newer
- ChatGPT account signed in through the connector browser profile
- Optional: MACX/Clawd agent routing scripts for notifications

The production backend uses Patchright to automate Chrome. It does not require macOS Accessibility permissions.

## Install

From the repository:

```bash
cd /Users/fredluz/Code/exocortex-chatgpt-connector
npm install
npm link
```

Verify the CLI is on PATH:

```bash
which exocortex-chatgpt
exocortex-chatgpt status
```

## Runtime Home

Default runtime home:

```text
~/.exocortex/chatgpt/
```

With `EXOCORTEX_HOME`:

```bash
export EXOCORTEX_HOME=/Users/fredluz/.exocortex
```

The connector then stores state in:

```text
$EXOCORTEX_HOME/chatgpt/
```

Important paths:

```text
requests/                         queued request JSON
agents/<agent>/pro/               response JSON
agents/<agent>/images/            default per-agent image output
profile/                          browser profile
cdp                               browser CDP endpoint
daemon.pid                        daemon pid claim
```

Compatibility fallback:

If `~/.exocortex/chatgpt/profile` does not exist but `~/.chatgpt-mcp/profile` does, the connector reuses the old `~/.chatgpt-mcp/profile`. The same fallback applies to the old `~/.chatgpt-mcp/cdp` file.

## First Login

Run a visible browser owner:

```bash
exocortex-chatgpt launch --visible
```

Sign in to ChatGPT in the opened Chrome window. Leave the process running while using the connector.

After login:

```bash
exocortex-chatgpt status
```

Expected shape:

```text
state=ready model=Pro thinking=Extended
```

Exact model and thinking values can differ depending on the currently selected ChatGPT UI state.

## Running the Daemon

The daemon can be started explicitly:

```bash
exocortex-chatgpt daemon
```

Most users do not need to start it manually. `submit` and MCP tools call `ensureDaemonRunning()`, which starts the daemon if no live daemon pid exists.

Check the daemon:

```bash
pgrep -fl 'cli.mjs daemon'
cat ~/.exocortex/chatgpt/daemon.pid
```

Stop the daemon:

```bash
pkill -f '/Users/fredluz/Code/exocortex-chatgpt-connector/cli.mjs daemon'
```

Do not kill Chrome unless you intentionally want to reset the browser owner.

## CLI Usage

Status:

```bash
exocortex-chatgpt status
```

Submit async Pro text:

```bash
rid=$(exocortex-chatgpt submit --agent "$MACX_AGENT" --model pro --thinking extended "Analyze this code path...")
echo "$rid"
```

Fetch async result:

```bash
exocortex-chatgpt status "$rid"
exocortex-chatgpt fetch "$rid"
```

Submit async Pro image:

```bash
outdir="$HOME/Desktop/chatgpt-image-test"
rid=$(exocortex-chatgpt submit --agent "$MACX_AGENT" --mode image --model pro --output-dir "$outdir" "Create a simple PNG icon of a blue lighthouse on white.")
echo "$rid"
```

Blocking query:

```bash
exocortex-chatgpt query --model pro --thinking extended "What are the tradeoffs?"
```

Blocking image command:

```bash
exocortex-chatgpt image --model pro --output-dir "$HOME/Desktop/chatgpt-image-test" "Create a simple PNG icon."
```

Open a new ChatGPT conversation in the singleton browser page:

```bash
exocortex-chatgpt new
```

Set model or thinking on the singleton page:

```bash
exocortex-chatgpt model pro
exocortex-chatgpt thinking extended
```

Run selector checks:

```bash
exocortex-chatgpt check
```

## Fresh Conversation Behavior

Queued requests default to fresh conversations:

```bash
exocortex-chatgpt submit --agent alpha "Fresh conversation by default"
```

To intentionally continue the current conversation:

```bash
exocortex-chatgpt submit --agent alpha --no-fresh "Continue the current conversation"
```

Agents should almost always use fresh conversations. Reusing conversations can leak context between tasks.

## MCP Setup

Codex config example:

```toml
[mcp_servers.chatgpt]
command = "exocortex-chatgpt"
args = ["server"]
env = { EXOCORTEX_HOME = "/Users/fredluz/.exocortex" }
```

Claude config example:

```json
{
  "mcpServers": {
    "chatgpt": {
      "command": "exocortex-chatgpt",
      "args": ["server"],
      "env": {
        "EXOCORTEX_HOME": "/Users/fredluz/.exocortex"
      }
    }
  }
}
```

Do not set `CHATGPT_MCP_DISABLE_AUTODAEMON=1` unless you deliberately want MCP submissions to queue without starting a worker.

## MCP Tool Use

Preferred text tool:

```json
{
  "tool": "submit_pro",
  "arguments": {
    "agent": "my_agent",
    "prompt": "Do deep analysis of this design."
  }
}
```

Preferred image tool:

```json
{
  "tool": "submit_image",
  "arguments": {
    "agent": "my_agent",
    "prompt": "Create a PNG icon of a blue lighthouse on white.",
    "output_dir": "/Users/fredluz/Desktop/images"
  }
}
```

Fetch:

```json
{
  "tool": "fetch",
  "arguments": {
    "request_id": "1776972195179-ea5e-codex_parallel_a"
  }
}
```

## Notifications to Agents

The daemon routes completion notifications through:

```text
~/.clawd/bin/route-response.sh
```

The router can forward to live MACX tmux sessions using:

```text
~/.clawd/bin/send-to-agent.sh
```

Check availability:

```bash
test -x ~/.clawd/bin/route-response.sh && echo route-response:present
test -x ~/.clawd/bin/send-to-agent.sh && echo send-to-agent:present
```

Notification failure does not lose the response. Always treat response JSON as the source of truth.

## Environment Variables

`EXOCORTEX_HOME`

Base Exocortex runtime home. Connector state lives under `$EXOCORTEX_HOME/chatgpt`.

`MACX_AGENT`

Default agent name when `--agent` is not supplied.

`CHATGPTPRO_CDP`

Explicit CDP endpoint. Example:

```bash
export CHATGPTPRO_CDP=http://127.0.0.1:9222
```

`CDP_PORT`

Port used by `launcher.mjs` when starting Chrome. Default: `9222`.

`CHATGPT_VISIBLE`

When set to `1`, auto-launched browser windows are visible and maximized. Otherwise they are off-screen.

`CHATGPT_MCP_ATTACH_ONLY`

When set to `1`, controller commands fail if they cannot attach to an existing browser owner. This is useful for debugging profile ownership.

`CHATGPT_MCP_DISABLE_AUTODAEMON`

When set to `1`, `submit` will not auto-start the daemon. Avoid this for normal MCP use.

`CHATGPT_MCP_DAEMON_POLL_MS`

Daemon request directory polling interval. Default: `250`.

## Common Problems

### `state=not_logged_in`

Run:

```bash
exocortex-chatgpt launch --visible
```

Sign in to ChatGPT in the browser profile, then retry:

```bash
exocortex-chatgpt status
```

### CDP endpoint is stale

Symptom:

```text
CDP connect failed: connect ECONNREFUSED 127.0.0.1:9222
```

This is not always fatal. If attach fails and attach-only mode is off, the controller launches a new persistent context.

If you want to clean stale CDP state:

```bash
rm -f ~/.exocortex/chatgpt/cdp ~/.chatgpt-mcp/cdp
```

Then relaunch:

```bash
exocortex-chatgpt launch --visible
```

### Daemon pid is stale

Check:

```bash
cat ~/.exocortex/chatgpt/daemon.pid
pgrep -fl 'cli.mjs daemon'
```

If the pid file points to a dead process, the next submit should clean it up. Manual cleanup:

```bash
rm -f ~/.exocortex/chatgpt/daemon.pid
```

### Request is stuck pending

Check daemon:

```bash
pgrep -fl 'cli.mjs daemon'
```

If no daemon exists:

```bash
exocortex-chatgpt daemon
```

Check request files:

```bash
find ~/.exocortex/chatgpt/requests -maxdepth 1 -type f -name '*.json' -print
```

### Request is active but never completes

Find the request JSON:

```bash
cat ~/.exocortex/chatgpt/requests/<request_id>.json
```

Look for an error tab in Chrome. Error tabs are intentionally kept open for inspection.

If you need to archive a bad request without deleting evidence:

```bash
stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p ~/.exocortex/chatgpt/archived-requests/$stamp
mv ~/.exocortex/chatgpt/requests/<request_id>.json ~/.exocortex/chatgpt/archived-requests/$stamp/
```

### Selector checks fail

Run:

```bash
exocortex-chatgpt check
```

If ChatGPT changed its DOM, update `selectors.json`. Keep selectors language-independent where possible, preferring `data-testid`, ids, roles, and structural attributes over visible text.

After changes:

```bash
npm test
exocortex-chatgpt check
```

### Image request completes with no files

Check the response:

```bash
exocortex-chatgpt fetch <request_id>
```

Check the output directory:

```bash
find <image_dir> -maxdepth 1 -type f -print -exec file {} \;
```

Possible causes:

- ChatGPT refused image generation.
- The prompt produced a text-only answer.
- The DOM changed and image candidates were not detected.
- Authenticated image download failed.

Error tabs should remain open for manual inspection if the daemon threw.

## Recovery Playbooks

### Cleanly restart daemon only

```bash
pkill -f '/Users/fredluz/Code/exocortex-chatgpt-connector/cli.mjs daemon' || true
rm -f ~/.exocortex/chatgpt/daemon.pid
exocortex-chatgpt daemon
```

### Cleanly restart browser owner

Stop daemon first:

```bash
pkill -f '/Users/fredluz/Code/exocortex-chatgpt-connector/cli.mjs daemon' || true
```

Close the connector Chrome window or terminate the owner process if you started it manually.

Remove stale endpoint:

```bash
rm -f ~/.exocortex/chatgpt/cdp ~/.chatgpt-mcp/cdp
```

Start visible:

```bash
exocortex-chatgpt launch --visible
```

### Archive all queued requests

Use this only when you intentionally want to stop current queued work:

```bash
stamp=$(date -u +%Y%m%dT%H%M%SZ)
dest="$HOME/.exocortex/chatgpt/archived-requests/$stamp"
mkdir -p "$dest"
find "$HOME/.exocortex/chatgpt/requests" -maxdepth 1 -type f -name '*.json' -exec mv {} "$dest/" \;
```

## Maintenance Rules

- Preserve prompt cleanliness. Do not inject request IDs or hidden markers into ChatGPT prompts.
- Preserve fresh-by-default queued requests.
- Preserve one active request per agent and parallelism across agents.
- Preserve disk-first image persistence.
- Keep successful tabs closing and error tabs open.
- Keep notification delivery best-effort only.
- Re-run the E2E plan after selector, model routing, image, daemon, or MCP changes.
