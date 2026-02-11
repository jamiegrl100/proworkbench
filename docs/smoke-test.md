# v1 Preview Smoke Test

Use this checklist before shipping a preview build.

## Prerequisites
- PB repo: `/home/jamiegrl100/Apps/proworkbench`
- PB server: `http://127.0.0.1:8787`
- PB UI: `http://127.0.0.1:5173`
- Text WebUI API: `http://127.0.0.1:5000`
- Admin token available in `localStorage.pb_admin_token`

## 1) Doctor
1. Open `#/doctor`.
2. Click `Run checks only`.
3. Confirm sequential step progress appears and completes.
4. Click `Fix my setup`.
5. Confirm summary counters update (`OK`, `Fixed`, `Needs you`, `Can't fix`, `Needs prerequisite`).
6. Click `Copy support report`.

Expected:
- No crash.
- Last report is persisted and visible on reload.
- If WebUI is down, Doctor says `Needs you` with clear instructions.

Common fixes:
- WebUI down: start Text WebUI manually with API mode.
- No model loaded: open Text WebUI UI and load a model.

## 2) Runtime
1. Open `#/runtime`.
2. Verify Text WebUI status card renders.
3. Click `Test connection`.
4. Click `Refresh models`.
5. Toggle `Keep model server awake` ON, then OFF.

Expected:
- Shows connected/not connected clearly.
- No auto-start behavior.
- Keepalive only applies when Text WebUI is local (`127.0.0.1`) and model count is > 0.

Common fixes:
- Wrong port/host: set base URL to `http://127.0.0.1:5000`.
- Empty models: load a model in Text WebUI then refresh.

## 3) WebChat
1. Open `#/webchat`.
2. Confirm no system JSON message is injected in chat history.
3. Send `Say: ok`.
4. Enable Power user mode from Canvas and return to WebChat.
5. Confirm compact helper info chip appears (collapsed by default).

Expected:
- Message/response flow works.
- Info chip expands/collapses.
- No oversized warning banners blocking composer.

Common fixes:
- 401 in requests: set valid `pb_admin_token`.
- `LLM_NOT_READY`: check Runtime page and Doctor.

## 4) Tools
1. Open `#/tools`.
2. Confirm default policy is understandable and editable.
3. Set retention days (default `30`) and click `Save retention`.
4. Click `Purge rejected/old proposals` and confirm prompt.
5. Verify purge result message appears.

Expected:
- Policy saves.
- Purge only affects rejected/failed/blocked old proposals.
- Pending-approval items are skipped safely.

Common fixes:
- If purge fails, check server logs and ensure DB is writable.

## 5) Approvals
1. Open `#/approvals`.
2. Check `Pending Requests`, `Active Approvals`, `History`.
3. If empty, confirm friendly empty-state guidance appears.
4. Approve or deny one pending item when available.

Expected:
- Queue updates immediately.
- Detail panel shows selected row payload.

Common fixes:
- No items: create a risky tool proposal from WebChat or high-risk MCP action.

## 6) MCP Servers
1. Open `#/mcp`.
2. Confirm template gallery renders.
3. Create a low-risk server from a template.
4. Run `Test`, then `Start`, then `Logs`.
5. Set retention days and click `Purge stopped/old servers`.

Expected:
- Server lifecycle works.
- Hidden built-in Canvas MCP does not appear.
- Purge only deletes non-running old servers, skipping pending approvals.

Common fixes:
- `Approval required`: open Approvals and approve MCP action.
- `Failed` test: verify server config and status.

## 7) Telegram
1. Open `#/telegram`.
2. Check `Allowed`, `Pending`, `Blocked` tabs.
3. In `Allowed`, add numeric user ID and verify it appears immediately.
4. Remove the same ID and verify it disappears.
5. If tab is empty, confirm helper text appears (not blank table).

Expected:
- Allowlist is editable from UI.
- Allowlist persists across refresh.
- Unknown users remain ignored/blocked per policy.

Common fixes:
- Secrets missing: complete Telegram env setup in Settings/Setup.

## 8) Canvas
1. Open `#/canvas`.
2. Confirm tabs `Latest`, `History`, `Pinned`.
3. Create a note from `New note`.
4. Pin/unpin an item.
5. Delete an item with confirmation.

Expected:
- Items persist after refresh.
- Structured cards render without raw JSON spam by default.

Common fixes:
- If empty, run Doctor or execute a tool to generate Canvas entries.

## 9) Final pass
1. Run `npm run i18n:audit`.
2. Run `npm run build`.
3. Spot-check nav labels and major buttons in at least one non-English locale.

Expected:
- `i18n:audit` reports no obvious hardcoded UI strings.
- Build succeeds for UI and server package.
