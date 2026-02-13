# OpenClaw Alternative: Governed Local AI Agents (Approvals-First)

This document explains how to evaluate Proworkbench as an alternative to OpenClaw in a factual, operations-first way.

It is not a negative comparison and not a hype document. Both projects can be useful. The key difference is default operating posture.

## Summary
- **Proworkbench** is built for governed autonomy: propose first, execute with explicit controls.
- **OpenClaw** can support powerful agent workflows, with behavior depending on configuration and deployment choices.
- The best choice depends on your team’s risk tolerance, operator skill mix, and how much execution governance you need by default.

## The practical difference

Proworkbench puts risky execution behind visible gates:
- tool policy
- approvals
- explicit **Invoke** in WebChat

That means model output and side effects are intentionally separated. The model can propose; operators decide what runs.

For teams with non-technical operators, this usually improves trust and supportability because actions are legible in UI and reviewable in history.

## Proworkbench operating values

These values map to concrete product behavior:

1. **Local-first**
- Typical setup uses Text Generation WebUI on `127.0.0.1:5000`.
- PB does not require cloud orchestration for core workflows.

2. **Approvals-first for risk**
- High-risk actions are not treated like normal chat output.
- Teams can require approval before invoke.

3. **Policy clarity**
- Effective policy comes from global defaults + per-risk + per-tool overrides.
- Operators should be able to answer “why blocked/allowed?” without reading source code.

4. **Channel boundaries**
- WebChat is the execution surface.
- Telegram/Slack are chat/notify surfaces only (no tool/MCP execution).

5. **Operational visibility**
- Doctor provides setup checks and guided fixes.
- Canvas and runtime views make state and outputs inspectable.

## Security posture comparison (high level)

| Area | Typical OpenClaw setup | Proworkbench default posture |
|---|---|---|
| Execution path | Configuration-dependent | WebChat explicit invoke for risky actions |
| Risk controls | Depends on deployment profile | Block-by-default + per-risk controls |
| Approvals | Implementation-dependent | Unified approvals for tools + MCP |
| Social channels | Depends on integration choices | Chat-only, execution hard-blocked |
| Recovery UX | Operator/toolchain dependent | Doctor guided checks and remediation |

## What PB does not claim

Proworkbench does **not** claim:
- perfect security
- elimination of all prompt-injection risk
- replacement for basic security hygiene

PB’s claim is narrower: safer defaults + explicit control points + clearer operational state reduce risk in real usage.

## Advisory-aware evaluation

If you compare stacks, use primary sources for advisories and apply equal scrutiny across all options.

Example references:
- NVD: `CVE-2026-25253`
- GHSA advisory references related to OpenClaw

These references should be used for informed evaluation, not alarmism.

## Migration checklist for OpenClaw users

1. Run Text WebUI locally in API mode (`127.0.0.1:5000`).
2. Load a model in WebUI first.
3. Start PB and run Doctor.
4. Keep tool policy conservative initially.
5. Enable only tools needed for the first workflow.
6. Use proposal → approval (if needed) → invoke flow.
7. Validate outcomes in approvals/history/canvas views.
8. Expand capability gradually after baseline reliability is stable.

## Evaluation checklist (same test for both systems)

Use the same model, same task, and same operator roles.

- Can non-technical users see provider/model state without developer tools?
- Is proposal distinct from execution?
- Can high-risk actions be blocked by default?
- Is approval flow unified and understandable?
- Are failures actionable (clear next steps)?
- Are social channels separated from execution?
- Can you audit who approved what and when?

## Why this matters for teams

In production-like environments, most incidents are not dramatic exploits. They are routine mismatches:
- provider up but model unloaded
- policy intent differs from effective state
- unclear ownership of approvals
- invisible execution paths

PB is designed to make those failure modes easier to detect and recover from.

## Related links
- Website article: `https://proworkbench.com/openclaw-alternative/`
- Security model: `docs/security.md`
- Tools and approvals: `docs/tools-and-approvals.md`
- Doctor: `docs/doctor.md`
