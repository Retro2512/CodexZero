# Changelog

## 0.3.0

- Replaced the old mode names with **Safe** and **Max Savings**.
- Made Safe the default for interactive, unattended, CLI, and Desktop launches.
- Safe preserves Codex model instructions and applies only the guarded tool-result pipeline.
- Max Savings adds the bundled 738-token model prompt.
- Existing `command-output` and `full-lean` installations migrate to Safe and Max Savings respectively.
- Published a sealed six-way Terminal-Bench 2.1 mini-panel with task scores, tokens, cache hits, calls, turns, time, cost, optimizer telemetry, uncertainty, and evidence hashes.
- Published a fresh 108-cell Terminal-Bench replication with three repetitions per task and configuration, 2.78-point score resolution, verifier subtests, paired tests, cluster intervals, and all discarded infrastructure-validation attempts.
- Updated installers, release checks, documentation, benchmark labels, and the public site.

## 0.2.1

- Fixed the Windows bootstrap command when the latest package uses an older installer without mode selection.
- Made unattended Windows installs choose full-lean mode instead of failing when no prompt input is available.

## 0.2.0

- Added installer choice between command-output-only and full-lean modes.
- Made full lean the default for interactive and unattended new installs.
- Added a 738-token lean model prompt that retains concise intermediary updates.
- Preserved global and project instructions; the prompt override applies only to CodexZero launches.
- Added `codex-zero mode` for switching modes without reinstalling.
- Added a separate dated prompt benchmark, projections, verification script, CLI output, and site calculator.

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
- Added content-free usage and savings telemetry counters.
- Added side-by-side Windows and macOS launchers.
- Added signed Desktop launcher using its supported custom CLI path.
- Added stock fallback, installers, CI, release packaging, reports, and visual site.
