# Forge Console Plugin

## Install + Enable

1. Open **Extensions** in Proworkbench.
2. Upload the signed Forge Console ZIP.
3. Enable `forge-console`.

When enabled, a **Forge Console** sidebar item appears immediately.

## Runtime expectations

- Plugin nav comes from `/api/plugins/available` metadata.
- If nav metadata is missing, Proworkbench synthesizes a safe default:
  - label: plugin name (or id)
  - route key: `plugin:<id>`
  - iframe source: `/plugins/<id>/`
- Plugin web assets are served by server route `/plugins/<id>/` from:
  - `${PB_WORKDIR:-~/.proworkbench}/.pb/extensions/installed/<id>/versions/<version>/web/`

## Debugging

Use admin endpoint:

- `GET /admin/plugins/debug`

It returns enabled/installed/available plugin data and mount checks (`exists`, `webRoot`, `indexHtmlPresent`, `mountUrl`) to explain missing sidebar buttons or 404s.
