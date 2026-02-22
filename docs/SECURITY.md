# Security

## Core posture

- Local-first operation
- Explicit execution paths
- Auditable state transitions
- No silent no-ops

## Data handling

- Runtime state and logs are local.
- Tokens/secrets should be masked in UI/log output.
- Use least-privilege policies for non-workspace operations.

## Network

- Keep internal services on localhost unless explicitly required.
- Do not expose runtime API publicly without reverse proxy + auth.

## Reporting issues

See repository `SECURITY.md` for vulnerability reporting policy.
