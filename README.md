# pi-codex-cua

A [pi](https://pi.dev) package that exposes OpenAI Codex desktop's native
macOS Computer Use implementation (`@oai/sky`) as normal pi tools.

This does not reimplement mouse or accessibility automation. It starts Codex's
signed `SkyComputerUseClient` bridge through Codex's signed sandbox runner,
sends Codex-compatible turn metadata, and returns Sky's accessibility text and
screenshots as pi tool results.

## Requirements

- macOS
- A current ChatGPT/Codex desktop app in `/Applications/ChatGPT.app`
- Codex Computer Use installed and granted Accessibility and Screen Recording
  permissions
- pi 0.83 or newer

## Install

```bash
pi install git:github.com/manaflow-ai/pi-codex-cua
```

The package then loads automatically from pi's `packages` setting. It works
alongside [`manaflow-ai/pi-codex`](https://github.com/manaflow-ai/pi-codex).

## Tools

The package matches the current macOS Sky surface:

- `list_apps`
- `get_app_state`
- `click`
- `drag`
- `perform_secondary_action`
- `press_key`
- `scroll`
- `select_text`
- `set_value`
- `type_text`

`get_app_state` returns indexed accessibility text plus the actual screenshot.
Coordinates are relative to that app-window screenshot, with a top-left origin.
Action tools execute sequentially. After an action, inspect the app again
instead of reusing stale element indexes.

## Runtime overrides

Most users need none. Development and nonstandard installations can set:

- `PI_CODEX_CUA_CLIENT`
- `PI_CODEX_CUA_CODEX`
- `PI_CODEX_CUA_SERVICE`
- `PI_CODEX_CUA_SOCKET_DIRECTORY`
- `PI_CODEX_CUA_TOOL_TIMEOUT_MS` (defaults to 30000)
- `PI_CODEX_CUA_INITIALIZE_TIMEOUT_MS` (defaults to 15000)

Every Computer Use tool has a watchdog. If Sky hangs on an app approval,
security advisory, or accessibility request, the call fails with a timeout and
the MCP bridge restarts so the next tool call is not blocked behind it.

## Protocol parity

The implementation follows Codex desktop's Sky path, not the separate public
Responses API `{ "type": "computer" }` protocol. The package preserves:

- the complete current macOS Sky action names and argument shapes
- one persistent Sky client per pi session
- Codex MCP `_meta["x-codex-turn-metadata"]`
- Sky's app approval, permission, blocked-URL, and screen-lock errors
- accessibility-tree diffs and full-tree requests
- screenshot image content in model context and pi's TUI

The public `openai/codex` repository currently declares the stable
`computer_use` feature and bundled plugin but does not contain the private
macOS Sky implementation. This package intentionally loads that implementation
from the installed first-party desktop runtime.

## Development

```bash
npm install
npm run check
npm test
```
