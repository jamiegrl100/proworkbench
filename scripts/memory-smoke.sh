#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${PB_BASE_URL:-http://127.0.0.1:8787}"
TOKEN="${PB_ADMIN_TOKEN:-${1:-}}"

if [[ -z "${TOKEN}" ]]; then
  echo "Usage: PB_ADMIN_TOKEN=<token> $0"
  echo "   or: $0 <token>"
  exit 1
fi

AUTH=( -H "Authorization: Bearer ${TOKEN}" -H "X-PB-Admin-Token: ${TOKEN}" )

DAY="$(date +%F)"

echo "[1/4] GET ${BASE_URL}/api/memory/health"
curl -sS "${BASE_URL}/api/memory/health" "${AUTH[@]}" | tee /tmp/pb-memory-health.json

echo "[2/4] POST ${BASE_URL}/api/memory/write"
curl -sS -X POST "${BASE_URL}/api/memory/write" "${AUTH[@]}" \
  -H 'Content-Type: application/json' \
  -d "{\"day\":\"${DAY}\",\"text\":\"smoke memory write ${DAY}\",\"session_id\":\"smoke-script\"}" | tee /tmp/pb-memory-write.json

echo "[3/4] POST ${BASE_URL}/api/memory/commit_all"
curl -sS -X POST "${BASE_URL}/api/memory/commit_all" "${AUTH[@]}" \
  -H 'Content-Type: application/json' \
  -d '{}' | tee /tmp/pb-memory-commit.json

echo "[4/4] POST ${BASE_URL}/api/memory/search"
curl -sS -X POST "${BASE_URL}/api/memory/search" "${AUTH[@]}" \
  -H 'Content-Type: application/json' \
  -d '{"q":"smoke memory write","scope":"all","limit":20}' | tee /tmp/pb-memory-search.json

echo "Done. Output files:"
echo "  /tmp/pb-memory-health.json"
echo "  /tmp/pb-memory-write.json"
echo "  /tmp/pb-memory-commit.json"
echo "  /tmp/pb-memory-search.json"
