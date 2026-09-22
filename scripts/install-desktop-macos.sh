#!/usr/bin/env sh
# Installs the CodexZero app into ~/Applications and opens it.
# Usage: install-desktop-macos.sh [package root] [--applications DIR] [--no-open]
set -eu

PACKAGE_ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
if [ "$#" -gt 0 ] && [ "${1#--}" = "$1" ]; then
  PACKAGE_ROOT="$1"
  shift
fi
MAJOR="$(sw_vers -productVersion | cut -d. -f1)"
if [ "$MAJOR" -lt 13 ]; then
  echo "The CodexZero app requires macOS 13 or later." >&2
  exit 1
fi
NODE="$PACKAGE_ROOT/runtime/node"
if [ ! -x "$NODE" ]; then
  echo "The CodexZero package is incomplete. Download a release package first." >&2
  exit 1
fi
exec "$NODE" "$PACKAGE_ROOT/bin/desktop-macos.mjs" install --package "$PACKAGE_ROOT" "$@"
