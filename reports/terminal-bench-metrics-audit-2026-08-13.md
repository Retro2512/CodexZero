# Terminal-Bench metrics audit

Totals are measured over accepted Harbor trials. Pass-rate denominators include terminal failures; cost and token totals cannot include cells where the provider returned no usage.

## Coverage, quality, and efficiency

| Profile | Coverage | Pass rate (95% Wilson CI) | Measured cost | Cost/pass | Total tokens | Tokens/pass | Usage coverage |
|---|---:|---:|---:|---:|---:|---:|---:|
| Stock Codex 0.145 | 88/88 (100.0%) | 50/88 (56.8%; 46.4–66.7%) | $45.985 | $0.920 | 43,604,218 | 872,084 | 75/88 (85.2%) |
| CodexZero Safe (legacy) | 88/88 (100.0%) | 53/88 (60.2%; 49.8–69.8%) | $53.254 | $1.005 | 51,870,877 | 978,696 | 75/88 (85.2%) |
| CodexZero Max (legacy) | 88/88 (100.0%) | 47/88 (53.4%; 43.1–63.5%) | $42.339 | $0.901 | 35,866,718 | 763,122 | 75/88 (85.2%) |
| Ponytail | 88/88 (100.0%) | 48/88 (54.5%; 44.2–64.5%) | $49.114 | $1.023 | 45,655,849 | 951,164 | 76/88 (86.4%) |
| LeanCTX | 88/88 (100.0%) | 55/88 (62.5%; 52.1–71.9%) | $68.498 | $1.245 | 74,753,429 | 1,359,153 | 74/88 (84.1%) |
| RTK | 88/88 (100.0%) | 50/88 (56.8%; 46.4–66.7%) | $54.242 | $1.085 | 53,608,572 | 1,072,171 | 74/88 (84.1%) |
| Caveman | 88/88 (100.0%) | 48/88 (54.5%; 44.2–64.5%) | $52.997 | $1.104 | 51,236,381 | 1,067,425 | 75/88 (85.2%) |
| Tura Balanced (low) | 56/88 (63.6%) | 38/56 (67.9%; 54.8–78.6%) | $20.020 | $0.527 | 9,718,165 | 255,741 | 46/56 (82.1%) |
| Stock Codex 0.146 | 88/88 (100.0%) | 54/88 (61.4%; 50.9–70.9%) | $50.365 | $0.933 | 49,151,323 | 910,210 | 75/88 (85.2%) |
| CodexZero v0.5 Safe | 88/88 (100.0%) | 52/88 (59.1%; 48.6–68.8%) | $56.025 | $1.077 | 58,934,046 | 1,133,347 | 75/88 (85.2%) |
| CodexZero v0.5 Standard | 88/88 (100.0%) | 53/88 (60.2%; 49.8–69.8%) | $44.356 | $0.837 | 40,433,152 | 762,890 | 76/88 (86.4%) |
| CodexZero v0.5 Focused | 88/88 (100.0%) | 54/88 (61.4%; 50.9–70.9%) | $41.773 | $0.774 | 36,235,443 | 671,027 | 76/88 (86.4%) |

## Reasoning-effort strata

These rows keep the 32-task medium prefix separate from the 56-task low extension.

| Profile / effort | Pass rate | Measured cost | Cost/pass | Total tokens | Tokens/pass | Usage coverage |
|---|---:|---:|---:|---:|---:|---:|
| Stock Codex 0.145 / low | 30/56 (53.6%) | $23.596 | $0.787 | 22,442,827 | 748,094 | 44/56 (78.6%) |
| Stock Codex 0.145 / medium | 20/32 (62.5%) | $22.389 | $1.119 | 21,161,391 | 1,058,070 | 31/32 (96.9%) |
| CodexZero Safe (legacy) / low | 30/56 (53.6%) | $25.677 | $0.856 | 25,011,079 | 833,703 | 44/56 (78.6%) |
| CodexZero Safe (legacy) / medium | 23/32 (71.9%) | $27.577 | $1.199 | 26,859,798 | 1,167,817 | 31/32 (96.9%) |
| CodexZero Max (legacy) / low | 28/56 (50.0%) | $21.078 | $0.753 | 17,572,807 | 627,600 | 44/56 (78.6%) |
| CodexZero Max (legacy) / medium | 19/32 (59.4%) | $21.260 | $1.119 | 18,293,911 | 962,837 | 31/32 (96.9%) |
| Ponytail / low | 28/56 (50.0%) | $25.362 | $0.906 | 24,189,609 | 863,915 | 45/56 (80.4%) |
| Ponytail / medium | 20/32 (62.5%) | $23.752 | $1.188 | 21,466,240 | 1,073,312 | 31/32 (96.9%) |
| LeanCTX / low | 32/56 (57.1%) | $34.404 | $1.075 | 36,943,596 | 1,154,487 | 43/56 (76.8%) |
| LeanCTX / medium | 23/32 (71.9%) | $34.094 | $1.482 | 37,809,833 | 1,643,906 | 31/32 (96.9%) |
| RTK / low | 30/56 (53.6%) | $25.746 | $0.858 | 24,510,138 | 817,005 | 43/56 (76.8%) |
| RTK / medium | 20/32 (62.5%) | $28.496 | $1.425 | 29,098,434 | 1,454,922 | 31/32 (96.9%) |
| Caveman / low | 28/56 (50.0%) | $28.137 | $1.005 | 26,924,371 | 961,585 | 44/56 (78.6%) |
| Caveman / medium | 20/32 (62.5%) | $24.860 | $1.243 | 24,312,010 | 1,215,600 | 31/32 (96.9%) |
| Tura Balanced (low) / low | 38/56 (67.9%) | $20.020 | $0.527 | 9,718,165 | 255,741 | 46/56 (82.1%) |
| Stock Codex 0.146 / low | 31/56 (55.4%) | $24.074 | $0.777 | 22,966,455 | 740,853 | 43/56 (76.8%) |
| Stock Codex 0.146 / medium | 23/32 (71.9%) | $26.291 | $1.143 | 26,184,868 | 1,138,473 | 32/32 (100.0%) |
| CodexZero v0.5 Safe / low | 32/56 (57.1%) | $29.267 | $0.915 | 31,926,442 | 997,701 | 43/56 (76.8%) |
| CodexZero v0.5 Safe / medium | 20/32 (62.5%) | $26.758 | $1.338 | 27,007,604 | 1,350,380 | 32/32 (100.0%) |
| CodexZero v0.5 Standard / low | 29/56 (51.8%) | $21.913 | $0.756 | 20,475,400 | 706,048 | 44/56 (78.6%) |
| CodexZero v0.5 Standard / medium | 24/32 (75.0%) | $22.443 | $0.935 | 19,957,752 | 831,573 | 32/32 (100.0%) |
| CodexZero v0.5 Focused / low | 31/56 (55.4%) | $20.306 | $0.655 | 17,746,126 | 572,456 | 44/56 (78.6%) |
| CodexZero v0.5 Focused / medium | 23/32 (71.9%) | $21.466 | $0.933 | 18,489,317 | 803,883 | 32/32 (100.0%) |

## Cache, failures, and latency

| Profile | Cached / input tokens | Uncached input | Output | Timeouts | Other failures | Agent median / p95 | Effort mix |
|---|---:|---:|---:|---:|---:|---:|---|
| Stock Codex 0.145 | 40,040,832 / 43,278,308 (92.5%) | 3,237,476 | 325,910 | 5 (5.7%; 1 later passed) | 34 | 121.8s / 765.9s | low: 56, medium: 32 |
| CodexZero Safe (legacy) | 47,815,168 / 51,508,150 (92.8%) | 3,692,982 | 362,727 | 5 (5.7%; 1 later passed) | 31 | 121.8s / 819.5s | low: 56, medium: 32 |
| CodexZero Max (legacy) | 32,273,920 / 35,537,207 (90.8%) | 3,263,287 | 329,511 | 5 (5.7%; 1 later passed) | 37 | 112.9s / 807.1s | low: 56, medium: 32 |
| Ponytail | 41,925,248 / 45,275,926 (92.6%) | 3,350,678 | 379,923 | 6 (6.8%; 1 later passed) | 35 | 119.9s / 868.7s | low: 56, medium: 32 |
| LeanCTX | 70,070,656 / 74,351,472 (94.2%) | 4,280,816 | 401,957 | 8 (9.1%; 1 later passed) | 26 | 134.2s / 894.2s | low: 56, medium: 32 |
| RTK | 49,698,816 / 53,214,819 (93.4%) | 3,516,003 | 393,753 | 5 (5.7%; 1 later passed) | 34 | 119.6s / 839.3s | low: 56, medium: 32 |
| Caveman | 47,172,480 / 50,872,732 (92.7%) | 3,700,252 | 363,649 | 6 (6.8%; 1 later passed) | 35 | 130.4s / 873.8s | low: 56, medium: 32 |
| Tura Balanced (low) | 7,882,240 / 9,442,197 (83.5%) | 1,559,957 | 275,968 | 8 (14.3%; 3 later passed) | 13 | 202.7s / 900.4s | low: 56 |
| Stock Codex 0.146 | 45,527,936 / 48,771,977 (93.3%) | 3,244,041 | 379,346 | 5 (5.7%; 1 later passed) | 30 | 130.4s / 816.7s | low: 56, medium: 32 |
| CodexZero v0.5 Safe | 55,197,312 / 58,544,355 (94.3%) | 3,347,043 | 389,691 | 4 (4.5%; 1 later passed) | 33 | 137.2s / 795.1s | low: 56, medium: 32 |
| CodexZero v0.5 Standard | 36,944,512 / 40,095,523 (92.1%) | 3,151,011 | 337,629 | 3 (3.4%; 0 later passed) | 32 | 112.0s / 601.8s | low: 56, medium: 32 |
| CodexZero v0.5 Focused | 32,861,568 / 35,896,540 (91.5%) | 3,034,972 | 338,903 | 4 (4.5%; 1 later passed) | 31 | 119.6s / 671.2s | low: 56, medium: 32 |

## Paired task outcomes

Candidate-only and baseline-only passes are direct task-level wins. The exact McNemar p-value tests only those discordant task outcomes.

| Candidate vs baseline | Paired tasks | Pass W–L | Both pass / fail | Pass-rate delta | Exact p | Cheaper task W–L | Fewer-token task W–L |
|---|---:|---:|---:|---:|---:|---:|---:|
| CodexZero Safe (legacy) vs Stock Codex 0.145 | 88 | 5–2 | 48 / 33 | 3.4 pp | 0.4531 | 32–42 (n=74) | 32–42 (n=74) |
| CodexZero Max (legacy) vs Stock Codex 0.145 | 88 | 1–4 | 46 / 37 | -3.4 pp | 0.3750 | 47–28 (n=75) | 55–20 (n=75) |
| Ponytail vs Stock Codex 0.145 | 88 | 3–5 | 45 / 35 | -2.3 pp | 0.7266 | 37–38 (n=75) | 29–46 (n=75) |
| LeanCTX vs Stock Codex 0.145 | 88 | 10–5 | 45 / 28 | 5.7 pp | 0.3018 | 17–57 (n=74) | 9–65 (n=74) |
| RTK vs Stock Codex 0.145 | 88 | 6–6 | 44 / 32 | 0.0 pp | 1.0000 | 34–40 (n=74) | 27–47 (n=74) |
| Caveman vs Stock Codex 0.145 | 88 | 3–5 | 45 / 35 | -2.3 pp | 0.7266 | 28–47 (n=75) | 21–54 (n=75) |
| CodexZero v0.5 Safe vs Stock Codex 0.146 | 88 | 5–7 | 47 / 29 | -2.3 pp | 0.7744 | 36–38 (n=74) | 31–43 (n=74) |
| CodexZero v0.5 Standard vs Stock Codex 0.146 | 88 | 4–5 | 49 / 30 | -1.1 pp | 1.0000 | 50–25 (n=75) | 56–19 (n=75) |
| CodexZero v0.5 Focused vs Stock Codex 0.146 | 88 | 5–5 | 49 / 29 | 0.0 pp | 1.0000 | 50–25 (n=75) | 56–19 (n=75) |
| Tura Balanced (low) vs Stock Codex 0.145 | 56 | 11–3 | 27 / 15 | 14.3 pp | 0.0574 | 14–23 (n=37) | 27–10 (n=37) |
| Tura Balanced (low) vs Stock Codex 0.146 | 56 | 10–3 | 28 / 15 | 12.5 pp | 0.0923 | 11–25 (n=36) | 25–11 (n=36) |
| CodexZero v0.5 Focused vs Tura Balanced (low) | 56 | 4–11 | 27 / 14 | -12.5 pp | 0.1185 | 28–9 (n=37) | 17–20 (n=37) |

## Remaining measurement limits

- Cost and token statistics are measured lower bounds when usage coverage is below 100%.
- Mixed-effort totals are split in the Effort mix column; compare profiles on the paired low-effort subset for a controlled efficiency claim.
- A single accepted attempt per task measures this run, not run-to-run variance. Repeated-task campaigns should be reported separately rather than merged into these totals.
- Wall-clock and agent-time figures include observed completed trial records only; they are not a throughput benchmark under controlled machine load.
