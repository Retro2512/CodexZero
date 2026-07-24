#!/usr/bin/env sh
set -eu

PACKAGE_ROOT="${1:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
MODE="${2:-${CODEX_ZERO_INSTALL_MODE:-ask}}"
case "$MODE" in
  ask)
    if [ -r /dev/tty ] && [ -w /dev/tty ]; then
      printf '\nChoose how CodexZero should optimize Codex:\n' > /dev/tty
      printf '  1. Full lean (default) - command output plus the bundled lean system prompt\n' > /dev/tty
      printf '  2. Command output only - preserve the existing Codex system prompt\n' > /dev/tty
      printf 'Select 1 or 2 [1]: ' > /dev/tty
      IFS= read -r SELECTION < /dev/tty || SELECTION=""
      if [ "$SELECTION" = "2" ]; then MODE="command-output"; else MODE="full-lean"; fi
    else
      MODE="full-lean"
      printf 'No interactive terminal detected; using full-lean mode.\n'
    fi
    ;;
  command-output|full-lean) ;;
  *) echo "Install mode must be ask, command-output, or full-lean." >&2; exit 1 ;;
esac
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
INSTALL_ROOT="$CODEX_HOME/codexzero"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_ROOT="$CODEX_HOME/backups/codexzero-install-$STAMP"
EXISTING_SHIM="$CODEX_HOME/bin/codex-zero"
MONITOR_PID_PATH="$INSTALL_ROOT/monitor.pid"
ARCH="$(uname -m)"
case "$ARCH" in
  arm64|aarch64) PLATFORM="macos-arm64" ;;
  x86_64|amd64) PLATFORM="macos-x64" ;;
  *) echo "Unsupported architecture: $ARCH" >&2; exit 1 ;;
esac

CORE="$PACKAGE_ROOT/dist/$PLATFORM/codex-zero-core"
if [ ! -x "$CORE" ]; then
  echo "codex-zero-core is missing. Download a release package first." >&2
  exit 1
fi
BUNDLED_NODE="$PACKAGE_ROOT/runtime/node"
LEAN_PROMPT_SOURCE="$PACKAGE_ROOT/prompts/codex-core-lean-v1.md"
if [ "$MODE" = "full-lean" ] && [ ! -f "$LEAN_PROMPT_SOURCE" ]; then
  echo "The full-lean prompt is missing from this package." >&2
  exit 1
fi
if [ -x "$BUNDLED_NODE" ]; then
  NODE="$BUNDLED_NODE"
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
else
  echo "Node.js 20 or newer is required when installing from a source checkout." >&2
  exit 1
fi

# Replacing the bundled runtime while the savings monitor is using it can
# terminate or corrupt the running process. Stop only CodexZero's recorded
# monitor and wait for it to release the old runtime before upgrading.
PREVIOUS_MONITOR_PID=""
if [ -f "$MONITOR_PID_PATH" ]; then
  PREVIOUS_MONITOR_PID="$(tr -cd '0-9' < "$MONITOR_PID_PATH")"
fi
if [ -n "$PREVIOUS_MONITOR_PID" ] && [ -x "$EXISTING_SHIM" ]; then
  "$EXISTING_SHIM" monitor --stop
  STOP_ATTEMPTS=0
  while kill -0 "$PREVIOUS_MONITOR_PID" 2>/dev/null; do
    if [ "$STOP_ATTEMPTS" -ge 150 ]; then
      echo "The existing CodexZero savings monitor did not stop within 15 seconds." >&2
      exit 1
    fi
    STOP_ATTEMPTS=$((STOP_ATTEMPTS + 1))
    sleep 0.1
  done
fi

mkdir -p "$BACKUP_ROOT" "$INSTALL_ROOT/app" "$INSTALL_ROOT/bin" "$INSTALL_ROOT/prompts" "$CODEX_HOME/bin"
for item in "$CODEX_HOME/config.toml" "$CODEX_HOME/codexzero.config.toml" "$INSTALL_ROOT"; do
  if [ -e "$item" ]; then cp -R "$item" "$BACKUP_ROOT/"; fi
done
cp -R "$PACKAGE_ROOT/bin" "$PACKAGE_ROOT/src" "$PACKAGE_ROOT/scripts" "$INSTALL_ROOT/app/"
cp "$PACKAGE_ROOT/package.json" "$INSTALL_ROOT/app/"
if [ -d "$PACKAGE_ROOT/prompts" ]; then
  cp -R "$PACKAGE_ROOT/prompts/." "$INSTALL_ROOT/prompts/"
fi
cp "$CORE" "$INSTALL_ROOT/bin/codex-zero-core"
chmod +x "$INSTALL_ROOT/bin/codex-zero-core"
if [ -x "$BUNDLED_NODE" ]; then
  cp "$BUNDLED_NODE" "$INSTALL_ROOT/bin/node"
  chmod +x "$INSTALL_ROOT/bin/node"
  NODE="$INSTALL_ROOT/bin/node"
fi
cp "$PACKAGE_ROOT/config/codexzero.config.toml" "$CODEX_HOME/codexzero.config.toml"

cat > "$CODEX_HOME/bin/codex-zero" <<EOF
#!/usr/bin/env sh
exec "$NODE" "$INSTALL_ROOT/app/bin/codex-zero.mjs" "\$@"
EOF
chmod +x "$CODEX_HOME/bin/codex-zero"

INSTALL_METADATA="$INSTALL_ROOT/install.json"
LEAN_PROMPT_PATH=""
if [ "$MODE" = "full-lean" ]; then
  LEAN_PROMPT_PATH="$INSTALL_ROOT/prompts/codex-core-lean-v1.md"
fi
MODE="$MODE" BACKUP_ROOT="$BACKUP_ROOT" LEAN_PROMPT_PATH="$LEAN_PROMPT_PATH" \
  INSTALLED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" INSTALL_METADATA="$INSTALL_METADATA" \
  "$NODE" -e '
    const fs = require("node:fs");
    fs.writeFileSync(process.env.INSTALL_METADATA, `${JSON.stringify({
      schema: "codex-zero-install-v2",
      installed_at: process.env.INSTALLED_AT,
      backup_root: process.env.BACKUP_ROOT,
      mode: process.env.MODE,
      lean_prompt: process.env.LEAN_PROMPT_PATH || null,
      stock_command: "codex",
      rollback_command: "codex-zero stock"
    }, null, 2)}\n`);
  '

"$INSTALL_ROOT/bin/codex-zero-core" --strict-config --version
"$CODEX_HOME/bin/codex-zero" run --strict-config --version
"$CODEX_HOME/bin/codex-zero" doctor
"$CODEX_HOME/bin/codex-zero" monitor --start

printf '\nCodexZero installed.\n'
printf 'Mode: %s\n' "$MODE"
printf 'Add %s to PATH if needed.\n' "$CODEX_HOME/bin"
printf 'Run: codex-zero run\nChange mode: codex-zero mode command-output|full-lean\nDesktop: codex-zero desktop\nSavings: codex-zero savings\nStock rollback: codex-zero stock\n'
