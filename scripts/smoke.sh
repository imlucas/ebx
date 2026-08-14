#!/usr/bin/env bash
# CI smoke: the built ebx binary must package a bare fixture app (no
# node_modules, no electron devDependency) for this host's targets.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/target/release/ebx"
[ -f "$BIN.exe" ] && BIN="$BIN.exe"
# Relative require: Git Bash $ROOT is a POSIX path Windows node can't resolve.
WARM_ELECTRON=$(cd "$ROOT" && node -p "require('./VENDOR_VERSIONS.json')['warm-electron']")

FIXTURE=$(mktemp -d)
trap 'rm -rf "$FIXTURE"' EXIT
mkdir -p "$FIXTURE/src"
cat > "$FIXTURE/package.json" << 'EOF'
{ "name": "smoke-app", "version": "1.0.0", "private": true, "main": "src/main.js" }
EOF
echo "const {app}=require('electron');app.whenReady().then(()=>{console.log('booted');app.quit();});" > "$FIXTURE/src/main.js"

cd "$FIXTURE"
COMMON=(--publish never -c.electronVersion="$WARM_ELECTRON" -c.appId=dev.ebx.smoke -c.productName=SmokeApp)

"$BIN" --ebx-version

# Self-signed cert for the signing smokes (mac + windows).
make_p12() {
  openssl req -x509 -newkey rsa:2048 -keyout "$FIXTURE/key.pem" -out "$FIXTURE/cert.pem" \
    -days 2 -nodes -subj "/CN=ebx ci signing" -addext "extendedKeyUsage=codeSigning" 2>/dev/null
  openssl pkcs12 -export -out "$FIXTURE/cert.p12" -inkey "$FIXTURE/key.pem" \
    -in "$FIXTURE/cert.pem" -passout pass:ebxci 2>/dev/null
}

# Structural signature check: the PE certificate table must be non-empty and
# carry our cert subject (works on any OS, no signtool needed).
assert_pe_signed() {
  node -e "
    const b = require('fs').readFileSync(process.argv[1]);
    const pe = b.readUInt32LE(0x3c);
    const magic = b.readUInt16LE(pe + 24);
    const dd = pe + 24 + (magic === 0x20b ? 112 : 96);
    const rva = b.readUInt32LE(dd + 4 * 8), size = b.readUInt32LE(dd + 4 * 8 + 4);
    if (!(size > 0 && b.subarray(rva, rva + size).includes(Buffer.from('ebx ci signing'))))
      { console.error('PE signature missing'); process.exit(1); }
    console.log('PE signature present:', size, 'bytes');
  " "$1"
}

case "$(uname -s)" in
  Darwin)
    "$BIN" --dir "${COMMON[@]}" -c.mac.identity=null
    test -f dist/mac*/SmokeApp.app/Contents/Resources/app.asar
    ./dist/mac*/SmokeApp.app/Contents/MacOS/SmokeApp | grep -q booted
    "$BIN" --win nsis --x64 "${COMMON[@]}"
    ls dist/*.exe
    # Signing smokes: self-signed p12 through both platform paths.
    make_p12
    rm -rf dist
    CSC_LINK="file://$FIXTURE/cert.p12" CSC_KEY_PASSWORD=ebxci \
      "$BIN" --win nsis --x64 "${COMMON[@]}"
    assert_pe_signed dist/*.exe
    # macOS codesign requires a TRUSTED identity (a bare self-signed cert shows
    # as CSSMERR_TP_NOT_TRUSTED and electron-builder skips signing — observed on
    # the first CI run). Trust it system-wide where passwordless sudo exists
    # (CI runners); skip on dev machines.
    if sudo -n true 2> /dev/null; then
      sudo security add-trusted-cert -d -r trustRoot \
        -k /Library/Keychains/System.keychain "$FIXTURE/cert.pem"
      rm -rf dist
      CSC_LINK="file://$FIXTURE/cert.p12" CSC_KEY_PASSWORD=ebxci \
        "$BIN" --dir "${COMMON[@]}"
      codesign -dvv dist/mac*/SmokeApp.app 2>&1 | grep -q "ebx ci signing"
      echo "mac codesign identity verified"
    else
      echo "skipping mac codesign smoke (no passwordless sudo to trust the test cert)"
    fi
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
    # Native windows signing smoke (openssl ships with Git Bash).
    make_p12
    rm -rf dist
    CSC_LINK="file://$FIXTURE/cert.p12" CSC_KEY_PASSWORD=ebxci \
      "$BIN" --win nsis --x64 "${COMMON[@]}"
    assert_pe_signed dist/*.exe
    ;;
esac

echo "smoke: OK"
