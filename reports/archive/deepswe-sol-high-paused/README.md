# DeepSWE five-way benchmark — GPT-5.6 Sol high

> **Superseded.** This incomplete paused run is retained as historical evidence and is not used in the current public benchmark summary.

**Status: safely paused.** The 25 completed trials below are preserved and valid. Five interrupted `arcane-drift-detection-baselines` trials are excluded and will be rerun after restart. These are interim measurements, not the final 113-task score.
The `CodexZero` configuration in the raw data is now named **CodexZero Max Savings**. This historical harness used the lean prompt and did not activate compact exec payloads.

Completed paired tasks: **5 / 113**. Complete trials: **25 / 565**.
Recorded job time: **2.84 hours** across **8** attempts.

| Configuration | Resolved | Feature tests | Regression tests | Partial | Provider tokens | Cache ratio | Model calls | Tool calls | RTK calls | RTK terminal tokens saved | Agent time | Sol credits |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Codex | 4/5 (80.00%) | 152/156 | 2,423/2,423 | 0.9963 | 28,991,822 | 97.29% | 325 | 320 | 0 | 0 | 79.9 min | 555.766 |
| CodexZero Max Savings | 1/5 (20.00%) | 148/156 | 2,423/2,423 | 0.9699 | 28,407,625 | 97.39% | 374 | 369 | 0 | 0 | 70.3 min | 527.260 |
| Codex + RTK | 2/5 (40.00%) | 148/156 | 2,423/2,423 | 0.9901 | 25,198,051 | 96.76% | 298 | 293 | 198 | 196,268 | 76.2 min | 497.074 |
| Codex + Caveman | 3/5 (60.00%) | 146/156 | 2,423/2,423 | 0.9826 | 29,299,880 | 97.01% | 333 | 328 | 0 | 0 | 78.2 min | 567.319 |
| Codex + Caveman + RTK | 3/5 (60.00%) | 147/156 | 2,423/2,423 | 0.9758 | 34,069,500 | 97.43% | 369 | 363 | 226 | 279,266 | 90.3 min | 631.879 |

## Paired against stock Codex

| Configuration | Solve Δ | Solve retention | Partial retention | Feature retention | Regression retention | Token savings | Credit savings | API-equivalent cost savings | Agent-time savings | Exact p |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| CodexZero Max Savings | -60.00% | 25.00% | 97.35% | 97.37% | 100.00% | 584,197 (2.02%) | 28.505 (5.13%) | $1.14 (5.13%) | 9.6 min (12.01%) | 0.2500 |
| Codex + RTK | -40.00% | 50.00% | 99.38% | 97.37% | 100.00% | 3,793,771 (13.09%) | 58.692 (10.56%) | $2.35 (10.56%) | 3.7 min (4.62%) | 0.5000 |
| Codex + Caveman | -20.00% | 75.00% | 98.63% | 96.05% | 100.00% | -308,058 (-1.06%) | -11.554 (-2.08%) | $-0.46 (-2.08%) | 1.6 min (2.02%) | 1.0000 |
| Codex + Caveman + RTK | -20.00% | 50.00% | 97.94% | 96.71% | 100.00% | -5,077,678 (-17.51%) | -76.113 (-13.70%) | $-3.04 (-13.70%) | -10.4 min (-13.07%) | 1.0000 |

## Interpretation limits

- Quality comparisons use only tasks with a complete, valid trial for every configuration.
- Provider token counters are authoritative Codex session counters. A cache hit is measurable as cached input tokens per model call; no discrete provider-side cache-event counter is exposed.
- Sol credit estimates use the official ChatGPT rates: 125 credits/M uncached input, 12.5/M cached input, and 750/M output.
- `pier_litellm_cost_usd` in the machine-readable files is Pier/LiteLLM's API-equivalent estimate, not a ChatGPT subscription invoice.
- Infrastructure failures and quota stops are retained in the checkpoint but excluded from quality scores.

Credit source: https://learn.chatgpt.com/docs/pricing#what-are-tokens-and-credits
