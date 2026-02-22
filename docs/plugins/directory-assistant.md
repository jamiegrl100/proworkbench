# Directory Assistant (Human-in-the-loop)

Directory Assistant helps prepare website submissions to directories/search alternatives without bulk automation.

## Safety model

- No auto-submit.
- No CAPTCHA solving or bypass.
- Prefill requires explicit user action and explicit approval.
- Respect site rules and terms.

## Install

1. Open **Extensions** in PB.
2. Upload `plugins/releases/directory-assistant-0.1.0.zip`.
3. Enable `directory-assistant`.
4. Open sidebar item **Directory Assistant**.

## Workflow

1. Add targets by pasting URLs.
2. Save a submission profile.
3. Configure allowlisted domains in plugin settings.
4. Request prefill (creates approval request).
5. Approve in **Approvals**.
6. Run prefill review.
7. Open target page and submit manually.
8. Mark as submitted in plugin UI.

## Compliance posture

- Discovery is assistive (query generation + user-pasted URLs), not automated search-engine scraping.
- CAPTCHA pages are marked `needs-manual`.
- Export reports are local (JSON/CSV) in workspace storage.

## Workspace storage

`$PB_WORKDIR/.pb/directory-assistant/`

- `exports/`
- `evidence/` (reserved for optional screenshots)
