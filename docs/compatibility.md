# Compatibility

## Release targets

| Platform | Package |
|---|---|
| Windows x64 | `codex-zero-windows-x64.zip` |
| macOS Intel | `codex-zero-macos-x64.tar.gz` |
| macOS Apple silicon | `codex-zero-macos-arm64.tar.gz` |

Release packages include a Node runtime for the wrapper and monitor. Source-checkout installs can use Node.js 20 or newer already on the system.

## Codex versions

The patched core is built from the official stable upstream tag `rust-v0.146.0`. It was verified alongside:

- Codex Desktop package `26.721.4979.0` with embedded runtime `0.146.0-alpha.3.1`;
- stock Codex CLI `0.139.0`.

CodexZero installs side by side, so it can coexist with other stock Codex versions. It never patches an installed executable. `codex-zero stock` resolves the user’s current stock `codex` command.

Core patches are version-specific. A future upstream version needs a reviewed patch refresh and regression run before CodexZero claims binary compatibility. Unsupported stock versions still remain untouched and available through the fallback.

The Standard, Max Savings, and Focused prompt is benchmarked against dated model-instruction snapshots. A future model can have a different baseline and should be remeasured. Focused requires the pinned core's code-mode runtime; Safe remains the compatibility fallback.

Machine-readable details live in [`config/compatibility.json`](../config/compatibility.json).

## Desktop

Codex Desktop and CLI share `~/.codex/config.toml`, so the verified config-only reasoning-summary setting is available to both.

For binary optimizations:

1. Quit Codex Desktop completely.
2. Run `codex-zero desktop`.

The launcher uses Desktop’s supported `CODEX_CLI_PATH` environment override and forces a fresh CLI-backed app server. In Standard, Max Savings, and Focused modes the side-by-side core receives the bundled `model_instructions_file`; Safe mode omits it. Standard is the install default. The signed Desktop executable remains unchanged. `codex-zero desktop --check` resolves the current installed executable without starting it.
