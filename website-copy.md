# Website Copy Notes (Preview v0.1)

Use this as the source copy for `proworkbench.com` landing pages.

## Core positioning
- Local-first AI workspace for teams and solo builders.
- Safe-by-default: tools blocked until allowed, approvals for risky actions.
- WebChat-only execution: Telegram/Slack remain chat-only (notifications/inbox), no execution.

## Feature highlights
- Doctor self-heal checks with clear `OK / FIXED / NEEDS YOU / CAN'T FIX`.
- MCP presets gallery (15 templates) with Test/Start/Stop/Logs.
- Canvas command center with persistent cards for tools, MCP, Doctor, and helper outputs.
- Optional helper swarm (power user mode) with presets and budget mode.
- Telegram allowlist editor with silent-ignore behavior for unknown users.

## Runtime story
- Text WebUI is manual-start only on `127.0.0.1:5000`.
- PB probes status and models; it never auto-starts the model server.

## Safety copy (must stay explicit)
- Admin auth: header bearer token only.
- Telegram/Slack: chat-only, never tool/MCP execution.
- Social-origin execution attempts are hard-blocked server-side.
