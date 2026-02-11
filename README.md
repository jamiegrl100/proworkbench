# Docs

Proworkbench documentation (Preview v0.1).

> [!NOTE]
> These docs prioritize non-technical, step-by-step guidance. Advanced sections exist, but are optional.

## Table of contents
- Getting started: `docs/getting-started.md`
- Doctor: `docs/doctor.md`
- Tools and approvals: `docs/tools-and-approvals.md`
- MCP servers: `docs/mcp-servers.md`
- Canvas: `docs/canvas.md`
- Smoke test checklist: `docs/smoke-test.md`
- Security: `docs/security.md`
- Troubleshooting: `docs/troubleshooting.md`
- Architecture (diagrams): `docs/architecture.md`
- Roadmap: `docs/roadmap.md`
- Release checklist (Preview): `docs/release-checklist.md`
- Website copy notes: `docs/website-copy.md`
- Writing style guide: `docs/STYLE-GUIDE.md`

## How to update docs
1. Edit markdown in `docs/`.
2. Keep steps short and literal (copy/paste commands, exact URLs, and expected outputs).
3. Prefer diagrams using Mermaid in fenced blocks (` ```mermaid `).
4. If a feature is not shipped yet, label it **Planned** (do not imply it exists).
5. Before shipping a preview build, run every step in `docs/smoke-test.md`.
