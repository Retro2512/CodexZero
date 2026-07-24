# Rollback

## Immediate stock fallback

```sh
codex-zero stock
```

This launches the existing stock `codex` command. No files need to move.

## Keep output optimization but restore existing prompts

```sh
codex-zero mode command-output
```

New CodexZero tasks keep the command-output optimizations and stop applying the bundled lean prompt. Switch back with `codex-zero mode full-lean`.

## Disable individual optimizations

Edit `~/.codex/codexzero.config.toml`:

```toml
[features]
codex_zero_compact_exec_output = false
codex_zero_lossless_terminal_codec = false
codex_zero_exact_duplicate_results = false
codex_zero_event_driven_wait = false
```

Every selector also has an internal stock-payload fallback.

## Uninstall

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\.codex\codexzero\app\scripts\uninstall.ps1"
```

macOS:

```sh
sh "$HOME/.codex/codexzero/app/scripts/uninstall.sh"
```

Installers create a timestamped backup under `~/.codex/backups/`. Uninstall removes CodexZero files and its separate profile. It does not remove stock Codex.
