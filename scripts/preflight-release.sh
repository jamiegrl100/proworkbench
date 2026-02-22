#!/usr/bin/env bash
set -euo pipefail

echo "[preflight] checking for forbidden build outputs in git index..."
if git ls-files | rg -q "desktop/dist-installers|linux-unpacked|\.AppImage$|\.dmg$|\.exe$|\.deb$"; then
  echo "ERROR: installer/build outputs are tracked by git. Remove them before releasing."
  git ls-files | rg "desktop/dist-installers|linux-unpacked|\.AppImage$|\.dmg$|\.exe$|\.deb$"
  exit 1
fi

echo "[preflight] OK"
