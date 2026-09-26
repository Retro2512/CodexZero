# Rollback

## Immediate stock fallback

```sh
codex-zero stock
```

This launches the existing stock `codex` command. No files need to move.

## Use Safe mode

```sh
codex-zero mode safe
```

New CodexZero tasks keep the guarded tool-result pipeline and stop applying the bundled lean prompt. Switch back with `codex-zero mode standard`.

## Disable individual optimizations

Edit `~/.codex/codexzero.config.toml`:

```toml
[features]
codex_zero_compact_exec_output = false
codex_zero_lossless_terminal_codec = false
codex_zero_command_aware_projection = false
codex_zero_exact_duplicate_results = false
codex_zero_event_driven_wait = false
```

Every selector also has an internal stock-payload fallback.

## Uninstall

Windows desktop: uninstall CodexZero from Windows Settings. For an installation made with the ZIP script, run:

```powershell
& "$env:LOCALAPPDATA\Programs\CodexZero\uninstall-desktop.ps1"
```

Windows CLI:

```powershell
powershell -ExecutionPolicy Bypass -File "$HOME\.codex\codexzero\app\scripts\uninstall.ps1"
```

macOS:

```sh
sh "$HOME/.codex/codexzero/app/scripts/uninstall.sh"
```

CLI installers create a timestamped backup under `~/.codex/backups/`. Desktop uninstall keeps your Codex data and browser profile. It does not remove stock Codex.

## Artifact store

Run artifact pruning to remove raw outputs older than 30 days. The older than days option changes the cutoff. The dry run option previews candidates. Pruning is explicit and can remove raw outputs referenced by old sessions. Run artifact repair to restore private permissions.
