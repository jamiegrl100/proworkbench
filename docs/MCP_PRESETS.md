# MCP Presets

MCP presets are reusable, constrained automation profiles for browser/media tasks.

## Preset model

A preset defines:
- target runtime/server
- allowed methods/capabilities
- expected health checks
- optional input schema

## Add a preset

1. Create preset manifest in your MCP preset location.
2. Register via MCP page/API.
3. Run build/test/install sequence.
4. Validate from Diagnostics.

## Operator guidance

- Keep presets narrowly scoped.
- Prefer explicit capabilities over wildcard execution.
- Track each preset change in changelog/issues.

TODO: add canonical preset schema reference after current MCP schema freeze.
