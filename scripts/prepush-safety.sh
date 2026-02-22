cat > scripts/prepush-safety.sh <<'SH'
#!/usr/bin/env bash
set -euo pipefail

bad="$(git ls-files | egrep -i '\.docx$|\.pdf$|(^|/)\.pb/|(^|/)workspace/|^writing/' || true)"
if [ -n "$bad" ]; then
  echo "❌ Refusing: repo tracks sensitive files:"
  echo "$bad"
  exit 1
fi

staged_bad="$(git diff --cached --name-only | egrep -i '\.docx$|\.pdf$|(^|/)\.pb/|(^|/)workspace/|^writing/' || true)"
if [ -n "$staged_bad" ]; then
  echo "❌ Refusing: staged sensitive files:"
  echo "$staged_bad"
  exit 1
fi

echo "✅ Safety OK: no memory/copyrighted content tracked or staged."
SH

chmod +x scripts/prepush-safety.sh
