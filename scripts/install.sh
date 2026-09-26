#!/usr/bin/env sh
set -eu

PACKAGE_ROOT="${1:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
MODE="${2:-${CODEX_ZERO_INSTALL_MODE:-ask}}"
case "$MODE" in
  command-output) MODE="safe" ;;
  full-lean) MODE="max-save" ;;
esac
case "$MODE" in
  ask)
    if [ -r /dev/tty ] && [ -w /dev/tty ]; then
      printf '\nChoose a CodexZero mode:\n' > /dev/tty
      printf '  1. Standard (default) - use the lean prompt and direct Codex tools\n' > /dev/tty
      printf '  2. Focused - Standard plus scoped batching for tool-heavy work\n' > /dev/tty
      printf '  3. Safe - preserve the direct Codex tool surface and model instructions\n' > /dev/tty
      printf 'Select 1, 2, or 3 [1]: ' > /dev/tty
      IFS= read -r SELECTION < /dev/tty || SELECTION=""
      if [ "$SELECTION" = "2" ]; then
        MODE="focused"
      elif [ "$SELECTION" = "3" ]; then
        MODE="safe"
      else
        MODE="standard"
      fi
    else
      MODE="standard"
      printf 'No interactive terminal detected; using Standard mode.\n'
    fi
    ;;
  safe|standard|max-save|focused) ;;
  *) echo "Install mode must be ask, safe, standard, max-save, or focused." >&2; exit 1 ;;
esac
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
INSTALL_ROOT="$CODEX_HOME/codexzero"
if [ -L "$CODEX_HOME" ] || [ -L "$INSTALL_ROOT" ]; then
  echo "CodexZero install paths must not be symbolic links." >&2
  exit 1
fi
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_ROOT="$CODEX_HOME/backups/codexzero-install-$STAMP"
EXISTING_SHIM="$CODEX_HOME/bin/codex-zero"
MONITOR_PID_PATH="$INSTALL_ROOT/monitor.pid"
ARCH="$(uname -m)"
OS="$(uname -s)"
case "$OS:$ARCH" in
  Darwin:arm64|Darwin:aarch64) PLATFORM="macos-arm64" ;;
  Darwin:x86_64|Darwin:amd64) PLATFORM="macos-x64" ;;
  Linux:x86_64|Linux:amd64) PLATFORM="linux-x64" ;;
  *) echo "Unsupported platform: $OS $ARCH" >&2; exit 1 ;;
esac

CORE="$PACKAGE_ROOT/dist/$PLATFORM/codex-zero-core"
if [ ! -x "$CORE" ]; then
  echo "codex-zero-core is missing. Download a release package first." >&2
  exit 1
fi
BUNDLED_NODE="$PACKAGE_ROOT/runtime/node"
LEAN_PROMPT_SOURCE="$PACKAGE_ROOT/prompts/codex-core-lean-v1.md"
if { [ "$MODE" = "standard" ] || [ "$MODE" = "max-save" ] || [ "$MODE" = "focused" ]; } && [ ! -f "$LEAN_PROMPT_SOURCE" ]; then
  echo "The selected mode requires a model prompt that is missing from this package." >&2
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
if [ -f "$PACKAGE_ROOT/assets/provider-settings.html" ]; then
  mkdir -p "$INSTALL_ROOT/app/assets"
  cp "$PACKAGE_ROOT/assets/provider-settings.html" "$INSTALL_ROOT/app/assets/"
  for asset in "$PACKAGE_ROOT"/assets/native-provider-* "$PACKAGE_ROOT"/assets/native-sidebar-* "$PACKAGE_ROOT"/assets/native-cache-ui.mjs "$PACKAGE_ROOT"/assets/model-pricing.mjs "$PACKAGE_ROOT"/assets/sidebar-performance.mjs "$PACKAGE_ROOT"/assets/transcript-retention.mjs "$PACKAGE_ROOT"/assets/codexzero.*; do
    if [ -f "$asset" ]; then cp "$asset" "$INSTALL_ROOT/app/assets/"; fi
  done
fi
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
if [ ! -e "$CODEX_HOME/codexzero.config.toml" ]; then
  cp "$PACKAGE_ROOT/config/codexzero.config.toml" "$CODEX_HOME/codexzero.config.toml"
fi

# Repair legacy artifact modes using the freshly installed command. The root is
# explicit so an inherited artifact path cannot redirect this upgrade step.
CODEX_HOME="$CODEX_HOME" CODEX_ZERO_HOME="$INSTALL_ROOT" \
  CODEX_ZERO_ARTIFACT_DIR="$INSTALL_ROOT/artifacts" \
  "$NODE" "$INSTALL_ROOT/app/bin/codex-zero.mjs" artifacts repair --json >/dev/null

cat > "$CODEX_HOME/bin/codex-zero" <<EOF
#!/usr/bin/env sh
exec "$NODE" "$INSTALL_ROOT/app/bin/codex-zero.mjs" "\$@"
EOF
chmod +x "$CODEX_HOME/bin/codex-zero"

INSTALL_METADATA="$INSTALL_ROOT/install.json"
LEAN_PROMPT_PATH=""
if [ "$MODE" = "standard" ] || [ "$MODE" = "max-save" ] || [ "$MODE" = "focused" ]; then
  LEAN_PROMPT_PATH="$INSTALL_ROOT/prompts/codex-core-lean-v1.md"
fi
MODE="$MODE" BACKUP_ROOT="$BACKUP_ROOT" LEAN_PROMPT_PATH="$LEAN_PROMPT_PATH" \
  INSTALLED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)" INSTALL_METADATA="$INSTALL_METADATA" \
  "$NODE" -e '
    const fs = require("node:fs");
    fs.writeFileSync(process.env.INSTALL_METADATA, `${JSON.stringify({
      schema: "codex-zero-install-v4",
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
printf 'Run: codex-zero run\nChange mode: codex-zero mode safe|standard|max-save|focused\n'
if [ "$OS" = Darwin ]; then printf 'Desktop: codex-zero desktop\n'; fi
printf 'Savings: codex-zero savings\nStock rollback: codex-zero stock\n'
