# Terminal-Bench repeated comparison

| Setup | Score | Total tokens | Reduction |
|---|---:|---:|---:|
| Codex | 29/36 | 26,580,391 | Baseline |
| CodexZero | 29/36 | 22,691,418 | **14.63% fewer** |

**12 tasks · 3 repetitions per setup**

<details>
<summary>Methodology</summary>

- Benchmark: Terminal-Bench 2.1.
- Model: `gpt-5.6-sol` with medium reasoning.
- Sample: 12 tasks selected from the 77 tasks not used in the earlier mini-panel.
- Repetitions: three per task and setup, with task and setup order rotated each repetition.
- Quality measure: the official verifier outcome, producing 36 paired outcomes per setup.
- Token measure: end-to-end provider-counted input and output tokens.
- Comparison: CodexZero Safe against stock Codex using the same task set and repetition schedule.

</details>

<details>
<summary>Technical appendix</summary>

### Paired quality

| Comparison | Score difference | Task-cluster 95% interval | Codex-only passes | CodexZero-only passes | Exact paired p |
|---|---:|---:|---:|---:|---:|
| CodexZero vs Codex | 0.00 points | -8.33% to 8.33% | 1 | 1 | 1.0000 |

### Token and cache accounting

| Setup | Input | Cached input | Uncached input | Output | Cache ratio | Requests |
|---|---:|---:|---:|---:|---:|---:|
| Codex | 26,381,402 | 25,052,928 | 1,328,474 | 198,989 | 95.0% | 817 |
| CodexZero | 22,498,634 | 21,111,040 | 1,387,594 | 192,784 | 93.8% | 735 |

### Efficiency uncertainty

- Mean tokens saved per paired outcome: 108,027.
- Task-cluster 95% interval: 6,687 to 246,248 tokens saved.
- Lower-token outcomes: 22. Higher-token outcomes: 14.
- Two-sided sign-test p: 0.2430.

### Optimizer telemetry

- Payloads inspected: 623.
- Payloads transformed: 1.
- Optimizer-native tokens removed: 39.
- Most of the provider-level difference came from shorter model trajectories rather than payload transformation.

### Infrastructure correction

Two initial validation waves exposed shared container problems: missing certificate bundles in four images and a binary compatibility problem in one QEMU image. The correction was sealed before replacement calls. All 108 final cells were rerun under the corrected setup; no successful cells from the earlier waves were selectively retained.

### Integrity

| Evidence | SHA-256 |
|---|---|
| Preregistration | `f82462d02256d100694fcd3d500cea501e8f882ae11dc7dd66dda817b74212b6` |
| Infrastructure addendum | `8151c7e7eba7f5e14c0e2c2e2dc3b447ebd7edec08c144874fe73c1044483f53` |

Normalized trials, attempts, manifests, preregistration records, and integrity files remain in the GitHub repository. They are not published on the product site.

</details>
