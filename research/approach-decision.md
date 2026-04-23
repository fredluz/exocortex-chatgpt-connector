# ChatGPT Connector: Approach Decision

Date: Thursday, April 23, 2026

## Goal

Replace the Chrome/Patchright-based ChatGPT MCP connector with something lighter and more stable. Two capabilities required:
1. GPT-5 Pro reasoning ($200/mo flat fee, not available via API)
2. Image generation + image retrieval

## Approaches Investigated

### 1. Direct Private API (HTTP client)

**Status: Blocked**

Reverse-engineered the ChatGPT.app binary. Found all API endpoints (see `chatgpt-private-api-reverse-eng.md`). The app uses:
- Native OAuth/Auth0 (not web session tokens)
- Keychain access group `2DC432GLL2.com.openai.shared` (only OpenAI-signed binaries can read)
- App Attest / device attestation (`/ios/attestation_challenge`, `/ios/verify_attestation`)
- Sentinel/conduit tokens (`openai-sentinel-chat-requirements-token`, `x-conduit-token`)
- Certificate pinning (`CertificatePinningSessionTaskDelegate`)

No plaintext access or refresh token found anywhere accessible to a third-party process. Cookies alone don't authenticate (tested: `/api/auth/session` returns empty `accessToken`).

**Verdict:** Can't build a standalone HTTP client without solving auth, attestation, and pinning.

### 2. Headless App Bundle (stripped ChatGPT.app)

**Status: Blocked by signing**

Found `IntentService` API inside `ChatGPT.framework` (see `headless-chatgpt-app.md`):
```
IntentService.activeAccountIntentService() throws -> IntentService
IntentService.submit(prompt:retryCount:) async throws -> SendableMessage
SendableMessage.text: String
SendableMessage.messageId: String
SendableMessage.conversationId: String
```

Framework can be `dlopen`'d. But auth tokens are in OpenAI's keychain access group — a re-signed or third-party app can't access them. A stripped bundle would load the code but fail to authenticate.

**Verdict:** Technically interesting but breaks the moment you need a different code signature.

### 3. App Shortcuts / AskIntent

**Status: Promising but limited**

ChatGPT exposes an `AskIntent` App Intent for Siri Shortcuts. Could be invoked via `shortcuts run` from CLI. However:
- No model selection parameter found (can't target Pro specifically)
- No image generation support through this path
- May show UI prompts

**Verdict:** Could work for basic chat but doesn't cover our two core requirements (Pro model, images).

### 4. Traffic Interception (Proxyman/mitmproxy)

**Status: In progress**

Proxyman installed and system proxy active. Currently only seeing CONNECT tunnels (encrypted). Need to:
- Install and trust the Proxyman CA certificate (waiting on Fred)
- Test if certificate pinning blocks decryption of chatgpt.com traffic
- If decrypted: capture full auth token + API format, build replay client

**Verdict:** Pending test. If pinning doesn't apply to conversation endpoints, this gives us everything — token capture + API format = pure HTTP client. If pinning blocks it, dead end.

### 5. AX/Accessibility Automation (ChatGPT desktop app)

**Status: Working implementation, needs AX permission**

Native controller implemented (`native-controller.mjs`, commit `cbc0bc9`). Architecture:
- Serial UI queue for all AX operations (create chat, type, send, switch, read)
- Parallel generation across multiple conversations in background
- Completion detection via switch-and-probe (check for stop button)
- Request ID in conversation title for mapping

Reference implementation: `toby1991/chatgpt-cli` (Go + AXUIElement). Cloned at `~/Code/chatgpt-cli`.

Blocker: tmux server was started before Accessibility permission was granted. New tmux sessions still inherit old permission state. Need tmux server restart.

**Verdict:** Most practical path. Reuses the real app's auth. Lower RAM than Chrome. Supports Pro mode, image gen, model selection — all via the same UI the user sees.

## Decision Matrix

| Approach | Pro Model | Image Gen | Auth | RAM | Stability | Status |
|----------|-----------|-----------|------|-----|-----------|--------|
| Direct API | ? | ? | Blocked | 0 | Brittle | Dead |
| Headless App | ? | ? | Blocked | Low | Unknown | Dead |
| App Shortcuts | No control | No | Works | 0 | Good | Limited |
| Proxy Intercept | Yes | Yes | Captured | 0 | Brittle | Testing |
| AX Automation | Yes | Yes | Reused | ~200MB | Medium | Ready |

## Recommended Path

**Primary: Traffic interception (if cert pinning doesn't block)**
- Zero overhead, pure HTTP, parallel by default
- Token refresh is the ongoing risk

**Fallback: AX automation**
- Already implemented, just needs AX permission + E2E validation
- More overhead than HTTP but way less than Chrome
- `HIDE_MAIN_WINDOW_ON_LAUNCH` key found in app — could run invisibly

## Files

| File | Contents |
|------|----------|
| `chatgpt-private-api-reverse-eng.md` | Full binary analysis, API endpoints, auth flow, keychain |
| `headless-chatgpt-app.md` | IntentService API, framework loading, build paths |
| `parallel-native-architecture.md` | Serial UI queue + parallel generation design |
| `axuielement-chatgpt-cli-prep.md` | Reference Go implementation notes |
| `native-mcp-handoff.md` | Current native controller handoff doc |
| `e2e-test-results.md` | AX permission blocker documentation |
