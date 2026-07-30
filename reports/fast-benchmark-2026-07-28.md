# CodexZero fast benchmark

Captured 2026-07-28T02:35:28.382137+00:00.
Fresh execution: **327 completed agent cells**.

## Verdict

**Strongest defensible claim:** on the public Terminal-Bench 2.1 replication, CodexZero Safe matched stock quality (29/36 vs. 29/36) while using 14.63% fewer provider tokens and 7.40% less API-equivalent cost.

All three current modes passed every fresh micro task and check. **Safe** had the highest cache ratio (84.0%) and lowest measured cost per cell ($0.062); **Standard** removed the most provider tokens (17.1%) and reduced weighted cost (20.2%); **Focused** saved 13.5% and had the lowest median wall time of the three (18.5s).

The three-task real-repository DeepSWE stress test points in the same direction: CodexZero matched stock resolved quality (2/3 vs. 2/3) with 32.5% fewer provider tokens and 24.3% lower weighted cost.

Use the Terminal-Bench result as the headline. Use the micro suite to show *why*: fewer tokens and lower weighted cost at check-level quality, not a coarse 6/10 score.

## Fresh micro suite

Six deterministic coding/terminal workloads, three shuffled seeds. Stock, RTK, Caveman, and RTK+Caveman each have 36 independent cells; current CodexZero modes and most other options have 18. LeanCTX is a six-cell two-workload directional subset.

| Option | Task pass | Verifier checks | Mean tokens | Cache ratio | Mean API-eq. cost | Token Δ | Cost Δ | Median time |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Stock Codex | 36/36 (100.0%) | 294/294 (100.0%) | 46,772 | 76.2% | $0.081 | baseline | baseline | 20.1s |
| CodexZero Safe v0.4 | 18/18 (100.0%) | 147/147 (100.0%) | 44,275 | 84.0% | $0.062 | -4.3% | -19.0% | 19.6s |
| CodexZero Standard v0.4 | 18/18 (100.0%) | 147/147 (100.0%) | 38,777 | 78.1% | $0.065 | -17.1% | -20.2% | 20.7s |
| CodexZero Focused v0.4 | 18/18 (100.0%) | 147/147 (100.0%) | 40,454 | 77.5% | $0.069 | -13.5% | -15.6% | 18.5s |
| Codex + RTK | 35/36 (97.2%) | 293/294 (99.7%) | 48,979 | 71.9% | $0.095 | +4.7% | +16.5% | 17.9s |
| Codex + Caveman | 36/36 (100.0%) | 294/294 (100.0%) | 65,063 | 77.4% | $0.115 | +39.1% | +40.8% | 29.3s |
| Codex + RTK + Caveman | 36/36 (100.0%) | 294/294 (100.0%) | 68,536 | 77.2% | $0.124 | +46.5% | +53.1% | 31.9s |
| Context Mode 1.0.169 | 15/18 (83.3%) | 144/147 (98.0%) | 87,220 | 73.7% | $0.180 | +86.5% | +121.7% | 46.1s |
| LeanCTX 3.9.12 | 5/6 (83.3%) | 50/51 (98.0%) | 128,454 | 81.2% | $0.195 | +159.8% | +145.6% | 171.5s |
| Headroom 0.32.1 proxy-only | 0/18 (0.0%) | 114/147 (77.6%) | 41,612 | 75.9% | $0.078 | -11.0% | -3.6% | 47.3s |
| Headroom 0.32.1 default stack | 0/18 (0.0%) | 99/147 (67.3%) | 77,293 | 74.3% | $0.147 | +65.3% | +81.0% | 65.1s |
| CodexZero legacy lean-prompt adapter | 18/18 (100.0%) | 147/147 (100.0%) | 39,767 | 76.5% | $0.070 | -15.9% | -19.4% | 21.7s |

API-equivalent cost weights uncached input at $5/M, cached input at $0.50/M, and output at $30/M. It is a normalized proxy, not an invoice.

### Paired token detail

| Option | Cells | Lower / higher | Token change | Token 95% interval | Cost change | Cost 95% interval | Reference |
|---|---:|---:|---:|---:|---:|---:|---|
| CodexZero Safe v0.4 | 18 | 12 / 6 | -4.3% | [-7.0%, -2.1%] | -19.0% | [-33.8%, +0.9%] | same-run stock cell |
| CodexZero Standard v0.4 | 18 | 17 / 1 | -17.1% | [-22.5%, -12.1%] | -20.2% | [-41.1%, +3.1%] | mean of the two stock executions for each seed/workload |
| CodexZero Focused v0.4 | 18 | 15 / 3 | -13.5% | [-20.5%, -6.8%] | -15.6% | [-38.5%, +13.8%] | mean of the two stock executions for each seed/workload |
| Codex + RTK | 36 | 12 / 24 | +4.7% | [-0.5%, +9.8%] | +16.5% | [-3.1%, +41.6%] | same-run stock cell |
| Codex + Caveman | 36 | 1 / 35 | +39.1% | [+32.5%, +46.1%] | +40.8% | [+23.0%, +61.1%] | same-run stock cell |
| Codex + RTK + Caveman | 36 | 0 / 36 | +46.5% | [+38.4%, +54.4%] | +53.1% | [+31.4%, +79.1%] | same-run stock cell |
| Context Mode 1.0.169 | 18 | 0 / 18 | +86.5% | [+58.9%, +113.6%] | +121.7% | [+79.5%, +169.3%] | mean of the two stock executions for each seed/workload |
| LeanCTX 3.9.12 | 6 | 0 / 6 | +159.8% | [+116.3%, +193.6%] | +145.6% | [+101.8%, +202.3%] | mean of the two stock executions for each seed/workload |
| Headroom 0.32.1 proxy-only | 18 | 8 / 10 | -11.0% | [-33.2%, +12.6%] | -3.6% | [-25.4%, +29.8%] | mean of the two stock executions for each seed/workload |
| Headroom 0.32.1 default stack | 18 | 5 / 13 | +65.3% | [+6.3%, +127.6%] | +81.0% | [+39.8%, +136.4%] | mean of the two stock executions for each seed/workload |
| CodexZero legacy lean-prompt adapter | 18 | 16 / 2 | -15.9% | [-23.7%, -9.1%] | -19.4% | [-39.3%, +8.6%] | same-run stock cell |

## Public Terminal-Bench 2.1 replication

12 tasks × 3 repetitions × 3 configurations = 108 official verifier cells.

| Option | Official pass | Verifier subtests | Total tokens | Cache ratio | API-eq. cost |
|---|---:|---:|---:|---:|---:|
| Codex | 29/36 (80.6%) | 92/105 | 26,580,391 | 95.0% | $25.14 |
| CodexZero Safe | 29/36 (80.6%) | 91/105 | 22,691,418 | 93.8% | $23.28 |
| Codex + RTK | 32/36 (88.9%) | 95/105 | 31,550,572 | 95.0% | $28.96 |

## Real-repository DeepSWE stress test

3 difficult repositories × 5 configurations = 15 validated trials, launched as 15 concurrent agent cells. Batch wall time: 28.2 minutes.

| Option | Resolved | Feature tests | Regression tests | Provider tokens | Cache ratio | API-eq. cost |
|---|---:|---:|---:|---:|---:|---:|
| Stock Codex | 2/3 | 147/149 | 1815/1815 | 29,597,398 | 97.8% | $20.81 |
| CodexZero lean-prompt adapter | 2/3 | 147/149 | 1815/1815 | 19,987,849 | 96.6% | $15.74 |
| Codex + RTK | 1/3 | 145/149 | 1815/1815 | 17,757,324 | 96.8% | $14.46 |
| Codex + Caveman | 2/3 | 147/149 | 1815/1815 | 26,770,701 | 97.7% | $19.44 |
| Codex + RTK + Caveman | 1/3 | 145/149 | 1815/1815 | 17,954,294 | 97.0% | $14.27 |

CodexZero and stock produced identical aggregate quality on this three-task sample. The sample is directional, not a general solve-rate estimate.

## Factorial interaction check

3 seeds × 12 configurations × 1 deterministic command-analysis payload (36 cells).

| Combination | Pass | Mean tokens | Mean API-eq. cost |
|---|---:|---:|---:|
| max-save | 3/3 | 33,725 | $0.140 |
| max-save+caveman | 3/3 | 34,379 | $0.145 |
| max-save+rtk | 3/3 | 33,555 | $0.159 |
| max-save+rtk+caveman | 3/3 | 45,484 | $0.147 |
| safe | 3/3 | 38,577 | $0.136 |
| safe+caveman | 3/3 | 57,860 | $0.181 |
| safe+rtk | 3/3 | 37,802 | $0.127 |
| safe+rtk+caveman | 2/3 | 58,966 | $0.170 |
| stock | 3/3 | 41,594 | $0.171 |
| stock+caveman | 3/3 | 60,865 | $0.200 |
| stock+rtk | 3/3 | 41,371 | $0.154 |
| stock+rtk+caveman | 3/3 | 61,822 | $0.174 |

## Positioning

CodexZero’s strongest lane is **quality-preserving context efficiency**. The proof is not that it always has the highest cache percentage. The proof is that it can keep the same verified result while reducing total provider work and weighted cost.

Show three layers:

1. **Headline:** equal official Terminal-Bench quality, 14.63% fewer tokens.
2. **Mechanism:** uncached, cached, output, requests, and weighted cost at per-cell resolution.
3. **Trust:** every raw stream is hashed, every usage identity is checked, and failures stay in the denominator.

## Limits

- The fresh micro suite is intentionally fast and synthetic; it is diagnostic, not a leaderboard.
- Parallel execution increases throughput but makes wall-clock comparisons directional because jobs share the host and provider.
- LeanCTX covers only two workloads in the fresh run.
- The fresh DeepSWE stress test contains three repositories; its quality interval is necessarily wide.
- Headroom proxy-only isolates its proxy; the default-stack row includes its bundled context tools.
- Cache ratio is diagnostic. A larger cache can coexist with more total tokens and higher cost.
- API-equivalent cost uses a fixed normalized rate card and is not a billed amount.

Evidence audit: **passed** — 552 raw files and 276 usage identities verified.
