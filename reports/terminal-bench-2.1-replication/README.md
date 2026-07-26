# Repeated three-way Terminal-Bench replication

**CodexZero Safe exactly matched stock Codex across 36 paired official verifier outcomes: 29/36 (80.56%) each.** Codex + RTK scored 32/36 (88.89%), an 8.33-point point estimate whose paired interval includes zero.

This run uses 12 fresh tasks with three repetitions per configuration. The official score therefore moves in 2.78-point increments instead of the earlier 10-point increments. Verifier subtest rates and per-task 0/3–3/3 stability are reported as secondary diagnostics.

## Main result

| Configuration | Official score | 95% Wilson | Task-cluster 95% | Majority task score | Verifier assertions | Task-normalized assertion rate | Provider tokens | vs Codex | API-equivalent cost | vs Codex | Agent time |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Codex | **29/36 (80.56%)** | 64.97% to 90.25% | 58.33% to 100.00% | 10/12 (83.33%) | 92/105 (87.62%) | 89.44% | 26,580,391 | baseline | $25.1385 | baseline | 168.3 min |
| CodexZero Safe | **29/36 (80.56%)** | 64.97% to 90.25% | 58.33% to 100.00% | 10/12 (83.33%) | 91/105 (86.67%) | 87.22% | 22,691,418 | 14.63% less | $23.2770 | 7.40% less | 172.4 min |
| Codex + RTK | **32/36 (88.89%)** | 74.69% to 95.59% | 69.44% to 100.00% | 11/12 (91.67%) | 95/105 (90.48%) | 91.11% | 31,550,572 | 18.70% more | $28.9572 | 15.19% more | 180.8 min |

The official reward remains the primary score. Raw verifier assertions are more granular but overweight tasks with more tests. The normalized rate first averages within each task and repetition, then gives each task equal weight. Neither assertion rate is a Terminal-Bench leaderboard metric.

## Paired quality comparison

| Configuration | Score delta | Task-cluster bootstrap 95% | Codex-only passes | Candidate-only passes | Exact paired p |
|---|---:|---:|---:|---:|---:|
| CodexZero Safe | +0.00 points | -8.33% to 8.33% | 1 | 1 | 1.0000 |
| Codex + RTK | +8.33 points | 0.00% to 22.22% | 0 | 3 | 0.2500 |

RTK's three additional passes were one `path-tracing` repetition and two `pytorch-model-recovery` repetitions. The exact paired result is not statistically significant at this sample size.

## Per-task stability

| Task | Codex | CodexZero Safe | Codex + RTK |
|---|---:|---:|---:|
| `path-tracing` | 2/3 | 3/3 | 3/3 |
| `headless-terminal` | 3/3 | 3/3 | 3/3 |
| `polyglot-rust-c` | 3/3 | 3/3 | 3/3 |
| `log-summary-date-ranges` | 3/3 | 3/3 | 3/3 |
| `pytorch-model-recovery` | 0/3 | 0/3 | 2/3 |
| `qemu-startup` | 3/3 | 3/3 | 3/3 |
| `sqlite-with-gcov` | 3/3 | 3/3 | 3/3 |
| `crack-7z-hash` | 3/3 | 2/3 | 3/3 |
| `compile-compcert` | 0/3 | 0/3 | 0/3 |
| `fix-git` | 3/3 | 3/3 | 3/3 |
| `cobol-modernization` | 3/3 | 3/3 | 3/3 |
| `regex-log` | 3/3 | 3/3 | 3/3 |

## Tokens, cache, calls, turns, time, and cost

| Configuration | Input | Cached | Uncached | Output | Reasoning | Cache ratio | Requests | Cache-hit requests | Tool calls | Shell commands | Agent time | Cost | Codex credits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Codex | 26,381,402 | 25,052,928 | 1,328,474 | 198,989 | 82,222 | 95.0% | 817 | 809 | 787 | 410 | 168.3 min | $25.1385 | 628.463 |
| CodexZero Safe | 22,498,634 | 21,111,040 | 1,387,594 | 192,784 | 81,028 | 93.8% | 735 | 723 | 706 | 408 | 172.4 min | $23.2770 | 581.925 |
| Codex + RTK | 31,344,722 | 29,764,864 | 1,579,858 | 205,850 | 87,717 | 95.0% | 923 | 915 | 891 | 463 | 180.8 min | $28.9572 | 723.931 |

## Efficiency uncertainty

| Configuration | Mean tokens saved/cell | Task-cluster bootstrap 95% | Lower-token cells | Higher-token cells | Sign-test p | Mean cost saved/cell | Cost bootstrap 95% |
|---|---:|---:|---:|---:|---:|---:|---:|
| CodexZero Safe | +108,027 | 6,687 to 246,248 | 22 | 14 | 0.2430 | $+0.0517 | $-0.0251 to $+0.1381 |
| Codex + RTK | -138,061 | -363,235 to 14,365 | 14 | 22 | 0.2430 | $-0.1061 | $-0.3224 to $+0.0402 |

CodexZero Safe used **14.63% fewer provider tokens** and **7.40% less API-equivalent cost** than Codex in total. Its task-cluster efficiency interval is shown above; the observed reduction is driven mainly by shorter model trajectories, not the codec.

RTK used **18.70% more provider tokens** and **15.19% more API-equivalent cost** than Codex in this replication. That reverses the earlier mini-panel's point estimate and confirms that one attempt per task was not enough to rank efficiency.

## Optimizer-native telemetry

| Configuration | Payloads/commands | Transformed | Native tokens saved | Fallbacks |
|---|---:|---:|---:|---:|
| CodexZero Safe | 623 payloads | 1 | 39 | — |
| Codex + RTK | 1,732 commands | — | 237 | 1,698 |

CodexZero transformed one payload. RTK's own database measured only 237 tokens saved across 1,732 commands. These native counters are much smaller than the provider-level differences, so the totals mostly reflect different model trajectories and repeated context.

## Infrastructure correction

The first two 36-cell validation waves exposed two objective container defects: four minimal Ubuntu images lacked a usable CA bundle for all configurations, and the Debian Bullseye QEMU image could not load the glibc-2.39-linked CodexZero benchmark binary. The correction was sealed before the replacement model calls.

The final matrix reran **all 108 cells**, rather than selectively keeping successful cells. It mounted the same CA bundle for all configurations and ran the byte-identical CodexZero binary through a hashed loader wrapper with its build-runtime libraries. The discarded 72 attempts remain in `attempts.json` and are never included in final scores.

## Design and integrity

- Model: `gpt-5.6-sol`, medium reasoning.
- Fresh selection: 12 tasks sampled from the 77 tasks not used in the first mini-panel.
- Repetitions: three per task and configuration; task and configuration orders rotated each repetition.
- Final matrix: 108/108 cells; zero quality retries.
- Official score resolution: 2.78 percentage points.
- Final clean matrix wall time: 68.3 minutes.
- Discarded infrastructure-validation waves: 33.7 minutes.
- Verifier CTRF records: 108/108.
- Provider/session token identities: 108/108.
- Retained agent timeouts: 11; these are model outcomes and score zero.
- Other final-matrix infrastructure exceptions: 0.

Three repetitions improve repeatability and give a 36-outcome score, but the sample still contains only 12 unique tasks. The task-cluster intervals are the appropriate guard against treating repeated attempts as 36 independent task draws.

## Files

- [`preregistration.json`](preregistration.json): sealed task sample and analysis plan.
- [`infrastructure-addendum.json`](infrastructure-addendum.json): sealed correction and runtime hashes.
- [`summary.json`](summary.json): aggregate quality, efficiency, uncertainty, and integrity metrics.
- [`trials.json`](trials.json): every final scored cell.
- [`attempts.json`](attempts.json): all final and discarded validation attempts.
- [`run-manifest.json`](run-manifest.json): wall times and artifact/tree hashes.

Generated by [`tools/analyze-terminal-bench-replication.py`](../../tools/analyze-terminal-bench-replication.py).
