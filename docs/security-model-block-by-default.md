# Why We Block by Default: The Proworkbench Security Model

Proworkbench is designed around a simple principle: **high-impact actions should require explicit intent**.

## Threat model (practical)
- Model output can be wrong, over-confident, or prompt-injected.
- Chat channels can be noisy and ambiguous.
- Operators need clear checkpoints before side effects happen.

## How PB reduces risk by design
- Tools are policy-gated with a default conservative posture.
- Risky actions use approvals.
- WebChat separates proposal from execution with explicit **Invoke**.
- Telegram/Slack are chat-only for tools/MCP execution paths.

## Least privilege in runtime behavior
- File actions are constrained to workspace boundaries.
- MCP lifecycle actions use policy + approvals and are auditable.
- Canvas stores outputs for review but is not an execution path.

## What PB does not claim
- PB does not claim “perfect” or “unhackable” security.
- PB does not claim to remove all prompt-injection risk.
- PB focuses on making risky actions visible, governable, and reviewable.

## How to verify
1. Open **Tools** and confirm the effective policy state.
2. Propose a high-risk action in WebChat.
3. Confirm it requires approval and explicit invoke.
4. Confirm Telegram/Slack execution attempts are blocked.
