# Acceptance audit

Status as of 2026-07-24. “Pending” items must pass before release claims full acceptance.

| # | Criterion | Status | Evidence |
|---:|---|---|---|
| 1 | Selected model and reasoning effort unchanged | Pass | Custom profile and outgoing-body regression test |
| 2 | Prompt behavior matches the selected install mode | Pass | Command-output preserves existing model instructions; full-lean applies only the bundled per-launch override; global/project files are unchanged |
| 3 | Capability inventories unchanged | Pass | No inventory-changing patch |
| 4 | Raw artifacts byte-identical | Pass | SHA-256 artifact tests |
| 5 | Every selected payload is smaller | Pass | Exact `o200k_base` strict-selection tests |
| 6 | Equal/larger payload uses fallback | Pass | Strict fallback regression tests |
| 7 | Silent jobs create no intermediate request | Pass | 60-second fixture produced two boundary requests only; event-driven unified-exec integration waits past the stock interval until silent exit |
| 8 | Active exact duplicate is referenced | Pass | Real unified-exec repository-search integration, active-context, and source-state mutation tests |
| 9 | Batched checks preserve commands/results | Pass | Wrapper equivalence test |
| 10 | Existing and new tests pass | Pending | New regressions pass. Full upstream workspace verification remains open |
| 11 | Task success not lower on fixtures | Pass | Exit statuses and complete diagnostics preserved |
| 12 | Polling/batch wall time lower or equal | Partial | Polling equal; batch command execution equal, model wake count structurally reduced |
| 13 | One-command stock rollback | Pass | `codex-zero stock` wrapper and install tests |
| 14 | Calls/tokens/cache/latency/no-gain separated | Pass | `before-after.md` and savings output |
| 15 | Projections never reported as observed | Pass | Separate telemetry, replay, and scenario sections |

Desktop launcher tests cover executable resolution and runtime feature overrides. A published release still needs a clean end-to-end Desktop smoke test on each supported target.

## Remaining release gates

- Run the full upstream Codex test suite after explicit approval.
- Run a clean `codex-zero desktop` smoke test on each supported target.

## Latest source verification

- Real repeated `git grep` output was replaced with an active-result reference while current execution metadata remained present.
- Repository search fingerprints change when searched worktree content changes and reject hidden, link-following, preprocessing, remote, outside-repository, and unproven command shapes.
- Generated `config.schema.json` includes all four default-off CodexZero feature flags and its fixture test passes.
- Event-driven wait unit and unified-exec integration tests pass on Windows; the integration waits beyond the five-second compatibility floor until the silent process exits.
- Bazel dependency lock was regenerated under Bazel 9.0.0 after adding the codec crate.
- Bundled lean prompt manifest verifies 738 `o200k_base` tokens, 4,065 bytes, and its SHA-256.
- CLI mode tests verify selection, switching, missing-prompt failure, and separate prompt-benchmark output.
- `codex-tools`: 86 passed.
- Focused `codex-core` duplicate tests: 2 passed.
- `just fix` passed for `codex-core`, `codex-cli`, and `codex-features`; formatting passed.

## Release evidence

- GitHub Actions release run `30066187627` published Windows x64, Intel macOS, and Apple silicon macOS packages successfully.
- The run reused the checksummed `v0.1.3` cores only after proving an empty `patches/` and runtime `config/` diff. The optimizer core is therefore byte-identical; `v0.1.4` changes installers and packaging.
- All three runners passed fresh installation and an in-place upgrade with the savings monitor active before publishing.
- Public release `v0.1.4` contains all three archives and SHA-256 checksum files.
- Release runners cover bootstrap checksums, archive extraction, the bundled Node runtime, core version, both install modes, active-monitor upgrades, stock rollback, and monitor restart.
- CI run `30066183130` and Pages run `30066183118` passed for commit `51ae4fe`.
