#!/usr/bin/env sh
set -eu
REPO="Retro2512/CodexZero"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) ASSET="codex-zero-macos-arm64.tar.gz" ;;
  x86_64|amd64) ASSET="codex-zero-macos-x64.tar.gz" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac
URL="https://github.com/$REPO/releases/latest/download/$ASSET"
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT INT TERM
curl -fL "$URL" -o "$TEMP/codex-zero.tar.gz"
curl -fL "$URL.sha256" -o "$TEMP/codex-zero.tar.gz.sha256"
EXPECTED="$(awk '{print $1}' "$TEMP/codex-zero.tar.gz.sha256")"
ACTUAL="$(shasum -a 256 "$TEMP/codex-zero.tar.gz" | awk '{print $1}')"
[ "$EXPECTED" = "$ACTUAL" ] || { echo "CodexZero package checksum verification failed." >&2; exit 1; }
tar -C "$TEMP" -xzf "$TEMP/codex-zero.tar.gz"
sh "$TEMP/scripts/install.sh" "$TEMP"
