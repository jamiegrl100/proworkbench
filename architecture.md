# Architecture (Preview v0.1)

This page shows how the system fits together and where the security boundaries are.

## System architecture

```mermaid
flowchart LR
  subgraph Browser["Browser (Local)"]
    UI["PB UI (Vite/React)\n127.0.0.1:5173"]
  end

  subgraph PBStack["Proworkbench Server (Local)\nExpress + SQLite\n127.0.0.1:8787"]
    PBAPI["PB API router"]
    Auth["Admin auth\nAuthorization: Bearer token"]
    DB["SQLite\n(app state, approvals, MCP servers,\ncanvas, events)"]
    ToolRunner["Tool runner (server-side only)"]
    Approvals["Unified approvals queue\n(tool + MCP actions)"]
    Canvas["Canvas storage\n(persistent cards)"]
    MCP["MCP subsystem\n(templates + servers)"]
    Channels["Channels\nTelegram / Slack\n(chat-only)"]
  end

  subgraph WebUI["Text Generation WebUI (Local)\nOpenAI-compatible API\n127.0.0.1:5000"]
    Models["/v1/models"]
    Chat["/v1/chat/completions"]
  end

  UI -->|admin API (proxied)| PBAPI
  PBAPI --> Auth
  PBAPI --> DB
  PBAPI -->|probe/models/chat| WebUI

  PBAPI --> Approvals
  PBAPI --> ToolRunner
  ToolRunner --> Canvas
  MCP --> Canvas
  PBAPI --> MCP
  PBAPI --> Channels

  %% Security boundaries
  Channels -. hard blocked execution .-> ToolRunner
  Channels -. hard blocked execution .-> MCP
```

**Security boundaries**
- Tools and MCP run **only** on the PB server.
- Social channels (Telegram/Slack) are **chat-only** and are hard blocked from execution paths.

## Tool execution flow

```mermaid
sequenceDiagram
  autonumber
  participant U as User
  participant UI as PB WebChat UI
  participant S as PB Server
  participant A as Approvals (DB)
  participant T as Tool Runner
  participant C as Canvas

  U->>UI: Chat message
  UI->>S: POST /admin/webchat/send
  S-->>UI: Assistant response (+ optional tool proposal_id)

  Note over UI: No auto-run
  U->>UI: Click "Invoke tool"
  UI->>S: POST /admin/tools/execute { proposal_id }

  S->>S: Pre-invoke refresh gate\n(check provider + models ready)
  S->>A: If approval required: verify approved
  alt Not approved
    S-->>UI: 403 Approval required
  else Approved or not required
    S->>T: Execute tool (server-side)
    T-->>S: Result (stdout/stderr/result/artifacts)
    S->>C: Persist Canvas card
    S-->>UI: Run completed (run_id + safe result)
  end
```

## Doctor flow

```mermaid
flowchart TD
  Idle["Doctor page (idle)\nNo auto-run"] --> Click["User clicks Run checks / Fix my setup"]
  Click --> Steps["Run steps sequentially\n(always run all)"]
  Steps --> Report["Report: OK / FIXED / NEEDS YOU / NEEDS PREREQUISITE / CAN'T FIX"]
  Report --> Store["Store last report (global)"]
  Store --> Actions["Action buttons\n(Open WebUI, Runtime, Approvals, Tools)"]
```

## MCP lifecycle (high level)

```mermaid
flowchart LR
  Tpl["Templates (15 presets)\nseeded into DB"] --> Create["Create server instance"]
  Create --> Test["Test (manual)"]
  Test --> Start["Start (manual)"]
  Start --> Logs["Logs"]
  Start --> Stop["Stop"]
  Test --> Canvas["Canvas item"]
  Start --> Canvas
  Stop --> Canvas

  Start -. if high/critical .-> Appr["Approval required"]
  Appr --> Start
```
