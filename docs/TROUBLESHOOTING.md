# Troubleshooting

## Common issues

### Port already in use
- Check `5173`, `8787`, `5000`.
- Stop stale processes and retry.

### WebUI connected but no models
- Load a model in WebUI UI first.
- Re-test `/v1/models`.

### WebChat timeouts
- Validate model server health.
- Reduce prompt/tool payload size.

### Permissions/path failures
- Verify workspace path and policy config.
- Confirm tool path normalization is correct.

### MCP fetch failures
- Check MCP server base URL and health.
- Validate selected MCP in chat route.

If unresolved, capture Doctor output + logs and open an issue.
