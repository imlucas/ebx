#!/bin/sh
# Installs the latest ebx release binary to ~/.local/bin.
# While the repo is private this uses `gh` (authenticated); once public, a
# plain-curl variant can replace it.
set -eu

REPO="${EBX_REPO:-imlucas/ebx}"
DEST="${EBX_INSTALL_DIR:-$HOME/.local/bin}"

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) SLUG=darwin-arm64 ;;
  Linux-x86_64) SLUG=linux-x64 ;;
  MINGW*-x86_64 | MSYS*-x86_64) SLUG=win32-x64 ;;
  *) echo "ebx: no prebuilt binary for $(uname -s)-$(uname -m) yet" >&2; exit 1 ;;
esac

command -v gh > /dev/null || { echo "ebx install: gh CLI required while the repo is private" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
gh release download --repo "$REPO" --pattern "ebx-$SLUG*" --pattern SHA256SUMS --dir "$TMP"

cd "$TMP"
grep "ebx-$SLUG" SHA256SUMS | shasum -a 256 -c -

mkdir -p "$DEST"
BIN="ebx-$SLUG"
[ -f "$BIN.exe" ] && BIN="$BIN.exe"
OUT="$DEST/ebx"
[ "${BIN##*.}" = "exe" ] && OUT="$DEST/ebx.exe"
mv "$BIN" "$OUT"
chmod +x "$OUT"
echo "installed $OUT"
"$OUT" --ebx-version
