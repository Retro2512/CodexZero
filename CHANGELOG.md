# Changelog

## 0.1.4

- Fixed Windows and macOS in-place upgrades while the savings monitor is running.
- Installers now stop the recorded CodexZero monitor, wait for its process to
  release the bundled runtime, and start the monitor again after upgrade.
- Release builds now exercise fresh installation and in-place upgrade on
  Windows, macOS Intel, and macOS Apple silicon before publishing.

## 0.1.3

- Added the default-off event-driven wait guard for empty background-process polls.
- Empty polls now stay local until output, exit, cancellation, interruption, permission pause, or the hard timeout.
- Added Windows unit and unified-exec integration coverage for silent-process waiting.

## 0.1.2

- Regenerated the Bazel dependency lock for the added codec crate.
- Kept the v0.1.1 duplicate-result fix unchanged.

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
