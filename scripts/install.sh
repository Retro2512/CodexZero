#!/usr/bin/env sh
set -eu

PACKAGE_ROOT="${1:-$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)}"
CODEX_HOME="${CODEX_HOME:-$HOME/.codex}"
INSTALL_ROOT="$CODEX_HOME/codexzero"
STAMP="$(date -u +%Y%m%d-%H%M%S)"
BACKUP_ROOT="$CODEX_HOME/backups/codexzero-install-$STAMP"
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
if [ -x "$BUNDLED_NODE" ]; then
  NODE="$BUNDLED_NODE"
elif command -v node >/dev/null 2>&1; then
  NODE="$(command -v node)"
else
  echo "Node.js 20 or newer is required when installing from a source checkout." >&2
  exit 1
fi

mkdir -p "$BACKUP_ROOT" "$INSTALL_ROOT/app" "$INSTALL_ROOT/bin" "$CODEX_HOME/bin"
for item in "$CODEX_HOME/config.toml" "$CODEX_HOME/codexzero.config.toml" "$INSTALL_ROOT"; do
  if [ -e "$item" ]; then cp -R "$item" "$BACKUP_ROOT/"; fi
done
cp -R "$PACKAGE_ROOT/bin" "$PACKAGE_ROOT/src" "$PACKAGE_ROOT/scripts" "$INSTALL_ROOT/app/"
cp "$PACKAGE_ROOT/package.json" "$INSTALL_ROOT/app/"
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

"$INSTALL_ROOT/bin/codex-zero-core" --strict-config --version
"$CODEX_HOME/bin/codex-zero" doctor
"$CODEX_HOME/bin/codex-zero" monitor --start

cat > "$INSTALL_ROOT/install.json" <<EOF
{"schema":"codex-zero-install-v1","installed_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)","backup_root":"$BACKUP_ROOT","stock_command":"codex","rollback_command":"codex-zero stock"}
EOF

printf '\nCodexZero installed.\n'
printf 'Add %s to PATH if needed.\n' "$CODEX_HOME/bin"
printf 'Run: codex-zero run\nDesktop: codex-zero desktop\nSavings: codex-zero savings\nStock rollback: codex-zero stock\n'
