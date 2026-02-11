# Tools and Approvals

PB is safe-by-default: tools do not execute until explicitly allowed, and risky actions require approval.

## What you’ll see
- A **Tools** page with:
  - tool policy (defaults + per-risk settings + per-tool overrides)
  - tool proposals and runs
- An **Approvals** page with one queue for:
  - tool runs
  - MCP actions (start/test/edit) that require approval
- In **WebChat**:
  - tool proposals show an “Invoke tool” button
  - approvals-required proposals show “Needs approval”

## Core rules

> [!WARNING]
> Tools and MCP execution are WebChat-only. Telegram/Slack are chat-only and cannot execute anything.

**No auto-run**
- The model may propose.
- A human must click **Invoke tool** to run it.

**Helper swarm constraints**
- Helper assistants are LLM-only.
- Helpers cannot execute tools or MCP actions (server-side 403).

## Tool execution flow (Mermaid)

```mermaid
flowchart TD
  Msg["User message (WebChat)"] --> Reply["Assistant reply"]
  Reply -->|may include| Proposal["Tool proposal\n(tool_name, args, risk)"]

  Proposal --> Gate["Policy gate\n(block/allow/allow+approval)"]
  Gate -->|blocked| Blocked["Blocked by policy"]
  Gate -->|allow+approval| NeedsAppr["Needs approval"]
  Gate -->|allow| Ready["Ready to invoke"]

  NeedsAppr --> Queue["Unified approvals queue\n(pending)"]
  Queue -->|approve| Ready
  Queue -->|deny| Denied["Denied"]

  Ready --> Click["User clicks Invoke tool"]
  Click --> Pre["Pre-invoke refresh gate\n(Text WebUI reachable + models loaded)"]
  Pre --> Run["Execute tool on PB server"]
  Run --> Result["Store run result"]
  Result --> Canvas["Create Canvas item"]
```

## Approvals lifecycle (Mermaid)

```mermaid
stateDiagram-v2
  [*] --> pending: created
  pending --> approved: admin approves
  pending --> denied: admin denies
  approved --> expired: TTL expires (if used)
  denied --> [*]
  expired --> [*]
```

## How to verify it works
1. Open **Tools** and confirm the default stance is safe (blocked unless allowed).
2. In **WebChat**, create a proposal and confirm:
   - blocked tools show “Blocked by policy”
   - approval-required tools show “Needs approval” and link to **Approvals**
3. Approve a pending item, then return to WebChat and click **Invoke tool**.
4. Confirm a Canvas item was created for the run result.
5. In **Tools**, use retention controls to purge only rejected/old proposals and verify pending approvals are skipped.

## Advanced (for debugging)
If a tool cannot be invoked, check:
- tool policy effective access (Tools page)
- approval status (Approvals page)
- provider readiness (Runtime page, Text WebUI models loaded)
