# MCP Servers

PB includes an MCP Servers manager built for non-tech workflows:
- 15 presets (templates) that seed into the database
- create server instances from templates (form-driven)
- manual Test/Start/Stop/Logs
- unified approvals gating for higher-risk actions

## What you’ll see
- A **Template gallery** (15 cards)
- A **Servers list** with actions:
  - Test
  - Start/Stop
  - Logs
  - Copy ID
- Filters and search to find servers quickly
- Retention controls to purge stopped/error servers older than N days (safe purge)

## Security boundaries
> [!WARNING]
> MCP operations are WebChat-only. Telegram/Slack cannot start/test/stop MCP servers.

PB will block any social-origin attempt with HTTP 403.

## Presets pack (15)
Templates live in `server/mcp/templates/` and are seeded into the DB on startup if missing.

## Typical workflow
1. Choose a template and click **Create**.
2. Fill in the form fields (no raw JSON required).
3. Click **Test** to confirm it is healthy.
4. Click **Start** to run the server (manual only).
5. Use **Logs** to debug.

## Approvals gating
High or critical risk templates may require approval for Start/Test/Edit.
When approval is required:
- the Start/Test buttons should show “Requires approval” or route you to the Approvals page.

## Verify it works
1. Open **MCP Servers**.
2. Create a low-risk server from a template.
3. Run **Test** and confirm it shows Healthy.
4. Start it and confirm status changes and logs are visible.

## Notes
- Canvas MCP is built-in and hidden from the list.
- Purge never deletes running servers and skips servers tied to pending approvals.
