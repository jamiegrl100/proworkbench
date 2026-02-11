# Security

Proworkbench is built as a local-first admin console. This doc describes what PB does (and does not) do for security in Preview v0.1.

## Summary
- **Local-only by default**: PB binds to `127.0.0.1` by default.
- **Header-token admin auth**: `Authorization: Bearer <token>` (no cookies).
- **WebChat-only execution**: tools and MCP are executed only from the Web Admin UI.
- **Social channels are chat-only**: Telegram/Slack do not execute tools/MCP, permanently blocked server-side.

## Admin auth model
PB uses a bearer token stored client-side:
- Browser: `localStorage.pb_admin_token`
- Requests: `Authorization: Bearer <token>`

> [!WARNING]
> Treat the admin token like a password. Anyone with the token can access your PB admin console on this machine.

## Secret handling
- Secrets are stored in the PB data directory `.env` file (not in exported reports).
- PB should never echo secret values back to UI.
- Support reports should show “present/missing” instead of raw values.

## Execution boundaries (hard rules)
**Allowed to execute**
- WebChat (Web Admin UI), when policy allows and approvals are satisfied.

**Not allowed to execute**
- Telegram
- Slack
- Any other “social” channel

If a social channel attempts execution, PB must reject it (HTTP 403) and return a friendly message.

## Remote access support policy
PB is designed for local use.
- Supported: access over a private network you control (VPN, tailnet, LAN with firewall).
- Not supported: exposing PB directly to the public internet.

## Threat model (Preview)
PB aims to prevent:
- accidental execution from social channels
- accidental “one click” dangerous actions without approvals
- secret leaks in routine UI views and reports

PB does not aim (yet) to provide:
- OS-level sandboxing or kernel-enforced isolation
- an attacker-resistant “zero trust” remote deployment model

