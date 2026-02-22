#!/usr/bin/env bash
set -euo pipefail

API_BASE="${API_BASE:-http://127.0.0.1:8787}"
TOKEN="${PB_TOKEN:-${1:-}}"
if [[ -z "${TOKEN}" ]]; then
  echo "Usage: PB_TOKEN=<token> $0"
  exit 1
fi
AUTH=(-H "Authorization: Bearer ${TOKEN}" -H "X-PB-Admin-Token: ${TOKEN}" -H "Content-Type: application/json")

SESSION="webchat-main"

echo "[1/4] Debug MCP registry"
DBG="$(curl -fsS "${AUTH[@]}" "${API_BASE}/admin/mcp/debug")"
python3 - <<'PY' "$DBG"
import json,sys
obj=json.loads(sys.argv[1])
print('templates:', obj.get('template_ids', []))
print('servers:', obj.get('servers_count'))
if not obj.get('template_ids'):
    raise SystemExit('FAIL: no MCP templates loaded')
PY

echo "[2/5] AUTO-DEFAULT: no template selected — ask about weather in dallas texas"
# This is the primary regression test for MCP_BROWSE_REQUIRED.
# No mcp_template_id or mcp_server_id sent — server must auto-pick one.
OUT_AUTO="$(curl -sS "${AUTH[@]}" -X POST "${API_BASE}/admin/webchat/send" \
  -d '{"session_id":"'"${SESSION}"'-auto","agent_id":"alex","message_id":"test-auto-'"$(date +%s)"'","message":"what is the weather in dallas texas"}')"
python3 - <<'PY' "$OUT_AUTO"
import json, sys
obj = json.loads(sys.argv[1])
err = obj.get('error', '')
reply = (obj.get('reply') or '').strip()
chosen = obj.get('chosenTemplateId')
reason = obj.get('chosenTemplateReason')
print('ok=', obj.get('ok'), 'error=', err, 'chosenTemplateId=', chosen, 'reason=', reason)
print('reply_preview=', reply[:120])
if err == 'MCP_BROWSE_REQUIRED':
    raise SystemExit('FAIL: got MCP_BROWSE_REQUIRED — auto-default selection not working')
if not chosen:
    raise SystemExit('FAIL: chosenTemplateId missing — auto-selection debug field not set')
if reply.strip() == '' or (reply.startswith('http') and ' ' not in reply):
    raise SystemExit('FAIL: reply is empty or a bare URL — MCP route did not summarize')
print('PASS: auto-default template selected and weather reply received')
PY

echo "[3/5] basic_browser browse test"
OUT1="$(curl -fsS "${AUTH[@]}" -X POST "${API_BASE}/admin/webchat/send" -d '{"session_id":"'"${SESSION}"'","agent_id":"alex","message_id":"test-basic-'"$(date +%s)"'","mcp_template_id":"basic_browser","message":"Browse https://example.com and summarize the main heading and first paragraph."}')"
python3 - <<'PY' "$OUT1"
import json,sys
obj=json.loads(sys.argv[1])
reply=(obj.get('reply') or '').lower()
trace=obj.get('browse_trace') or {}
ok='example.com' in reply and trace.get('route')=='mcp'
print('route=',trace.get('route'),'server=',obj.get('mcp_server_id'),'template=',obj.get('mcp_template_id'))
if not ok:
    raise SystemExit('FAIL: basic browse did not return MCP-based example.com summary')
PY

echo "[4/5] search_browser search test"
OUT2="$(curl -fsS "${AUTH[@]}" -X POST "${API_BASE}/admin/webchat/send" -d '{"session_id":"'"${SESSION}"'","agent_id":"alex","message_id":"test-search-'"$(date +%s)"'","mcp_template_id":"search_browser","message":"Search the web for OpenClaw AI assistant and list 5 sources."}')"
python3 - <<'PY' "$OUT2"
import json,sys,re
obj=json.loads(sys.argv[1])
reply=(obj.get('reply') or '')
urls=re.findall(r'https?://[^\s,)]+', reply)
trace=obj.get('browse_trace') or {}
print('route=',trace.get('route'),'urls=',len(urls))
if trace.get('route')!='mcp':
    raise SystemExit('FAIL: search test did not use MCP route')
if len(urls)<3:
    raise SystemExit('FAIL: search reply has too few URLs')
PY

echo "[5/5] negative test (template missing/unresolved)"
set +e
OUT3="$(curl -sS "${AUTH[@]}" -X POST "${API_BASE}/admin/webchat/send" -d '{"session_id":"'"${SESSION}"'","agent_id":"alex","message_id":"test-neg-'"$(date +%s)"'","mcp_template_id":"does_not_exist","message":"Browse https://example.com"}')"
set -e
python3 - <<'PY' "$OUT3"
import json,sys
obj=json.loads(sys.argv[1])
reply=(obj.get('reply') or '')
trace=obj.get('browse_trace') or {}
stages=trace.get('stages') or []
errs=[s.get('error') for s in stages if isinstance(s,dict)]
print('errors=',errs)
if 'MCP_TEMPLATE_NOT_RESOLVED' not in errs and 'MCP_SERVER_NOT_SELECTED' not in errs:
    raise SystemExit('FAIL: negative test did not return actionable MCP error')
if 'MCP Servers' not in reply and 'template' not in reply:
    raise SystemExit('FAIL: negative test missing remediation guidance')
PY

echo "PASS: MCP browse acceptance checks"
