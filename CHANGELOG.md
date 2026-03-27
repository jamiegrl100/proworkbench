# Changelog

## v0.1.2
- Re-ran the desktop release from the fixed Windows/macOS/Linux packaging pipeline so GitHub Actions can publish all three platform artifacts from the corrected source.
- Fixed the Windows GitHub Actions packaging runner so release builds invoke `npm.cmd` correctly on `windows-latest`.

## v0.1.1
- Fixed Alex Factory Reset so it clears user memory, history, session state, and temporary workspace data without deleting MCP servers, tool definitions, provider configuration, or the memory system itself.
- Factory Reset now returns auth to first-run setup by clearing the stored admin password and active admin tokens while preserving the rest of the application infrastructure.
- Added standardized desktop release packaging for Linux, Windows, and macOS with normalized artifact names in `release/`.
- Added tag-driven GitHub Actions release automation so pushing `v*` builds the same installers and uploads them as workflow artifacts and release assets.

## v0.1 (Preview)
- Persistent Memory v0 (workspace-file based): daily scratch + summary memory, bounded memory context injection on every LLM call, finalize-day redaction with durable patch proposals for `MEMORY.md`/`MEMORY_ARCHIVE`, and admin Memory page.
- Local-first admin console (UI + server + SQLite)
- Text Generation WebUI provider integration (manual start, port 5000)
- WebChat
- Tools with policy + proposals + server-side execution
- Unified approvals queue (tools + MCP actions)
- MCP Servers manager with 15 presets
- ER+ “Fix my setup”
- Canvas (persistent output surface)
- Canvas writes are internal (no approvals). Filesystem writes use `workspace.write_file` (approval-gated).
- Telegram Sandbox Build mode (feature-flagged): safe project generation inside `PB_WORKDIR/telegram/<chat_id>/<project_slug>`, with run/install requests queued as Web Admin approvals.
