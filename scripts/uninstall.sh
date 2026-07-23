#!/usr/bin/env sh
set -eu
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
if [ -x "$CODEX_HOME/bin/codex-zero" ]; then
  "$CODEX_HOME/bin/codex-zero" monitor --stop || true
fi
rm -rf -- "$CODEX_HOME/codexzero"
rm -f -- "$CODEX_HOME/bin/codex-zero" "$CODEX_HOME/codexzero.config.toml"
printf 'CodexZero removed. Stock Codex was not changed.\n'
