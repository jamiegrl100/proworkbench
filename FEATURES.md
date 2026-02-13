# Proworkbench Features (Source of Truth)

## Shipped (code-confirmed)
- Local-first Text Generation WebUI provider integration (`127.0.0.1:5000`, manual start).
- WebChat with proposal -> explicit Invoke execution flow.
- Tool policy with block-by-default posture and per-risk/per-tool controls.
- Unified approvals for tool runs and MCP lifecycle actions.
- MCP Servers manager with seeded templates.
- Doctor self-check/fix workflow.
- Canvas persistent command-center cards (display/organize only; no execution).
- Helper swarm (power user), bounded and server-gated.
- Persistent Memory v0 (workspace-file memory flow in current runtime path).
- Watchtower idle-only proactive checks with proposal-only output.
- Telegram allowlist + sandbox build mode (feature-flagged), with social execution hard-block.
- Slack/Telegram chat-only policy for tools/MCP execution.

## Planned / Partial
- Installer/distribution polish and broader packaging flow.
- Expanded memory retention/export tooling beyond current v0 flow.
- Additional Watchtower presets/templates and richer operator reporting.

## Core links
- Docs index: `docs/README.md`
- Security model: `docs/security.md`
- Tools + approvals: `docs/tools-and-approvals.md`
- MCP servers: `docs/mcp-servers.md`
- Canvas: `docs/canvas.md`
- Doctor: `docs/doctor.md`
- Memory: `docs/MEMORY.md`
- Watchtower: `docs/watchtower.md`
