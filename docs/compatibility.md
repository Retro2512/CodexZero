# Compatibility

## Release targets

| Platform | Package |
|---|---|
| Windows x64 | `codex-zero-windows-x64.zip` |
| macOS Intel | `codex-zero-macos-x64.tar.gz` |
| macOS Apple silicon | `codex-zero-macos-arm64.tar.gz` |

Release packages include a Node runtime for the wrapper and monitor. Source-checkout installs can use Node.js 20 or newer already on the system.

## Codex versions

The patched core is built from upstream tag `rust-v0.145.0-alpha.30`. It was verified alongside:

- Codex Desktop embedded runtime `0.145.0-alpha.30`;
- stock Codex CLI `0.139.0`.

CodexZero installs side by side, so it can coexist with other stock Codex versions. It never patches an installed executable. `codex-zero stock` resolves the user’s current stock `codex` command.

Core patches are version-specific. A future upstream version needs a reviewed patch refresh and regression run before CodexZero claims binary compatibility. Unsupported stock versions still remain untouched and available through the fallback.

The bundled lean prompt is benchmarked against dated model-instruction snapshots. A future model can have a different baseline and should be remeasured. Command-output mode does not depend on that prompt benchmark.

Machine-readable details live in [`config/compatibility.json`](../config/compatibility.json).

## Desktop

Codex Desktop and CLI share `~/.codex/config.toml`, so the verified config-only reasoning-summary setting is available to both.

For binary optimizations:

1. Quit Codex Desktop completely.
2. Run `codex-zero desktop`.

The launcher uses Desktop’s supported `CODEX_CLI_PATH` environment override and forces a fresh CLI-backed app server. In full-lean mode the side-by-side core receives the bundled `model_instructions_file`; command-output mode omits it. The signed Desktop executable remains unchanged. `codex-zero desktop --check` resolves the current installed executable without starting it.
