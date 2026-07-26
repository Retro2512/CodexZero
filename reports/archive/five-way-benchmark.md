# Five-way isolated benchmark

> **Superseded.** Retained as historical evidence. It is not used in the current public benchmark summary.

Model: `gpt-5.6-sol` · reasoning: `medium` · 90/90 trials completed.
The `CodexZero` configuration in the raw JSON is now named **CodexZero Max Savings**. It used the bundled lean prompt plus the guarded tool-result pipeline.

## End-to-end results

| Configuration | Quality | Mean total | Saved vs Codex | 95% CI | Cache token hit | Requests | Tool payload | Visible answer | Mean time |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Codex | 18/18 | 46,263 | 0 (0.00%) | 0 to 0 | 72.1% | 2.67 | 2,687 | 75 | 18.1s |
| CodexZero Max Savings | 18/18 | 39,915 | 6,348 (13.72%) | 5,423 to 7,828 | 76.8% | 2.78 | 936 | 40 | 22.4s |
| Codex + RTK | 18/18 | 49,763 | -3,500 (-7.56%) | -3,738 to -3,280 | 76.3% | 2.83 | 2,542 | 75 | 19.8s |
| Codex + Caveman | 18/18 | 67,482 | -21,219 (-45.87%) | -25,983 to -16,761 | 77.5% | 3.61 | 4,386 | 73 | 25.8s |
| Codex + Caveman + RTK | 18/18 | 70,707 | -24,444 (-52.84%) | -27,342 to -21,965 | 79.6% | 3.78 | 3,868 | 73 | 29.9s |

Positive savings mean fewer provider-counted tokens than the paired Codex trial for the same workload and repetition.

## Evidence audit

Status: **passed**. 90 raw exec streams and 192 provider-visible tool payloads were rehashed before this report was written.

## Paired direction and exact test

| Configuration | Lower-token trials | Equal | Higher-token trials | Net tokens saved | Net saved | Exact sign-test p |
|---|---:|---:|---:|---:|---:|---:|
| Codex | 0 | 18 | 0 | 0 | 0.00% | 1 |
| CodexZero Max Savings | 16 | 0 | 2 | 114,267 | 13.72% | 0.00131226 |
| Codex + RTK | 1 | 0 | 17 | -62,994 | -7.56% | 0.00014496 |
| Codex + Caveman | 0 | 0 | 18 | -381,946 | -45.87% | 7.63e-06 |
| Codex + Caveman + RTK | 0 | 0 | 18 | -439,984 | -52.84% | 7.63e-06 |

## Provider-token accounting

| Configuration | Mean input | Mean cached | Mean uncached | Mean cache write | Mean output | Mean reasoning | Mean total |
|---|---:|---:|---:|---:|---:|---:|---:|
| Codex | 45,992 | 33,166 | 12,826 | 0 | 271 | 39 | 46,263 |
| CodexZero Max Savings | 39,659 | 30,450 | 9,210 | 0 | 256 | 61 | 39,915 |
| Codex + RTK | 49,469 | 37,760 | 11,709 | 0 | 293 | 49 | 49,763 |
| Codex + Caveman | 66,948 | 51,911 | 15,037 | 0 | 534 | 176 | 67,482 |
| Codex + Caveman + RTK | 70,060 | 55,737 | 14,323 | 0 | 647 | 249 | 70,707 |

## Cache accounting

| Configuration | Requests | Cache-hit requests | Request hit rate | Input | Cached input | Uncached input | Token hit ratio |
|---|---:|---:|---:|---:|---:|---:|---:|
| Codex | 48 | 40 | 83.3% | 827,851 | 596,992 | 230,859 | 72.1% |
| CodexZero Max Savings | 50 | 43 | 86.0% | 713,867 | 548,096 | 165,771 | 76.8% |
| Codex + RTK | 51 | 45 | 88.2% | 890,450 | 679,680 | 210,770 | 76.3% |
| Codex + Caveman | 65 | 58 | 89.2% | 1,205,064 | 934,400 | 270,664 | 77.5% |
| Codex + Caveman + RTK | 68 | 61 | 89.7% | 1,261,075 | 1,003,264 | 257,811 | 79.6% |

## Execution accounting

| Configuration | Inferences | Session calls | Shell executions | File changes | Shell output | Provider tool payload | Visible assistant | Final answer | Mean time |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Codex | 2.67 | 1.50 | 1.50 | 0.17 | 2,624 | 2,687 | 75 | 44 | 18.1s |
| CodexZero Max Savings | 2.78 | 1.61 | 1.61 | 0.17 | 2,635 | 936 | 40 | 40 | 22.4s |
| Codex + RTK | 2.83 | 1.67 | 1.67 | 0.17 | 2,474 | 2,542 | 75 | 42 | 19.8s |
| Codex + Caveman | 3.61 | 2.39 | 2.39 | 0.17 | 3,746 | 4,386 | 73 | 39 | 25.8s |
| Codex + Caveman + RTK | 3.78 | 2.44 | 2.78 | 0.17 | 3,668 | 3,868 | 73 | 40 | 29.9s |

## Optimizer-native measurements

| Configuration | CZ events | CZ transformed | CZ original | CZ selected | CZ removed | RTK commands | RTK input | RTK output | RTK removed | RTK fallbacks |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Codex | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0/0 |
| CodexZero Max Savings | 29 | 9 | 48,425 | 16,659 | 31,766 | 0 | 0 | 0 | 0 | 0/0 |
| Codex + RTK | 0 | 0 | 0 | 0 | 0 | 26 | 12,573 | 10,092 | 2,481 | 5/5 |
| Codex + Caveman | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0/0 |
| Codex + Caveman + RTK | 0 | 0 | 0 | 0 | 0 | 25 | 12,558 | 10,078 | 2,480 | 6/6 |

## Results by workload

| Workload | Configuration | Quality | Mean total | Saved vs Codex | 95% CI | Cache token hit | Mean time |
|---|---|---:|---:|---:|---:|---:|---:|
| small_fallback | Codex | 3/3 | 31,736 | 0 | 0 to 0 | 47.8% | 12.1s |
| small_fallback | CodexZero Max Savings | 3/3 | 26,863 | 4,873 | 4,858 to 4,887 | 61.3% | 17.0s |
| small_fallback | Codex + RTK | 3/3 | 32,258 | -522 | -565 to -496 | 60.6% | 14.6s |
| small_fallback | Codex + Caveman | 3/3 | 51,066 | -19,330 | -19,503 to -19,058 | 71.5% | 19.9s |
| small_fallback | Codex + Caveman + RTK | 3/3 | 52,138 | -20,403 | -20,528 to -20,188 | 62.4% | 22.8s |
| repetitive_log | Codex | 3/3 | 39,343 | 0 | 0 to 0 | 60.8% | 14.9s |
| repetitive_log | CodexZero Max Savings | 3/3 | 27,618 | 11,725 | 11,440 to 11,906 | 68.2% | 17.0s |
| repetitive_log | Codex + RTK | 3/3 | 40,165 | -822 | -1,007 to -510 | 51.3% | 15.4s |
| repetitive_log | Codex + Caveman | 3/3 | 73,913 | -34,570 | -64,253 to -19,647 | 71.0% | 24.3s |
| repetitive_log | Codex + Caveman + RTK | 3/3 | 60,230 | -20,887 | -21,267 to -20,644 | 70.5% | 26.4s |
| git_diff | Codex | 3/3 | 34,040 | 0 | 0 to 0 | 62.3% | 14.7s |
| git_diff | CodexZero Max Savings | 3/3 | 29,205 | 4,835 | 4,833 to 4,839 | 67.9% | 16.6s |
| git_diff | Codex + RTK | 3/3 | 34,129 | -89 | -106 to -57 | 84.9% | 13.9s |
| git_diff | Codex + Caveman | 3/3 | 53,666 | -19,626 | -19,693 to -19,580 | 77.0% | 21.2s |
| git_diff | Codex + Caveman + RTK | 3/3 | 54,157 | -20,117 | -20,555 to -19,773 | 78.1% | 20.6s |
| failing_stack | Codex | 3/3 | 33,026 | 0 | 0 to 0 | 72.5% | 13.1s |
| failing_stack | CodexZero Max Savings | 3/3 | 27,543 | 5,483 | 5,283 to 5,864 | 72.0% | 16.7s |
| failing_stack | Codex + RTK | 3/3 | 34,195 | -1,169 | -1,525 to -507 | 81.7% | 12.0s |
| failing_stack | Codex + Caveman | 3/3 | 53,309 | -20,283 | -20,619 to -19,704 | 78.7% | 21.1s |
| failing_stack | Codex + Caveman + RTK | 3/3 | 54,326 | -21,300 | -21,702 to -20,689 | 69.9% | 23.5s |
| code_fix | Codex | 3/3 | 65,811 | 0 | 0 to 0 | 85.3% | 27.0s |
| code_fix | CodexZero Max Savings | 3/3 | 65,750 | 61 | -5,120 to 9,099 | 84.5% | 34.7s |
| code_fix | Codex + RTK | 3/3 | 83,591 | -17,780 | -17,859 to -17,641 | 85.3% | 34.8s |
| code_fix | Codex + Caveman | 3/3 | 81,743 | -15,931 | -22,514 to -4,842 | 85.7% | 30.3s |
| code_fix | Codex + Caveman + RTK | 3/3 | 96,221 | -30,410 | -42,033 to -23,489 | 90.5% | 39.7s |
| mixed_validation | Codex | 3/3 | 73,622 | 0 | 0 to 0 | 81.3% | 26.7s |
| mixed_validation | CodexZero Max Savings | 3/3 | 62,511 | 11,111 | 9,657 to 12,045 | 85.3% | 32.3s |
| mixed_validation | Codex + RTK | 3/3 | 74,239 | -617 | -2,153 to 519 | 80.1% | 27.8s |
| mixed_validation | Codex + Caveman | 3/3 | 91,197 | -17,575 | -25,661 to -2,753 | 78.5% | 38.2s |
| mixed_validation | Codex + Caveman + RTK | 3/3 | 107,167 | -33,545 | -50,711 to -24,841 | 88.8% | 46.6s |

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
