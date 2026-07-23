# Changelog

## 0.1.1

- Fixed exact duplicate detection for real command results whose chunk and timing metadata changes between calls.
- Added repository-state fingerprints for read-only `rg`, `git grep`, and `git ls-files` results.
- Preserved current execution metadata in duplicate references.
- Added a full unified-exec integration test and generated feature-flag schema entries.

## 0.1.0

- Added strictly monotonic compact model payloads.
- Added reversible terminal codec and SHA-256 raw artifact store.
- Added exact duplicate-result references for proven read-only state.
- Added deterministic local validation batches.
- Added privacy-safe usage and savings telemetry.
- Added side-by-side Windows and macOS launchers.
- Added signed Desktop launcher using its supported custom CLI path.
- Added stock fallback, installers, CI, release packaging, reports, and visual site.
