# Contributing

Project status: **Preview (v0.1)**.

## Development setup
```bash
cd /home/jamiegrl100/Apps/proworkbench
npm install
npm run dev
```

PB server: `http://127.0.0.1:8787`  
PB UI dev: `http://127.0.0.1:5173`

## PR checklist
- UI builds: `npm -w ui run build`
- Docs updated for user-visible behavior changes
- Security boundaries respected:
  - tools/MCP are WebChat-only
  - social channels are chat-only
  - no cookies/CSRF for admin

## Docs
- Docs live in `docs/`.
- Mermaid diagrams are preferred for flows.
- If a feature is not shipped, label it **Planned**.

## Suggested labels (guidance)
- `bug`: user-visible problem or regression
- `security`: security boundary, auth, approvals, or execution constraints
- `docs`: documentation only
- `ui`: frontend changes
- `server`: backend changes
- `good first issue`: small, well-scoped starter work

