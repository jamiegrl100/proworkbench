# Watchtower: Idle-Only Proactive Check-ins

Watchtower is PB’s proactive checker, designed to run quietly in the background **only when PB is idle**.

## What it does
- Reads a hidden checklist file:
  - `.pb/watchtower/WATCHTOWER.md` (workspace-scoped)
- Evaluates current status and bounded memory context
- Returns:
  - `WATCHTOWER_OK` (silent by default)
  - or an alert summary + proposal suggestions

## What it does not do
- It does **not** auto-invoke tools.
- It does **not** execute side effects by itself.
- It does **not** run while PB is busy.

## Settings
Use the **Watchtower** page in PB:
- enable/disable
- interval minutes
- active hours window
- silent-OK mode
- delivery target (Canvas/WebChat)
- checklist editor
- **Run now** debug button

## File and policy boundary
- Checklist writes are allowed only to:
  - `.pb/watchtower/WATCHTOWER.md`
- max file size cap is enforced
- traversal/out-of-workspace writes are blocked

## How to verify
1. Save a checklist in Watchtower settings.
2. Run now while idle; confirm one run result.
3. Set an empty checklist; confirm `ok-empty` skip behavior.
4. Confirm generated actions are proposals only (no auto-execution).
