# DeepSWE five-way benchmark — GPT-5.6 Sol high

> **Superseded.** This historical harness does not represent the current public benchmark.

Completed paired tasks: **10 / 10**. Complete trials: **50 / 50**.
The `CodexZero` configuration in the raw data is now named **CodexZero Max Savings**. This historical harness applied the lean prompt but omitted `CODEX_ZERO_ARTIFACT_DIR`, so compact exec payloads were not active. It does not score the current Safe mode.
Recorded job time: **6.01 hours** across **13** attempts.
Parallel five-task batch wall time: **81.0 minutes**, with up to **25 concurrent trials**.
All 50 trials used **383,840,459 provider tokens**, **6,891.506 Sol credits**, and **$275.66 API-equivalent cost**. The new parallel 25-trial batch accounted for **237,873,581 tokens**, **4,112.206 credits**, and **$164.49**.
Artifact audit: **50 unique trials, 0 validation errors**.

| Configuration | Resolved | Feature tests | Regression tests | Partial | Provider tokens | Cache ratio | Model calls | Tool calls | RTK calls | RTK terminal tokens saved | Agent time | Sol credits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Codex | 8/10 (80.00%) | 353/357 | 20,428/20,429 | 0.9898 | 67,547,467 | 97.61% | 698 | 688 | 0 | 0 | 180.1 min | 1,238.611 |
| CodexZero Max Savings | 6/10 (60.00%) | 349/357 | 20,429/20,429 | 0.9849 | 64,337,730 | 97.70% | 755 | 745 | 0 | 0 | 170.5 min | 1,159.909 |
| Codex + RTK | 7/10 (70.00%) | 349/357 | 20,429/20,429 | 0.9951 | 76,577,342 | 97.41% | 754 | 743 | 403 | 5,663,317 | 192.2 min | 1,385.367 |
| Codex + Caveman | 7/10 (70.00%) | 346/357 | 20,428/20,429 | 0.9808 | 68,866,428 | 97.42% | 718 | 708 | 0 | 0 | 181.0 min | 1,269.666 |
| Codex + Caveman + RTK | 8/10 (80.00%) | 348/357 | 20,429/20,429 | 0.9879 | 106,511,492 | 97.83% | 1,034 | 1,023 | 515 | 8,979,469 | 253.6 min | 1,837.953 |

## Operational totals

| Configuration | Model calls | Calls with cached input | Agent steps | Assistant text turns | Tool calls | Shell calls | Patch calls | Context summaries | Trial wall time | API-equivalent cost |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Codex | 698 | 695 (99.57%) | 698 | 101 | 688 | 290 | 121 | 1 | 221.6 min | $49.54 |
| CodexZero Max Savings | 755 | 753 (99.74%) | 755 | 69 | 745 | 271 | 137 | 0 | 210.8 min | $46.40 |
| Codex + RTK | 754 | 747 (99.07%) | 754 | 114 | 743 | 241 | 96 | 1 | 234.0 min | $55.41 |
| Codex + Caveman | 718 | 713 (99.30%) | 718 | 141 | 708 | 206 | 112 | 1 | 221.9 min | $50.79 |
| Codex + Caveman + RTK | 1,034 | 1,029 (99.52%) | 1,034 | 165 | 1,023 | 247 | 123 | 1 | 293.9 min | $73.52 |

## Task scores

Each cell is `resolved reward / partial reward`.

| Task | Codex | CodexZero Max Savings | Codex + RTK | Codex + Caveman | Codex + Caveman + RTK |
|---|---:|---:|---:|---:|---:|
| `arktype-json-schema-refs-dependencies` | 1 / 1.0000 | 0 / 0.9988 | 0 / 0.9988 | 1 / 1.0000 | 1 / 1.0000 |
| `testem-per-launcher-reports` | 1 / 1.0000 | 1 / 1.0000 | 1 / 1.0000 | 1 / 1.0000 | 1 / 1.0000 |
| `happy-dom-deterministic-intersectionobserver` | 1 / 1.0000 | 0 / 0.8696 | 1 / 1.0000 | 1 / 1.0000 | 0 / 0.9565 |
| `anko-typed-variable-bindings` | 1 / 1.0000 | 0 / 0.9903 | 0 / 0.9612 | 0 / 0.9223 | 0 / 0.9223 |
| `koota-query-predicates` | 0 / 0.9814 | 0 / 0.9907 | 0 / 0.9907 | 0 / 0.9907 | 1 / 1.0000 |
| `arcane-drift-detection-baselines` | 1 / 1.0000 | 1 / 1.0000 | 1 / 1.0000 | 1 / 1.0000 | 1 / 1.0000 |
| `abs-stepped-slices` | 0 / 0.9167 | 1 / 1.0000 | 1 / 1.0000 | 1 / 1.0000 | 1 / 1.0000 |
| `csstree-shorthand-expansion-compression` | 1 / 1.0000 | 1 / 1.0000 | 1 / 1.0000 | 1 / 1.0000 | 1 / 1.0000 |
| `dynamodb-toolbox-conditional-attribute-requirements` | 1 / 1.0000 | 1 / 1.0000 | 1 / 1.0000 | 1 / 1.0000 | 1 / 1.0000 |
| `go-critic-doc-link-checker` | 1 / 1.0000 | 1 / 1.0000 | 1 / 1.0000 | 0 / 0.8947 | 1 / 1.0000 |

## Paired against stock Codex

| Configuration | Solve Δ | Solve retention | Partial retention | Feature retention | Regression retention | Token savings | Credit savings | API-equivalent cost savings | Agent-time savings | Exact p |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| CodexZero Max Savings | -20.00% | 62.50% | 99.51% | 98.87% | 100.00% | 3,209,737 (4.75%) | 78.702 (6.35%) | $3.15 (6.35%) | 9.7 min (5.37%) | 0.6250 |
| Codex + RTK | -10.00% | 75.00% | 100.53% | 98.87% | 100.00% | -9,029,875 (-13.37%) | -146.756 (-11.85%) | $-5.87 (-11.85%) | -12.0 min (-6.68%) | 1.0000 |
| Codex + Caveman | -10.00% | 75.00% | 99.09% | 98.02% | 100.00% | -1,318,961 (-1.95%) | -31.056 (-2.51%) | $-1.24 (-2.51%) | -0.8 min (-0.46%) | 1.0000 |
| Codex + Caveman + RTK | 0.00% | 75.00% | 99.81% | 98.58% | 100.00% | -38,964,025 (-57.68%) | -599.342 (-48.39%) | $-23.97 (-48.39%) | -73.5 min (-40.80%) | 1.0000 |

## Interpretation limits

- Quality comparisons use only tasks with a complete, valid trial for every configuration.
- This staged sample contains the completed pilot task plus nine tasks from the seed-2512 order. It is not a leaderboard submission, a random sample of all 113 tasks, or a full-corpus estimate.
- The bootstrap 95% interval for Max Savings’ resolved-rate difference versus Codex is -60 to +20 percentage points. Ten tasks do not establish losslessness or a general quality difference.
- Five task shards and their configurations ran concurrently. Agent and wall-time measurements include shared-host contention and should not be treated as sequential latency rankings.
- Provider token counters are authoritative Codex session counters. A cache hit is measurable as cached input tokens per model call; no discrete provider-side cache-event counter is exposed.
- Sol credit estimates use the official ChatGPT rates: 125 credits/M uncached input, 12.5/M cached input, and 750/M output.
- `pier_litellm_cost_usd` in the machine-readable files is Pier/LiteLLM's API-equivalent estimate, not a ChatGPT subscription invoice.
- Infrastructure failures and quota stops are retained in the checkpoint but excluded from quality scores.
- One source checkpoint was reconciled after a generic `rate limit` log matcher falsely matched the Arcane task's application text. The original checkpoint was retained; all five trials were revalidated against complete grader and telemetry artifacts.

Credit source: https://learn.chatgpt.com/docs/pricing#what-are-tokens-and-credits
