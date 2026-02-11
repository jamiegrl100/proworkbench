# Canvas

Canvas is a persistent, global “output surface” for an installation of PB.

Canvas is display and organization only:
- it does not execute tools
- it is admin-only

## What you’ll see
- Tabs: Latest, History, Pinned
- Filters: Tools, MCP, Doctor, Reports, Notes
- Mission Control header (runtime status + provider/model snapshot)
- Cards with:
  - title, timestamp, kind badge, status pill
  - rendered content (markdown/json/table/text)
  - actions (Pin, Copy, View raw, Delete)

## What goes into Canvas (automatic)
- Tool run completion creates a Canvas item.
- MCP actions (start/stop/test) create a Canvas item.
- Helper swarm outputs (Power user mode) create Canvas items as each helper finishes.
- Merged helper response creates a Canvas item.

## What you can add manually
- Notes (markdown).
- Doctor report can be sent to Canvas via **Send to Canvas**.

## Safety and limits
- PB caps Canvas to 500 items.
- PB truncates large payloads.
- PB masks obvious secrets in stored content (best effort).

## Verify it works
1. Create a note in Canvas and refresh the page: it should persist.
2. Run a tool (WebChat-only): a new Canvas card should appear.
3. Run an MCP Test/Start: a new Canvas card should appear.
