# Release checklist (Preview)

This is a lightweight checklist for cutting a Preview release.

## Before release
- `npm install`
- `npm run build`
- `npm run i18n:audit`
- Quick UI click-through:
  - Status, Diagnostics, Doctor
  - Runtime (Text WebUI status + models)
  - WebChat (basic chat)
  - Tools (policy visible, block-by-default)
  - Approvals (loads, actions work)
  - MCP Servers (templates visible, create/test/start/stop/logs)
  - Canvas (items persist)

## Safety checks
- Confirm PB binds to `127.0.0.1` by default.
- Confirm Telegram/Slack are chat-only and cannot execute tools/MCP.
- Confirm tool execution is server-side and WebChat-only.

## Release artifacts
- Update `CHANGELOG.md`.
- Tag the release (Preview).
- Create GitHub Release notes and include:
  - “Text WebUI manual start” steps
  - known-good model string
  - breaking changes (if any)

