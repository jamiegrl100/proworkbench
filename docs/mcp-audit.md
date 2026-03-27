# MCP Audit

## Run

From repo root:

```bash
node scripts/mcp-audit.js
```

Optional env vars:

- `PB_BASE_URL` (default `http://127.0.0.1:8787`)
- `PB_ADMIN_TOKEN` (if omitted, the script bootstraps a local audit token in PB DB)
- `PB_WORKDIR` (default `/home/jamiegrl100/.proworkbench/workspaces/alex`)

## Outputs

Reports are written to:

- `/home/jamiegrl100/.proworkbench/workspaces/alex/mcp_audit/report.json`
- `/home/jamiegrl100/.proworkbench/workspaces/alex/mcp_audit/report.md`

`report.json` includes per-server tests with timing, errors, and trimmed raw logs.

## How to read results

- A server is `PASS` only if all tests for that server pass.
- The script exits non-zero if any server fails.
- For each failure, check:
  - test name
  - error message
  - server `raw_logs`

## Adding tests for a new MCP server

Edit `scripts/mcp-audit.js`:

1. Add template ID to `TARGET_TEMPLATE_IDS` if it must be auto-created for audit.
2. Add a `server.template_id === 'your_template'` block with capability assertions.
3. Keep tests deterministic and low-risk.

## Troubleshooting checklist

1. Confirm PB server is running (`/health`).
2. Ensure auth works (provide `PB_ADMIN_TOKEN` or let script bootstrap local token).
3. Verify template exists in `/api/mcp/templates`.
4. Verify server exists in `/api/mcp/servers`.
5. Inspect `/api/mcp/servers/:id/logs` for runtime details.
