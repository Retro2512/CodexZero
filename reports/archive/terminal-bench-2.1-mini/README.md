# Terminal-Bench 2.1 mini-panel

> **Superseded.** Replaced by the repeated Terminal-Bench comparison. It is not used in the current public benchmark summary.

**CodexZero Safe matched Codex on every scorable task: 7/10 vs 7/10.** It used 2.53% fewer provider tokens and 7.65% less API-equivalent cost in this run. The paired 95% intervals for efficiency include zero, so these are measured point estimates, not a proven population-wide savings rate.

The strict preregistered score was **7/12 (58.3%)** for Codex, CodexZero Safe, CodexZero Max Savings, Codex + RTK, and Codex + Caveman + RTK. Codex + Caveman scored **8/12 (66.7%)**. Two tasks produced the same provider transport failure across all six configurations in both the original run and controlled rerun; the comparison score excludes only those two cells per configuration.

## Main comparison

| Configuration | Strict score | Scorable score | Total tokens | vs Codex | API-equivalent cost | vs Codex | Codex credits | Agent time |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Codex | 7/12 (58.3%) | 7/10 (70.0%) | 3,506,044 | baseline | $4.4133 | baseline | 110.333 | 29.0 min |
| CodexZero Safe | 7/12 (58.3%) | 7/10 (70.0%) | 3,417,215 | 2.53% less | $4.0756 | 7.65% less | 101.891 | 27.0 min |
| CodexZero Max Savings | 7/12 (58.3%) | 7/10 (70.0%) | 4,243,972 | 21.05% more | $4.8911 | 10.83% more | 122.277 | 30.5 min |
| Codex + RTK | 7/12 (58.3%) | 7/10 (70.0%) | 3,225,158 | 8.01% less | $3.9873 | 9.65% less | 99.681 | 23.7 min |
| Codex + Caveman | 8/12 (66.7%) | 8/10 (80.0%) | 5,483,196 | 56.39% more | $5.8272 | 32.04% more | 145.680 | 33.0 min |
| Codex + Caveman + RTK | 7/12 (58.3%) | 7/10 (70.0%) | 3,978,272 | 13.47% more | $4.6057 | 4.36% more | 115.143 | 26.6 min |

Totals and savings above use the 10 scorable paired tasks. Provider-failed attempts and their partial usage remain in [`attempts.json`](attempts.json).

## Quality

| Configuration | Score delta vs Codex | Paired bootstrap 95% | Baseline-only passes | Candidate-only passes | Exact McNemar p |
|---|---:|---:|---:|---:|---:|
| CodexZero Safe | +0.0% | +0.0% to +0.0% | 0 | 0 | n/a |
| CodexZero Max Savings | +0.0% | +0.0% to +0.0% | 0 | 0 | n/a |
| Codex + RTK | +0.0% | +0.0% to +0.0% | 0 | 0 | n/a |
| Codex + Caveman | +10.0% | +0.0% to +30.0% | 0 | 1 | 1.000 |
| Codex + Caveman + RTK | +0.0% | +0.0% to +0.0% | 0 | 0 | n/a |

### Per-task score

| Task | Codex | CodexZero Safe | CodexZero Max Savings | Codex + RTK | Codex + Caveman | Codex + Caveman + RTK |
|---|---:|---:|---:|---:|---:|---:|
| `openssl-selfsigned-cert` | 1 | 1 | 1 | 1 | 1 | 1 |
| `nginx-request-logging` | 1 | 1 | 1 | 1 | 1 | 1 |
| `hf-model-inference` | 0 | 0 | 0 | 0 | 0 | 0 |
| `financial-document-processor` | ERR‡ | ERR‡ | ERR‡ | ERR‡ | ERR‡ | ERR‡ |
| `large-scale-text-editing` | 1 | 1 | 1 | 1 | 1 | 1 |
| `mailman` | 1 | 1 | 1 | 1 | 1 | 1 |
| `video-processing` | 0 | 0 | 0 | 0 | 1 | 0 |
| `custom-memory-heap-crash` | 1 | 1 | 1 | 1 | 1 | 1 |
| `vulnerable-secret` | 0† | 0† | 0† | 0† | 0† | 0† |
| `count-dataset-tokens` | 1 | 1 | 1 | 1 | 1 | 1 |
| `fix-code-vulnerability` | 1 | 1 | 1 | 1 | 1 | 1 |
| `adaptive-rejection-sampler` | ERR‡ | ERR‡ | ERR‡ | ERR‡ | ERR‡ | ERR‡ |

- † Shared model safety refusal; retained as a scored zero.
- ‡ Shared provider transport failure; excluded from the comparison score after the original six-way wave, a six-way controlled rerun, and single-container Codex probes reproduced it. The strict score retains it as zero.

## Tokens, cache, calls, and turns

| Configuration | Input | Cached | Uncached | Output | Reasoning output | Cache token ratio | Requests | Cache-hit requests | Assistant messages | Tool calls | Shell commands |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Codex | 3,469,696 | 3,116,800 | 352,896 | 36,348 | 11,929 | 89.8% | 137 | 133 | 49 | 128 | 84 |
| CodexZero Safe | 3,385,226 | 3,068,928 | 316,298 | 31,989 | 9,449 | 90.7% | 132 | 128 | 39 | 123 | 79 |
| CodexZero Max Savings | 4,203,712 | 3,852,288 | 351,424 | 40,260 | 13,229 | 91.6% | 142 | 140 | 30 | 133 | 87 |
| Codex + RTK | 3,190,871 | 2,887,936 | 302,935 | 34,287 | 12,253 | 90.5% | 123 | 119 | 42 | 114 | 77 |
| Codex + Caveman | 5,437,312 | 5,052,416 | 384,896 | 45,884 | 19,144 | 92.9% | 175 | 172 | 56 | 166 | 107 |
| Codex + Caveman + RTK | 3,941,122 | 3,603,200 | 337,922 | 37,150 | 16,329 | 91.4% | 145 | 141 | 47 | 136 | 96 |

## Tool telemetry

| Configuration | Tool-output tokens observed | CodexZero payloads | Transformed | Tokens eliminated | RTK commands | RTK measured tokens saved | RTK fallbacks |
|---|---:|---:|---:|---:|---:|---:|---:|
| Codex | 2,661,131 | 0 | 0 | 0 | 0 | 0 | 0 |
| CodexZero Safe | 1,493,132 | 86 | 0 | 0 | 0 | 0 | 0 |
| CodexZero Max Savings | 2,659,328 | 101 | 0 | 0 | 0 | 0 | 0 |
| Codex + RTK | 2,396,748 | 0 | 0 | 0 | 31 | 6,111 | 25 |
| Codex + Caveman | 1,937,284 | 0 | 0 | 0 | 0 | 0 | 0 |
| Codex + Caveman + RTK | 2,427,973 | 0 | 0 | 0 | 48 | 6,093 | 43 |

CodexZero inspected 187 model-visible execution payloads across Safe and Max Savings but transformed none: every candidate representation was rejected because it was not safely smaller. The benchmark therefore demonstrates Safe's non-interference on these tasks, but it does **not** attribute the observed provider-token difference to payload compression.

## Efficiency uncertainty

| Configuration | Mean tokens saved/task | Paired bootstrap 95% | Mean API cost saved/task | Paired bootstrap 95% |
|---|---:|---:|---:|---:|
| CodexZero Safe | +8,883 | -64,222 to +87,162 | $+0.0338 | $-0.0442 to $+0.1303 |
| CodexZero Max Savings | -73,793 | -282,176 to +73,591 | $-0.0478 | $-0.2233 to $+0.0880 |
| Codex + RTK | +28,089 | -12,636 to +67,806 | $+0.0426 | $-0.0272 to $+0.1153 |
| Codex + Caveman | -197,715 | -538,218 to +40,078 | $-0.1414 | $-0.4558 to $+0.0812 |
| Codex + Caveman + RTK | -47,223 | -193,556 to +47,177 | $-0.0192 | $-0.1525 to $+0.0866 |

## Design and integrity

- Model: `gpt-5.6-sol`, reasoning effort `medium`.
- Dataset: corrected 89-task Terminal-Bench package `sha256:c6fc2e2382c1dbae99b2d5ecd2f4f4a60c3c01e0d84642d69b4afd92e99d078b`.
- Selection: `random.Random(2512).sample(registry_order, 12)`, sealed before the first model call.
- Matrix: six configurations × 12 tasks × one attempt; up to 12 trials in parallel; 900-second agent cap.
- Attempts: 84 recorded; 12 infrastructure-invalid attempts superseded; 72/72 final cells present.
- Provider/session token identities: 54/54 valid.
- CodexZero artifact hashes and token accounting: valid.
- Retries: no model-quality retries. Only the two synchronized transport-failure waves were repeated under the preregistered invalid-run rule.

The score is a lower-cost paired mini-panel, not a full Terminal-Bench leaderboard submission. One attempt per cell is enough to compare these exact paired outcomes, but not enough to estimate a stable population-wide token-savings rate.

## Cost calculation

Costs are computed per request from OpenAI's published GPT-5.6 Sol rates: $5/M uncached input, $0.50/M cached input, and $30/M output. Codex credits use 125/M, 12.5/M, and 750/M respectively. Requests above 272K input tokens apply the published 2× input and 1.5× output multipliers. [Model pricing](https://developers.openai.com/api/docs/models/gpt-5.6-sol) · [Codex rate card](https://help.openai.com/en/articles/20001106-codex-rate-card)

API-equivalent dollars are a comparison metric, not a claim that this ChatGPT-plan run produced an API invoice.

## Files

- [`preregistration.json`](preregistration.json): sealed design, task digests, binary hashes, prompts, and metrics.
- [`summary.json`](summary.json): aggregate metrics, paired comparisons, confidence intervals, and integrity checks.
- [`trials.json`](trials.json): one normalized record for each final matrix cell.
- [`attempts.json`](attempts.json): every original and infrastructure-rerun attempt.
- [`run-manifest.json`](run-manifest.json): wall times, diagnostic probes, raw-job tree hashes, and public artifact hashes.
- [`PREREGISTRATION.sha256`](PREREGISTRATION.sha256): preregistration seal.

Generated by [`tools/analyze-terminal-bench.py`](../../../tools/analyze-terminal-bench.py).
