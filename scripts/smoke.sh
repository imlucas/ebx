#!/usr/bin/env bash
# CI smoke: the built ebx binary must package a bare fixture app (no
# node_modules, no electron devDependency) for this host's targets.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/target/release/ebx"
[ -f "$BIN.exe" ] && BIN="$BIN.exe"
WARM_ELECTRON=$(node -p "require('$ROOT/VENDOR_VERSIONS.json')['warm-electron']")

FIXTURE=$(mktemp -d)
trap 'rm -rf "$FIXTURE"' EXIT
mkdir -p "$FIXTURE/src"
cat > "$FIXTURE/package.json" << 'EOF'
{ "name": "smoke-app", "version": "1.0.0", "private": true, "main": "src/main.js" }
EOF
echo "const {app}=require('electron');app.whenReady().then(()=>{console.log('booted');app.quit();});" > "$FIXTURE/src/main.js"

cd "$FIXTURE"
COMMON=(-c.electronVersion="$WARM_ELECTRON" -c.appId=dev.ebx.smoke -c.productName=SmokeApp)

"$BIN" --ebx-version

case "$(uname -s)" in
  Darwin)
    "$BIN" --dir "${COMMON[@]}" -c.mac.identity=null
    test -f dist/mac*/SmokeApp.app/Contents/Resources/app.asar
    ./dist/mac*/SmokeApp.app/Contents/MacOS/SmokeApp | grep -q booted
    "$BIN" --win nsis --x64 "${COMMON[@]}"
    ls dist/*.exe
    ;;
  Linux)
    "$BIN" --dir "${COMMON[@]}"
    test -f dist/linux-unpacked/resources/app.asar
    "$BIN" --linux AppImage --x64 "${COMMON[@]}"
    ls dist/*.AppImage
    ;;
  MINGW*|MSYS*|CYGWIN*)
    "$BIN" --dir "${COMMON[@]}"
    test -f dist/win-unpacked/resources/app.asar
    "$BIN" --win nsis --x64 "${COMMON[@]}"
    ls dist/*.exe
    ;;
esac

echo "smoke: OK"
