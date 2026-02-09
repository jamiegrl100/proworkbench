# Proworkbench (scaffold)

This is a single-process local-first scaffold:
- Admin UI (Vite/React) in `ui/`
- Gateway server (Express) in `server/`
- SQLite storage
- Argon2id + cookie sessions + CSRF
- LLM provider adapters (OpenAI-compatible, Gateway, Anthropic)
- Telegram worker (gated by wizard completion)

References unpacked for analysis:
- `_reference_localbot/` (your previous UI bundle)
- `_reference_openclaw/` (OpenClaw source)

## Quick start

```bash
cd proworkbench-app
npm install
npm run dev
```

Server: http://127.0.0.1:8787  
UI dev: http://127.0.0.1:5173 (proxied to server)

## Data directory

Server stores data under a platform-specific directory:
- Linux: `~/.local/share/proworkbench/`
- macOS: `~/Library/Application Support/proworkbench/`
- Windows: `%APPDATA%\proworkbench\`

Secrets are stored in `.env` **only** (never echoed back).

## Dev (recommended)

```bash
npm install
npm run dev
```

If you run UI alone, you'll see Vite proxy ECONNREFUSED until the server is running.
