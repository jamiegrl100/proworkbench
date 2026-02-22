# Memory Model

PB memory is workspace-file based and draft-governed:

- Daily scratch (ephemeral, append-only):
  `.pb/memory/daily/YYYY-MM-DD.scratch.md`
- Daily summary (derived):
  `.pb/memory/daily/YYYY-MM-DD.summary.md`
- Durable memory:
  `MEMORY.md` + monthly archives under `MEMORY_ARCHIVE/`

## Draft-first behavior (Option B)

All explicit memory writes now create **drafts** first.

- Draft state: `state='draft'`
- Committed state: `state='committed'`, `committed_at` set
- Drafts are persisted immediately to SQLite and survive restart/crash.
- Drafts are **not used** for memory search or model context until committed.

## Commit or Wipe

When drafts exist, operators can:

- Commit selected/all drafts (moves to committed state)
- Discard selected/all drafts (deletes drafts)
- Review drafts from the Memory panel before choosing

WebChat and app navigation show draft count and a guard so drafts are not silently dropped.

## API

### Draft lifecycle
- `POST /api/memory/create_draft` (alias: `POST /api/memory/write`)
- `GET /api/memory/drafts`
- `POST /api/memory/commit`
- `POST /api/memory/commit_all`
- `POST /api/memory/discard`
- `POST /api/memory/discard_all`

### Search and health
- `POST /api/memory/search` (committed only)
- `GET /api/memory/health`

### Admin aliases (auth-protected)
- `GET /admin/memory/get`
- `POST /admin/memory/update-summary`
- `POST /admin/memory/finalize-day`
- `POST /admin/memory/apply-durable-patch`

## Observability

Memory operations emit events (sanitized):

- `memory.draft_created`
- `memory.commit`, `memory.commit_all`
- `memory.discard`, `memory.discard_all`
- `memory.search`
- `memory.api.request`
- Security events for memory auth/search failures and requests

No secrets are logged in memory event payloads.


## Legacy approval conversion

If older memory-write proposals are stuck in Approvals, use **Memory -> Convert pending approvals to drafts**.
This moves pending `memory.write_scratch`/`memory.append` proposals into durable drafts and supersedes their approval items.
