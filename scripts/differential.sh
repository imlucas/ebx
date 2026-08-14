#!/usr/bin/env bash
# Differential test: the ebx binary and a stock npm-installed electron-builder
# (same pinned version) must package a fixture to EQUIVALENT artifacts —
# identical file inventories and byte sizes in the unpacked output. This is the
# automated form of the manual McFeely byte-equivalence check (2026-08-14).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/target/release/ebx"
[ -f "$BIN.exe" ] && BIN="$BIN.exe"
EB_VERSION=$(cd "$ROOT" && node -p "require('./VENDOR_VERSIONS.json')['electron-builder']")
WARM_ELECTRON=$(cd "$ROOT" && node -p "require('./VENDOR_VERSIONS.json')['warm-electron']")

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
# One fixture COPY per arm: electron-builder only excludes its own output dir,
# so a shared dir would pack arm A's dist into arm B's asar (caught by this
# very harness on its first run — 689-byte vs 263 MB app.asar).
for arm in app-stock app-ebx; do
  mkdir -p "$WORK/$arm/src"
  cat > "$WORK/$arm/package.json" << 'EOF'
{ "name": "diff-app", "version": "1.0.0", "private": true, "main": "src/main.js" }
EOF
  echo "const {app}=require('electron');app.whenReady().then(()=>app.quit());" > "$WORK/$arm/src/main.js"
done

COMMON=(--dir --publish never -c.electronVersion="$WARM_ELECTRON" -c.appId=dev.ebx.diff -c.productName=DiffApp)
[ "$(uname -s)" = Darwin ] && COMMON+=(-c.mac.identity=null)

# Arm A: stock electron-builder at the same pin, its own npm install.
mkdir -p "$WORK/stock"
( cd "$WORK/stock" && npm init -y > /dev/null && npm i --no-audit --no-fund "electron-builder@$EB_VERSION" > /dev/null )
( cd "$WORK/app-stock" && node "$WORK/stock/node_modules/electron-builder/cli.js" "${COMMON[@]}" > "$WORK/stock.log" 2>&1 )

# Arm B: ebx.
( cd "$WORK/app-ebx" && "$BIN" "${COMMON[@]}" > "$WORK/ebx.log" 2>&1 )

# Compare unpacked trees: relative path + byte size, sorted.
inventory() {
  ( cd "$1" && find . -type f | sort | while read -r f; do
      printf '%s %s\n' "$f" "$(wc -c < "$f" | tr -d ' ')"
    done )
}
STOCK_DIR=$(find "$WORK/app-stock/dist" -maxdepth 1 -type d \( -name 'mac*' -o -name '*-unpacked' \) | head -1)
EBX_DIR=$(find "$WORK/app-ebx/dist" -maxdepth 1 -type d \( -name 'mac*' -o -name '*-unpacked' \) | head -1)
inventory "$STOCK_DIR" > "$WORK/stock.txt"
inventory "$EBX_DIR" > "$WORK/ebx.txt"

if diff -u "$WORK/stock.txt" "$WORK/ebx.txt" > "$WORK/diff.txt"; then
  echo "differential: OK — $(wc -l < "$WORK/stock.txt" | tr -d ' ') files, identical inventory and sizes (electron-builder $EB_VERSION)"
else
  echo "differential: MISMATCH between stock electron-builder and ebx output:"
  head -40 "$WORK/diff.txt"
  exit 1
fi
