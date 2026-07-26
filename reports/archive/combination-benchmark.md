# Combination benchmark

> **Superseded.** Retained as historical evidence. It is not used in the current public benchmark summary.

Mode names in this historical report map as follows: the raw `command-output` identifier is shown as `safe`; the raw `full-lean` identifier is shown as `max-save`. The machine-readable report retains the original identifiers.

Measured 2026-07-24T20:01:32.857089+00:00 with `gpt-5.6-sol` at `low` effort.

## Result

- **Best end-to-end result:** `max-save+rtk` saved **7,984.7 tokens per trial (19.14%)** against paired stock runs.
- CodexZero safe mode alone saved **2,603.0 tokens (6.24%)**. With RTK it saved **3,608.0 (8.65%)**.
- RTK alone changed the end-to-end total by **-283.7 tokens (-0.68%)**. Its paired range crossed zero (-1,346 to 927), so this run does not establish an end-to-end RTK-only saving.
- Caveman reduced visible assistant text by **206.3 tokens (24.07%)**, but its skill-loading turn made stock+Caveman use **18,639.7 more total tokens**. Adding Caveman to max-save cost **5,510.0 tokens** versus max-save alone; the Caveman combinations had wide ranges because skill loading added a request in some runs.
- The Max Savings prompt is an exact **3,552 → 738** comparison: **2,814 fewer tokens per inference (79.2%)**.

## End-to-end isolated trials

| Configuration | Pass | Mean total | Saved vs stock (range) | Reduction | Requests | Tool payload | Assistant | CodexZero measured |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| stock | 3/3 | 41,726.7 | 0.0 (0 to 0) | 0.00% | 2.0 | 8,699.0 | 857.0 | 0.0 |
| stock+caveman | 3/3 | 60,366.3 | -18,639.7 (-19,069 to -18,086) | -44.67% | 3.0 | 9,920.3 | 650.7 | 0.0 |
| stock+rtk | 3/3 | 42,010.3 | -283.7 (-1,346 to 927) | -0.68% | 2.0 | 8,593.7 | 824.7 | 0.0 |
| stock+rtk+caveman | 3/3 | 61,601.7 | -19,875.0 (-20,782 to -18,535) | -47.63% | 3.0 | 9,815.3 | 690.0 | 0.0 |
| safe | 3/3 | 39,123.7 | 2,603.0 (1,359 to 3,886) | 6.24% | 2.0 | 5,968.7 | 889.0 | 2,680.7 |
| safe+caveman | 3/3 | 58,309.7 | -16,583.0 (-17,098 to -16,307) | -39.74% | 3.0 | 7,000.0 | 642.7 | 2,918.7 |
| safe+rtk | 3/3 | 38,118.7 | 3,608.0 (2,424 to 4,486) | 8.65% | 2.0 | 4,747.0 | 746.7 | 3,841.0 |
| safe+rtk+caveman | 3/3 | 57,774.0 | -16,047.3 (-16,338 to -15,533) | -38.46% | 3.0 | 5,992.3 | 653.0 | 3,822.0 |
| max-save | 3/3 | 33,829.0 | 7,897.7 (7,480 to 8,418) | 18.93% | 2.0 | 5,788.0 | 872.0 | 2,912.0 |
| max-save+caveman | 3/3 | 39,339.0 | 2,387.7 (-8,579 to 8,289) | 5.72% | 2.3 | 6,195.0 | 671.3 | 2,912.3 |
| max-save+rtk | 3/3 | 33,742.0 | 7,984.7 (7,393 to 8,353) | 19.14% | 2.0 | 4,793.3 | 746.7 | 3,803.3 |
| max-save+rtk+caveman | 3/3 | 39,661.3 | 2,065.3 (-9,547 to 7,923) | 4.95% | 2.3 | 5,148.3 | 643.0 | 3,847.3 |

“Saved vs stock” is the mean paired difference within the same repetition. Negative values mean the configuration used more tokens.
The machine-readable report also includes mean input, cached input, output, wall time, and min–max ranges for every row.

## Deterministic tool-payload replay

| RTK | CodexZero | Model-visible tool tokens | Saved | Reduction |
|---|---|---:|---:|---:|
| off | off | 9,849 | 0 | 0.00% |
| off | on | 2,761 | 7,088 | 71.97% |
| on | off | 9,444 | 405 | 4.11% |
| on | on | 2,356 | 7,493 | 76.08% |

The stress payload deliberately includes 600 identical diagnostic lines. Its percentages measure this fixed corpus, not a typical session.

### Non-repetitive control

| RTK | CodexZero | Model-visible tool tokens | Saved | Reduction |
|---|---|---:|---:|---:|
| off | off | 2,616 | 0 | 0.00% |
| off | on | 2,616 | 0 | 0.00% |
| on | off | 2,211 | 405 | 15.48% |
| on | on | 2,211 | 405 | 15.48% |

The control contains the Git diff and test output but excludes the repeated diagnostic block. CodexZero correctly fell back to stock payloads when its candidate was not smaller.

## Method

- Full factorial: three CodexZero prompt/output modes × RTK on/off × Caveman on/off.
- Every trial uses the same pinned Codex core, model, effort, workspace, task, and three deterministic commands.
- Stock-equivalent runs use the pinned core with every CodexZero feature explicitly disabled. This avoids a version confound.
- Runs use fresh threads and isolated Codex homes. The only added project instruction is RTK when that factor is on.
- Provider counters are the end-to-end ground truth. Exact `o200k_base` counts separately measure tool and visible assistant text.
- The deterministic replay executes raw and RTK commands directly, then applies the production-equivalent strict CodexZero gate.
- Prompt caching, model sampling, and command-selection behavior can still vary; paired repetitions and pass checks limit that noise.
- Caveman is invoked through its installed skill path. Loading that skill can add an inference request; that overhead is intentionally included rather than subtracted.
