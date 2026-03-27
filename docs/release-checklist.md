# Release checklist (Preview)

This is a lightweight checklist for cutting a Preview release.

## Before release
- `npm ci`
- `npm --prefix desktop ci`
- `npm run build`
- `npm run i18n:audit`
- `npm run release:build:linux`
- Push the release tag (for example `v0.1.1`) so GitHub Actions builds Windows and macOS installers on native runners.
- Quick UI click-through:
  - Status, Diagnostics, ER+
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
- Update `RELEASE_NOTES.md`.
- Tag the release (`vX.Y.Z`).
- Confirm artifacts exist in `release/` with names like `proworkbench-vX.Y.Z-linux.*`, `proworkbench-vX.Y.Z-windows.*`, and `proworkbench-vX.Y.Z-macos.*`.
- Create GitHub Release notes and include:
  - “Text WebUI manual start” steps
  - known-good model string
  - breaking changes (if any)
