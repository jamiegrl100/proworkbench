# Doctor

Doctor is the runtime diagnostics and remediation entry point.

## What it checks

- API/UI connectivity
- Model endpoint reachability
- Model list availability
- MCP registry/runtime status
- Tool execution preconditions

## Typical fixes

- Port conflicts (`5173`, `8787`, `5000`)
- Missing model load in WebUI
- Invalid base URLs
- Missing runtime dependencies

## Troubleshooting workflow

1. Run Doctor.
2. Copy failing check output.
3. Apply suggested fix.
4. Re-run until green.

Doctor output should be treated as operator-facing and deterministic.
