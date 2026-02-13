# PB Memory Model (v0)

PB memory is workspace-file based and governed:

- Daily scratch (append-only, bounded):  
  `.pb/memory/daily/YYYY-MM-DD.scratch.md`
- Daily summary (bounded overwrite):  
  `.pb/memory/daily/YYYY-MM-DD.summary.md`
- Durable memory:  
  `MEMORY.md`
- Durable monthly archives:  
  `MEMORY_ARCHIVE/YYYY-MM.md`

## Safety model

- Memory reads are always allowed without approval, but only from allowlisted memory paths and with byte caps.
- Scratch writes are append-only and rate/size limited.
- Durable edits (`MEMORY.md`, `MEMORY_ARCHIVE/*`) are proposal + invoke only.
- Sensitive scan + redaction run during finalize.

## APIs

- `GET /admin/memory/get` (allowlisted bounded read)
- `GET /admin/memory/search` (lexical search across daily/durable/archive scopes)
- `POST /admin/memory/write-scratch`
- `POST /admin/memory/update-summary`
- `POST /admin/memory/finalize-day` (creates durable patch + approval proposal)
- `POST /admin/memory/apply-durable-patch` (apply approved patch)

## Finalize Day flow

1. Read full day scratch
2. Scan for sensitive content
3. Redact and preview
4. Build diffs for durable files
5. Require explicit invoke to apply
6. Rotate older day logs from `MEMORY.md` into `MEMORY_ARCHIVE/YYYY-MM.md`
