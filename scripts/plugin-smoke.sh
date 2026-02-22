#!/usr/bin/env bash
set -euo pipefail

export PB_WORKDIR="${PB_WORKDIR:-/tmp/pb-plugin-smoke-work}"
export XDG_DATA_HOME="${XDG_DATA_HOME:-/tmp/pb-plugin-smoke-data}"
export PROWORKBENCH_PORT="${PROWORKBENCH_PORT:-8787}"

kill_port_listeners() {
  local port
  for port in "$@"; do
    local pids
    pids=$(ss -ltnp 2>/dev/null | awk -v p=":${port}" '$4 ~ p {print $NF}' | sed -n 's/.*pid=\([0-9]\+\).*/\1/p' | sort -u)
    if [[ -n "$pids" ]]; then
      # shellcheck disable=SC2086
      kill $pids 2>/dev/null || true
    fi
  done
}

cleanup() {
  if [[ -n "${SERVER_PID:-}" ]]; then kill "$SERVER_PID" 2>/dev/null || true; fi
  if [[ -n "${UI_PID:-}" ]]; then kill "$UI_PID" 2>/dev/null || true; fi
  kill_port_listeners "$PROWORKBENCH_PORT" 5173
}
trap cleanup EXIT

kill_port_listeners "$PROWORKBENCH_PORT" 5173
rm -rf "$PB_WORKDIR" "$XDG_DATA_HOME"
mkdir -p "$PB_WORKDIR" "$XDG_DATA_HOME"

env PB_WORKDIR="$PB_WORKDIR" XDG_DATA_HOME="$XDG_DATA_HOME" PROWORKBENCH_PORT="$PROWORKBENCH_PORT" npm -w server run dev >/tmp/pb-plugin-smoke-server.log 2>&1 &
SERVER_PID=$!
sleep 3
env PROWORKBENCH_PORT="$PROWORKBENCH_PORT" npm -w ui run dev >/tmp/pb-plugin-smoke-ui.log 2>&1 &
UI_PID=$!
sleep 4

health_json=$(curl -sf "http://127.0.0.1:${PROWORKBENCH_PORT}/health")
if ! echo "$health_json" | rg -q '"ok":true'; then
  echo "FAIL: /health not ok"
  exit 1
fi

token=$(curl -sf -X POST "http://127.0.0.1:${PROWORKBENCH_PORT}/admin/setup/bootstrap" -H 'Content-Type: application/json' -d '{}' | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log((JSON.parse(s).token)||''))")
if [[ ${#token} -lt 32 ]]; then
  echo "FAIL: bootstrap token not returned"
  exit 1
fi

# A) default-safe fallback when file is missing
rm -f "$PB_WORKDIR/.pb/plugins/enabled.json"
default_enabled=$(curl -sf "http://127.0.0.1:${PROWORKBENCH_PORT}/api/plugins/enabled" -H "Authorization: Bearer $token")
if ! echo "$default_enabled" | rg -q '"writing-lab"'; then
  echo "FAIL: default plugin fallback did not include writing-lab"
  exit 1
fi

# B) fallback when file is unreadable/corrupt
mkdir -p "$PB_WORKDIR/.pb/plugins"
printf '{bad-json' > "$PB_WORKDIR/.pb/plugins/enabled.json"
corrupt_enabled=$(curl -sf "http://127.0.0.1:${PROWORKBENCH_PORT}/api/plugins/enabled" -H "Authorization: Bearer $token")
if ! echo "$corrupt_enabled" | rg -q '"writing-lab"'; then
  echo "FAIL: corrupt plugin file did not fall back to defaults"
  exit 1
fi

# C) unknown ids rejected
unknown_status=$(curl -s -o /tmp/pb-plugin-unknown.out -w '%{http_code}' -X POST "http://127.0.0.1:${PROWORKBENCH_PORT}/api/plugins/enabled" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"enabled":["not-a-plugin"]}')
if [[ "$unknown_status" != "400" ]]; then
  echo "FAIL: unknown plugin id should be rejected with 400, got $unknown_status"
  cat /tmp/pb-plugin-unknown.out
  exit 1
fi

# D) disable + re-enable
curl -sf -X POST "http://127.0.0.1:${PROWORKBENCH_PORT}/api/plugins/enabled" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"enabled":[]}' >/tmp/pb-plugin-disable.out
curl -sf -X POST "http://127.0.0.1:${PROWORKBENCH_PORT}/api/plugins/enabled" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' -d '{"enabled":["writing-lab"]}' >/tmp/pb-plugin-enable.out


# F) upload fails closed without signature
mkdir -p /tmp/pb-plugin-smoke-pkg/dist
cat > /tmp/pb-plugin-smoke-pkg/manifest.json <<'JSON'
{"id":"sample-lab","name":"Sample Lab","version":"0.1.0","entry":"dist/index.js"}
JSON
printf 'console.log("ok")\n' > /tmp/pb-plugin-smoke-pkg/dist/index.js
(cd /tmp/pb-plugin-smoke-pkg && zip -qr /tmp/pb-plugin-smoke.zip manifest.json dist)
upload_status=$(curl -s -o /tmp/pb-plugin-upload.out -w '%{http_code}' -X POST "http://127.0.0.1:${PROWORKBENCH_PORT}/admin/extensions/upload" -H "Authorization: Bearer $token" -F "file=@/tmp/pb-plugin-smoke.zip")
if [[ "$upload_status" != "400" ]]; then
  echo "FAIL: unsigned upload must be blocked (expected 400, got $upload_status)"
  cat /tmp/pb-plugin-upload.out
  exit 1
fi
if ! rg -q 'SIGNATURE_REQUIRED|SIGNATURE_INVALID' /tmp/pb-plugin-upload.out; then
  echo "FAIL: unsigned upload did not report signature failure"
  cat /tmp/pb-plugin-upload.out
  exit 1
fi
# E) writing-lab context still healthy
wl_status=$(curl -s -o /tmp/pb-plugin-wl.out -w '%{http_code}' "http://127.0.0.1:${PROWORKBENCH_PORT}/admin/writing-lab/context" -H "Authorization: Bearer $token")
if [[ "$wl_status" != "200" ]]; then
  echo "FAIL: /admin/writing-lab/context expected 200, got $wl_status"
  cat /tmp/pb-plugin-wl.out
  exit 1
fi

echo "PASS: plugin smoke test"
echo "health=$health_json"
echo "default=$default_enabled"
