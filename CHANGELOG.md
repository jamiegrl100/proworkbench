# Changelog

## v0.1 (Preview)
- Persistent Memory v0 (workspace-file based): daily scratch + summary memory, bounded memory context injection on every LLM call, finalize-day redaction with durable patch proposals for `MEMORY.md`/`MEMORY_ARCHIVE`, and admin Memory page.
- Local-first admin console (UI + server + SQLite)
- Text Generation WebUI provider integration (manual start, port 5000)
- WebChat
- Tools with policy + proposals + server-side execution
- Unified approvals queue (tools + MCP actions)
- MCP Servers manager with 15 presets
- Doctor “Fix my setup”
- Canvas (persistent output surface)
- Canvas writes are internal (no approvals). Filesystem writes use `workspace.write_file` (approval-gated).
- Telegram Sandbox Build mode (feature-flagged): safe project generation inside `PB_WORKDIR/telegram/<chat_id>/<project_slug>`, with run/install requests queued as Web Admin approvals.
