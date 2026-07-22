# E2E Verification

This document defines the end-to-end test plan for the browser backend. Run it after changes to browser automation, selectors, daemon scheduling, mailbox persistence, MCP tools, model routing, or image handling.

## Last Known Good Manual Run

Date: 2026-04-23

Environment:

- Backend: browser/Patchright
- Browser status: `state=ready model=Pro thinking=Extended`
- Daemon pid: `15909`
- Unit tests: `55/55` passing

Verified flows:

- Pro text request returned `7`.
- Parallel Pro text requests returned `42` and `54`.
- Parallel Pro image request produced a valid PNG:

```text
/Users/fredluz/.exocortex/chatgpt/e2e-images/20260423-202315/01.png
PNG image data, 1254 x 1254, 8-bit/color RGB, non-interlaced
```

Parallel request ids:

```text
1776972195179-ea5e-codex_parallel_a
1776972195253-a200-codex_parallel_b
1776972195337-3002-codex_parallel_img
```

All three started at `2026-04-23T19:23:15Z`, proving concurrent tab execution across agents.

## What Must Be Tested

Minimum required flows:

1. Unit suite.
2. Browser status and selector check.
3. CLI async Pro text submit/fetch.
4. CLI async Pro image submit/fetch with real PNG file verification.
5. Parallel requests across multiple agents.
6. Same-agent serialization.
7. MCP stdio tool surface and `status`/`fetch`.
8. Notification routing invocation.
9. Queue cleanup after completion.
10. Prompt cleanliness, meaning no injected request IDs or tracking tokens.

## Preflight

From the repo:

```bash
cd /Users/fredluz/Code/exocortex-chatgpt-connector
npm test
```

Expected:

```text
pass 55
fail 0
```

Check daemon and queue:

```bash
pgrep -fl 'cli.mjs daemon|launcher.mjs|ExocortexChatGPTDaemon' || true
find ~/.exocortex/chatgpt/requests -maxdepth 1 -type f -name '*.json' -print 2>/dev/null | sort
```

The request list should be empty before a clean E2E run.

Check browser status:

```bash
exocortex-chatgpt status
```

Expected:

```text
state=ready
```

The current model and thinking text can vary, but for Pro tests it should usually show Pro after model routing.

Run selector check:

```bash
exocortex-chatgpt check
```

Expected: critical composer, conversation, model, and thinking selectors should resolve.

## Text E2E

Submit:

```bash
rid=$(exocortex-chatgpt submit --agent codex_text_e2e --model pro --thinking extended "What is 3 plus 4? Answer with only the number.")
echo "$rid"
```

Poll:

```bash
for i in {1..90}; do
  out=$(exocortex-chatgpt fetch "$rid")
  echo "$out"
  echo "$out" | grep -q '"complete":true' && break
  sleep 2
done
```

Expected:

```json
{"text":"7","files":[],"complete":true}
```

Check persisted status:

```bash
exocortex-chatgpt status "$rid"
```

Expected:

```json
{"state":"complete","agent":"codex_text_e2e","elapsed_ms":...}
```

## Image E2E

Submit:

```bash
outdir="$HOME/.exocortex/chatgpt/e2e-images/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$outdir"
rid_img=$(exocortex-chatgpt submit \
  --agent codex_image_e2e \
  --mode image \
  --model pro \
  --output-dir "$outdir" \
  "Create a simple square PNG icon of a blue lighthouse on a white background. No text.")
echo "$rid_img"
echo "$outdir"
```

Poll:

```bash
for i in {1..180}; do
  out=$(exocortex-chatgpt fetch "$rid_img")
  echo "$out"
  echo "$out" | grep -q '"complete":true' && break
  sleep 3
done
```

Verify files:

```bash
find "$outdir" -maxdepth 1 -type f -print -exec file {} \;
```

Expected:

- `fetch` returns `complete:true`.
- `files` contains at least one file.
- `file` reports PNG, JPEG, WebP, GIF, or AVIF image data.
- For PNG files, `mailbox.verifyResponseFiles()` also checks PNG magic bytes.

## Parallel E2E

This verifies multi-agent concurrency and Pro image routing in the same batch.

Run:

```bash
set -euo pipefail
outdir="$HOME/.exocortex/chatgpt/e2e-images/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$outdir"

rid_a=$(exocortex-chatgpt submit --agent codex_parallel_a --model pro --thinking extended "What is 11 plus 31? Answer with only the number.")
rid_b=$(exocortex-chatgpt submit --agent codex_parallel_b --model pro --thinking extended "What is 9 times 6? Answer with only the number.")
rid_img=$(exocortex-chatgpt submit --agent codex_parallel_img --mode image --model pro --output-dir "$outdir" "Create a simple square PNG icon of a blue lighthouse on a white background. No text.")

printf 'TEXT_A=%s\nTEXT_B=%s\nIMAGE=%s\nOUTDIR=%s\n' "$rid_a" "$rid_b" "$rid_img" "$outdir"

for i in {1..180}; do
  a=$(exocortex-chatgpt fetch "$rid_a")
  b=$(exocortex-chatgpt fetch "$rid_b")
  img=$(exocortex-chatgpt fetch "$rid_img")
  printf 'poll=%s\nA=%s\nB=%s\nIMG=%s\n' "$i" "$a" "$b" "$img"
  echo "$a" | grep -q '"complete":true' && ca=1 || ca=0
  echo "$b" | grep -q '"complete":true' && cb=1 || cb=0
  echo "$img" | grep -q '"complete":true' && ci=1 || ci=0
  if [[ "$ca$cb$ci" == "111" ]]; then break; fi
  sleep 3
done

find "$outdir" -maxdepth 1 -type f -print -exec file {} \;
```

Expected:

- A returns `42`.
- B returns `54`.
- Image returns `complete:true` and at least one image file.
- Response JSON files show close or identical `started_at` timestamps for distinct agents.

Inspect response metadata:

```bash
for rid in "$rid_a" "$rid_b" "$rid_img"; do
  printf '\n=== %s ===\n' "$rid"
  find ~/.exocortex/chatgpt/agents -name "$rid.json" -print -exec cat {} \;
done
```

Parallelism is confirmed when `started_at` values overlap and `finished_at` values differ.

## Same-Agent Serialization

This verifies that two requests for the same agent do not run concurrently.

Submit:

```bash
rid_1=$(exocortex-chatgpt submit --agent codex_serial --model pro --thinking extended "Wait briefly, then answer ONE.")
rid_2=$(exocortex-chatgpt submit --agent codex_serial --model pro --thinking extended "Answer TWO.")
echo "$rid_1"
echo "$rid_2"
```

Poll both to completion:

```bash
for i in {1..180}; do
  one=$(exocortex-chatgpt fetch "$rid_1")
  two=$(exocortex-chatgpt fetch "$rid_2")
  echo "$one"
  echo "$two"
  echo "$one" | grep -q '"complete":true' && c1=1 || c1=0
  echo "$two" | grep -q '"complete":true' && c2=1 || c2=0
  if [[ "$c1$c2" == "11" ]]; then break; fi
  sleep 3
done
```

Inspect metadata:

```bash
for rid in "$rid_1" "$rid_2"; do
  find ~/.exocortex/chatgpt/agents/codex_serial/pro -name "$rid.json" -print -exec cat {} \;
done
```

Expected:

- Both complete.
- `rid_2.started_at` is after `rid_1.finished_at` or at least after the first request has left the in-flight map.
- This proves `inFlightByAgent` is working.

## MCP Stdio Smoke

This checks the real MCP server without submitting new ChatGPT traffic.

```bash
node --input-type=module <<'NODE'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'exocortex-chatgpt',
  args: ['server'],
  env: { ...process.env, EXOCORTEX_HOME: '/Users/fredluz/.exocortex' },
});

const client = new Client({ name: 'e2e-smoke', version: '0.0.0' });
await client.connect(transport);
const tools = await client.listTools();
console.log(tools.tools.map(t => t.name));
await client.close();
NODE
```

Expected tools:

```text
query
submit_pro
submit_image
status
fetch
```

To test `status` and `fetch`, use a known completed request id:

```bash
node --input-type=module - "$rid_a" <<'NODE'
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const requestId = process.argv[2];
const transport = new StdioClientTransport({
  command: 'exocortex-chatgpt',
  args: ['server'],
  env: { ...process.env, EXOCORTEX_HOME: '/Users/fredluz/.exocortex' },
});

const client = new Client({ name: 'e2e-smoke', version: '0.0.0' });
await client.connect(transport);
console.log(await client.callTool({ name: 'status', arguments: { request_id: requestId } }));
console.log(await client.callTool({ name: 'fetch', arguments: { request_id: requestId } }));
await client.close();
NODE
```

## Notification Routing Smoke

This verifies routing invocation without needing a live MACX tmux agent:

```bash
node --input-type=module <<'NODE'
import { notifyAgentIfAvailable } from './mailbox.mjs';

const calls = [];
const ok = await notifyAgentIfAvailable('codex_parallel_a', 'notify-smoke', 'done', {
  scriptPath: '/Users/fredluz/.clawd/bin/route-response.sh',
  useResponseRouter: true,
  responsePath: '/tmp/notify-smoke.json',
  requestBrief: 'notification smoke',
  runner: async (scriptPath, args) => calls.push({ scriptPath, args }),
});

console.log(JSON.stringify({ ok, calls }, null, 2));
NODE
```

Expected:

- `ok` is `true`.
- `scriptPath` is `/Users/fredluz/.clawd/bin/route-response.sh`.
- args are `[agent, response_path, message]`.

To verify delivery to a live MACX agent, run the same flow with an actual live agent name and confirm the message appears in that agent session.

## Prompt Cleanliness Check

The connector must not inject request ids, sentinels, or tracking tokens into the ChatGPT prompt.

Manual check:

1. Run a short E2E prompt.
2. Inspect the ChatGPT browser tab.
3. Confirm the visible user message contains only the prompt text.

Code check:

```bash
rg -n "Tracking token|Request ID:|ECX_REQUEST_ID|key code 40|searchText" . --glob '!node_modules/**' --glob '!build/**'
```

Expected:

- No active browser runtime code should insert these into prompts.
- Native experimental code may still contain internal ids, but it must not be on the default runtime path.

## Queue Cleanup Check

After all E2E requests complete:

```bash
find ~/.exocortex/chatgpt/requests -maxdepth 1 -type f -name '*.json' -print 2>/dev/null | sort
```

Expected: no output.

## Failure Evidence to Capture

When an E2E flow fails, capture:

```bash
exocortex-chatgpt status
pgrep -fl 'cli.mjs daemon|launcher.mjs|Google Chrome'
find ~/.exocortex/chatgpt/requests -maxdepth 1 -type f -name '*.json' -print
find ~/.exocortex/chatgpt/agents -name '<request_id>.json' -print -exec cat {} \;
```

For image failures:

```bash
find <image_dir> -maxdepth 1 -type f -print -exec file {} \;
```

For browser selector failures:

```bash
exocortex-chatgpt check
```

Leave error tabs open until the cause is understood.
