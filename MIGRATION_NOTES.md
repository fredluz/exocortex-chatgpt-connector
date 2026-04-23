# Migration Notes

The connector has moved from Chrome/Patchright automation to native ChatGPT macOS automation.

## Removed

- Browser controller
- Browser launcher
- DOM selectors
- Patchright dependency
- CDP/profile ownership model

## Added

- `native-controller.mjs`
- Serial native UI operations through macOS Accessibility/System Events
- ChatGPT notification database scanner for completion hints
- Request-id sentinels embedded into prompts
- Focus restoration after every native UI operation
- Hard refusal to activate/control ChatGPT when Accessibility permission is missing

## Operational Change

`submit` still creates a mailbox request and returns a request id. If Accessibility permission is missing, the daemon is not auto-started; the request remains queued until a permitted daemon is started.

Use:

```bash
exocortex-chatgpt check
exocortex-chatgpt daemon
```

The daemon must be run from a process that has Accessibility permission.
