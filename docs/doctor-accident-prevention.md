# How ER+ Helps Prevent AI Accidents

ER+ is the operator safety rail in Proworkbench. It does two things:
- checks environment/runtime prerequisites in a clear order
- applies safe repairs only when the user explicitly runs it

## Why this matters
Most AI “failures” in local setups are operational:
- provider not reachable
- no model loaded
- policy misconfiguration
- stale runtime assumptions

ER+ turns these into clear states: **OK / FIXED / NEEDS YOU / CAN'T FIX**.

## What ER+ checks
- PB server health
- Text WebUI reachability and loaded models
- basic chat completion sanity
- MCP template/state checks
- approvals queue health
- social execution hard-block invariant

## What ER+ never does automatically
- does not auto-run on page load
- does not auto-start Text WebUI
- does not execute tools/MCP actions as a side effect

## Operator workflow
1. Open **ER+**.
2. Click **Run checks** or **Fix my setup**.
3. Follow “Do this next” actions for anything not auto-fixable.

## How to verify
- With WebUI down: ER+ reports **NEEDS YOU** with clear steps.
- With model loaded: chat sanity check passes.
- If a security invariant fails: ER+ surfaces it explicitly.
