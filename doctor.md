# ER+

ER+ is PB’s “Fix my setup” page. It runs a deterministic checklist and produces a simple outcome:
- **OK**
- **FIXED**
- **NEEDS YOU**
- **NEEDS PREREQUISITE**
- **CAN’T FIX**

> [!NOTE]
> Legacy `#/doctor` and `/doctor` links redirect to `#/er` and `/er`.

## What you’ll see
- A summary strip: counts by status
- A step list that updates as ER+ runs
- Issue cards with:
  - what PB found
  - what PB did (if anything)
  - what you do next (1 to 3 steps)
  - action buttons (Open WebUI, Open Runtime, Open Approvals, etc.)

ER+ also verifies core security invariants such as social execution hard-blocks.

## How to run ER+
ER+ does not run automatically.
1. Open the **ER+** page.
2. Click **Run checks only** or **Fix my setup**.

## What ER+ can fix (safe repairs)
ER+ may attempt only safe operations, such as:
- seeding missing MCP templates in the database
- applying safe default configuration values
- restarting PB internal workers (when supported by existing PB endpoints)

## What ER+ will never do
- Start Text Generation WebUI
- Run tools
- Run MCP servers
- Execute arbitrary shell commands

## Common outcomes

### Text WebUI not running (NEEDS YOU)
ER+ will tell you to start Text WebUI manually:

```bash
cd ~/Apps/text-generation-webui
./start_linux.sh --api --api-port 5000 --listen-host 127.0.0.1
```

### Text WebUI running but no models (NEEDS YOU)
ER+ will instruct you to open Text WebUI and load a model.

Known-good model:
- `models/quen/qwen2.5-coder-7b-instruct-q6_k.gguf`

## Privacy / safety notes
- ER+ reports should not contain secret values.
- If you copy a support report, review it before posting publicly.
