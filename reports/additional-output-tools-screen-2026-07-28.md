# Five-way isolated benchmark

Model: `gpt-5.6-sol` · reasoning: `medium` · 6/6 trials completed.

## End-to-end results

| Configuration | Quality | Mean total | Saved vs Codex | 95% CI | Cache token hit | Requests | Tool payload | Visible answer | Mean time |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Codex + sqz 1.3.0 | 3/3 | 60,737 | 0 (0.00%) | 0 to 0 | 81.4% | 3.67 | 1,243 | 104 | 22.9s |
| Codex + Squeez 1.44.0 | 3/3 | 63,440 | 0 (0.00%) | 0 to 0 | 65.6% | 3.67 | 3,559 | 93 | 23.0s |

Positive savings mean fewer provider-counted tokens than the paired Codex trial for the same workload and repetition.

## Evidence audit

Status: **passed**. 6 raw exec streams and 16 provider-visible tool payloads were rehashed before this report was written.

## Paired direction and exact test

| Configuration | Lower-token trials | Equal | Higher-token trials | Net tokens saved | Net saved | Exact sign-test p |
|---|---:|---:|---:|---:|---:|---:|
| Codex + sqz 1.3.0 | 0 | 0 | 0 | 0 | 0.00% | 1 |
| Codex + Squeez 1.44.0 | 0 | 0 | 0 | 0 | 0.00% | 1 |

## Provider-token accounting

| Configuration | Mean input | Mean cached | Mean uncached | Mean cache write | Mean output | Mean reasoning | Mean total |
|---|---:|---:|---:|---:|---:|---:|---:|
| Codex + sqz 1.3.0 | 60,194 | 48,981 | 11,213 | 0 | 542 | 134 | 60,737 |
| Codex + Squeez 1.44.0 | 62,990 | 41,301 | 21,688 | 0 | 450 | 93 | 63,440 |

## Cache accounting

| Configuration | Requests | Cache-hit requests | Request hit rate | Input | Cached input | Uncached input | Token hit ratio |
|---|---:|---:|---:|---:|---:|---:|---:|
| Codex + sqz 1.3.0 | 11 | 10 | 90.9% | 180,583 | 146,944 | 33,639 | 81.4% |
| Codex + Squeez 1.44.0 | 11 | 8 | 72.7% | 188,969 | 123,904 | 65,065 | 65.6% |

## Execution accounting

| Configuration | Inferences | Session calls | Shell executions | File changes | Shell output | Provider tool payload | Visible assistant | Final answer | Mean time |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Codex + sqz 1.3.0 | 3.67 | 2.33 | 2.33 | 0.33 | 1,142 | 1,243 | 104 | 39 | 22.9s |
| Codex + Squeez 1.44.0 | 3.67 | 2.00 | 2.00 | 0.33 | 3,455 | 3,559 | 93 | 38 | 23.0s |

## Optimizer-native measurements

| Configuration | CZ events | CZ transformed | CZ original | CZ selected | CZ removed | RTK commands | RTK input | RTK output | RTK removed | RTK fallbacks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Codex + sqz 1.3.0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0/0 |
| Codex + Squeez 1.44.0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0/0 |

## Results by workload

| Workload | Configuration | Quality | Mean total | Saved vs Codex | 95% CI | Cache token hit | Mean time |
|---|---|---:|---:|---:|---:|---:|---:|
| repetitive_log | Codex + sqz 1.3.0 | 1/1 | 32,049 | 0 | 0 to 0 | 47.8% | 16.1s |
| repetitive_log | Codex + Squeez 1.44.0 | 1/1 | 39,859 | 0 | 0 to 0 | 38.1% | 11.3s |
| git_diff | Codex + sqz 1.3.0 | 1/1 | 68,797 | 0 | 0 to 0 | 84.0% | 24.8s |
| git_diff | Codex + Squeez 1.44.0 | 1/1 | 69,097 | 0 | 0 to 0 | 69.0% | 23.6s |
| code_fix | Codex + sqz 1.3.0 | 1/1 | 81,364 | 0 | 0 to 0 | 92.2% | 27.9s |
| code_fix | Codex + Squeez 1.44.0 | 1/1 | 81,364 | 0 | 0 to 0 | 76.1% | 34.2s |

## Controls and scope

- Codex uses the untouched official Windows binary from the exact same `0.145.0-alpha.30` release as CodexZero’s patched core. Its retained npm archive matches the registry SHA-512 integrity value.
- Every run uses a fresh thread and a disposable workspace. Codex homes, Caveman files, CodexZero telemetry, and RTK databases are isolated from the user installation.
- RTK adoption is natural: the exact RTK instruction file is present, but task prompts do not force an `rtk` prefix.
- Cache reads, cache writes, hits by request, and cached/uncached input tokens are taken from provider counters for every inference.
- CodexZero’s selected payload must never exceed stock. Every stored artifact is rehashed and byte-counted. Any violation fails quality.
- Results are paired within workload and repetition. The report shows 5,000-resample workload-stratified paired bootstrap confidence intervals and exact two-sided sign tests. Mean, median, standard deviation, minimum, maximum, and p95 remain in JSON.
- Provider caching cannot be forcibly cleared. It is measured rather than guessed, and randomized interleaving limits order bias.
- RTK's native counters are secondary diagnostics. End-to-end provider totals remain authoritative. An RTK parse failure is reported with whether its stock-command fallback succeeded.
- Session function calls and public exec-stream command events are reported separately; they are overlapping views and are never added into a fabricated total.
- This fixed corpus is reproducible evidence for these workloads, not a universal percentage for all Codex usage.
