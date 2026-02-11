# Getting Started (10 minutes)

## What you’ll see
- A local PB admin UI at `http://127.0.0.1:5173`
- A local PB server at `http://127.0.0.1:8787`
- A “Doctor” page that tells you what is missing and how to fix it

## Prerequisites
- Node.js 20+ (recommended)
- Text Generation WebUI installed and runnable on the same machine

## Step 1: Start Proworkbench
From the repo root:

```bash
cd /home/jamiegrl100/Apps/proworkbench
npm install
npm run dev
```

Expected:
- Server binds to `127.0.0.1:8787`
- UI binds to `127.0.0.1:5173` (strict port)

## Step 2: Log in (admin token)
PB uses a header token for admin access:
- Header: `Authorization: Bearer <token>`
- Browser storage: `localStorage.pb_admin_token`

On a fresh install, PB provides a setup/bootstrap flow to create the first token.

> [!NOTE]
> PB does not use cookies or CSRF. Admin auth is header-token only.

## Step 3: Start Text Generation WebUI (manual)
PB does not start Text WebUI. Start it yourself in API mode:

```bash
cd ~/Apps/text-generation-webui
./start_linux.sh --api --api-port 5000 --listen-host 127.0.0.1
```

Expected API endpoint:
- `http://127.0.0.1:5000/v1/models`

## Step 4: Load a model
If `/v1/models` is empty, open the Text WebUI UI and load a model, then refresh PB.

Known-good model path (recommended):
- `models/quen/qwen2.5-coder-7b-instruct-q6_k.gguf`

## Step 5: Run Doctor
In PB, go to **Doctor**:
- Click **Fix my setup** (recommended)
- Or click **Run checks only**

Doctor will guide you to a green setup and tell you what PB can’t do automatically (for example: loading a model).

## Verify it works
1. In **Runtime**, confirm Text WebUI is reachable and models are listed.
2. In **WebChat**, send: `Say: ok`.
3. If tools/MCP are enabled, confirm:
   - execution is WebChat-only
   - risky actions go through Approvals

## Browser support

Proworkbench is tested primarily with **Google Chrome / Chromium** and Chrome is the **recommended** browser for the best experience.

Firefox generally works, but occasional browser/profile-specific issues (cache/site data) can cause UI actions (like sending messages) to behave unexpectedly during development builds.

If you see odd UI behavior in Firefox:
- Try a Private Window
- Clear site data for `127.0.0.1`
- Or use Chrome/Chromium (recommended)

**Recommended:** Chrome / Chromium  
**Works:** Firefox (best-effort)  
If something feels “stuck” in Firefox, Chrome is the fastest way to confirm it’s not a server/provider issue.

