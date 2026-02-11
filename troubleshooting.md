# Troubleshooting

## PB server won’t start (port in use)
Error example: `EADDRINUSE 127.0.0.1:8787`

Fix:
1. Stop the other PB server process using port 8787.
2. Start PB again.

## UI shows 401 Unauthorized
Common causes:
- admin token missing from `localStorage.pb_admin_token`
- wrong token pasted

Fix:
1. Log out.
2. Paste the correct token.
3. If this is a fresh install, use the bootstrap token flow in the setup screen.

## Text WebUI not connected
Symptoms:
- Runtime says unreachable
- WebChat can’t list models

Fix:
1. Start Text WebUI manually:
   ```bash
   cd ~/Apps/text-generation-webui
   ./start_linux.sh --api --api-port 5000 --listen-host 127.0.0.1
   ```
2. Confirm `http://127.0.0.1:5000/v1/models` responds.

## Text WebUI connected but models list is empty
Cause: no model loaded.

Fix:
1. Open Text WebUI in a browser UI.
2. Load a model.
3. Refresh models in PB Runtime/Models.

Known-good model:
- `models/quen/qwen2.5-coder-7b-instruct-q6_k.gguf`

## “Needs approval”
If a tool or MCP action requires approval:
1. Open **Approvals**.
2. Approve or deny the pending item.
3. Go back and try again.

## Browser troubleshooting (Chrome recommended)

Proworkbench is tested primarily with **Google Chrome / Chromium** and Chrome is the **recommended** browser.

### Firefox issues (rare, but can happen)
If WebChat seems “stuck” (e.g., clicking **Send** does nothing, or UI behaves oddly), this is usually caused by Firefox site data/cache state during development builds.

Fixes (try in order):
1. **Try a Private Window** (Ctrl+Shift+P) and test again.
2. **Clear site data for PB**:
   - Firefox Settings → Privacy & Security → Cookies and Site Data → **Manage Data**
   - Remove entries for `127.0.0.1` (or your PB host)
   - Reload PB and log in again
3. In DevTools → Network, enable **Disable Cache** (while DevTools is open), then reload.
4. If you’re still blocked, use **Chrome/Chromium** (recommended) to confirm it’s not a server/provider issue.

### Why this matters
If PB works in Chrome but not Firefox, it’s almost always a browser/profile issue rather than a model/provider outage.
