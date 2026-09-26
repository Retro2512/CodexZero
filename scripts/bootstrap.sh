#!/usr/bin/env sh
set -eu
REPO="Retro2512/CodexZero"
OS="$(uname -s)"
ARCH="$(uname -m)"
case "$OS:$ARCH" in
  Darwin:arm64|Darwin:aarch64) ASSET="codex-zero-macos-arm64.tar.gz" ;;
  Darwin:x86_64|Darwin:amd64) ASSET="codex-zero-macos-x64.tar.gz" ;;
  Linux:x86_64|Linux:amd64) ASSET="codex-zero-linux-x64.tar.gz" ;;
  *) echo "Unsupported platform: $OS $ARCH" >&2; exit 1 ;;
esac
VERSION="${CODEX_ZERO_VERSION:-latest}"
if [ "$VERSION" != latest ]; then
  if ! printf '%s\n' "$VERSION" | grep -Eq '^v?[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'; then
    echo "Invalid CodexZero release version." >&2
    exit 1
  fi
  case "$VERSION" in v*) ;; *) VERSION="v$VERSION" ;; esac
fi
case "${CODEX_ZERO_VERIFY_ATTESTATION:-0}" in
  0|1) ;;
  *) echo "CODEX_ZERO_VERIFY_ATTESTATION must be 0 or 1." >&2; exit 1 ;;
esac
if [ "$VERSION" = latest ]; then
  URL="https://github.com/$REPO/releases/latest/download/$ASSET"
else
  URL="https://github.com/$REPO/releases/download/$VERSION/$ASSET"
fi
if [ "${CODEX_ZERO_BOOTSTRAP_PLAN:-0}" = 1 ]; then
  printf '%s\n' "$URL"
  exit 0
fi
TEMP="$(mktemp -d)"
trap 'rm -rf "$TEMP"' EXIT INT TERM
curl -fL "$URL" -o "$TEMP/$ASSET"
curl -fL "$URL.sha256" -o "$TEMP/$ASSET.sha256"
EXPECTED="$(awk '{print $1}' "$TEMP/$ASSET.sha256")"
case "$OS" in
  Linux) ACTUAL="$(sha256sum "$TEMP/$ASSET" | awk '{print $1}')" ;;
  Darwin) ACTUAL="$(shasum -a 256 "$TEMP/$ASSET" | awk '{print $1}')" ;;
esac
[ "$EXPECTED" = "$ACTUAL" ] || { echo "CodexZero package checksum verification failed." >&2; exit 1; }
if [ "${CODEX_ZERO_VERIFY_ATTESTATION:-0}" = 1 ]; then
  command -v gh >/dev/null 2>&1 || { echo "GitHub CLI is required to verify the release attestation." >&2; exit 1; }
  gh attestation verify "$TEMP/$ASSET" --repo "$REPO" --signer-workflow "$REPO/.github/workflows/release.yml" || {
    echo "CodexZero release attestation verification failed." >&2
    exit 1
  }
fi
tar -C "$TEMP" -xzf "$TEMP/$ASSET"
# The app is the default on macOS 13 or later. CODEX_ZERO_INSTALL=cli installs
# the terminal command instead.
if [ "$OS" = Darwin ] && [ "${CODEX_ZERO_INSTALL:-app}" != "cli" ] && [ -f "$TEMP/scripts/install-desktop-macos.sh" ] &&
  [ "$(sw_vers -productVersion | cut -d. -f1)" -ge 13 ]; then
  sh "$TEMP/scripts/install-desktop-macos.sh" "$TEMP"
  exit 0
fi
INSTALL_MODE="${CODEX_ZERO_INSTALL_MODE:-ask}"
if ! grep -q 'max-save' "$TEMP/scripts/install.sh"; then
  case "$INSTALL_MODE" in
    max-save|full-lean) INSTALL_MODE="full-lean" ;;
    *) INSTALL_MODE="command-output" ;;
  esac
fi
sh "$TEMP/scripts/install.sh" "$TEMP" "$INSTALL_MODE"
