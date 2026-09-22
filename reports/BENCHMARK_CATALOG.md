# Benchmark catalog

This is the index for benchmark, usage, and efficiency evidence in this repository. It separates current comparisons, historical runs, static token measurements, local implementation benchmarks, and private raw evidence.

The machine readable inventory is [benchmark-catalog.json](benchmark-catalog.json).

## What is actually covered

### Model coverage

| Coverage | Model | Effort | Evidence |
|---|---|---|---|
| End to end agent benchmarks | `gpt-5.6-sol` | low, medium, high | Micro suites, Terminal Bench, DeepSWE, factorial runs, and competitor screens |
| Static prompt token comparison | `gpt-5.6-sol` | not applicable | Dated model instruction snapshots |
| Static prompt lineage only | GPT 5.5 lineage | not applicable | Historical tokenizer comparison |
| Static prompt snapshot only | `gpt-6-astra` | not applicable | Local catalog snapshot in the client upgrade report |

All committed end to end model quality and usage comparisons use `gpt-5.6-sol`. The repository does not contain a live quality benchmark for Astra, Terra, Luna, GPT 5.5, Claude, Gemini, or other models. Pricing references for those models are not benchmark results.

### Measured usage reduction systems

The repository contains local measurements for:

* CodexZero Safe, Standard, Focused, Max Savings, and historical lean adapter profiles
* RTK
* Caveman
* RTK plus Caveman
* Context Mode
* LeanCTX
* Headroom proxy only and default stack
* Ponytail
* Tamp Balanced L5 and Tamp Max L9
* Tura Direct and Tura Balanced
* sqz
* Squeez

The broader discovery list, including tools that were found but not fairly completed, is in [Complete CodexZero comparison](complete-comparison-2026-07-28.md#everything-else-found-but-not-fairly-completed).

## Current broadest comparison

The broadest task corpus is the 88 task Terminal Bench metrics audit. The first 32 tasks used medium reasoning and the 56 task extension used low reasoning. Usage is missing for terminal failure cells, so token and cost totals are measured lower bounds.

| Profile | Coverage | Passes | Total tokens | Measured cost | Cost per pass |
|---|---:|---:|---:|---:|---:|
| Stock Codex 0.145 | 88/88 | 50/88 | 43,604,218 | $45.985 | $0.920 |
| CodexZero Safe, legacy | 88/88 | 53/88 | 51,870,877 | $53.254 | $1.005 |
| CodexZero Max, legacy | 88/88 | 47/88 | 35,866,718 | $42.339 | $0.901 |
| Ponytail | 88/88 | 48/88 | 45,655,849 | $49.114 | $1.023 |
| LeanCTX | 88/88 | 55/88 | 74,753,429 | $68.498 | $1.245 |
| RTK | 88/88 | 50/88 | 53,608,572 | $54.242 | $1.085 |
| Caveman | 88/88 | 48/88 | 51,236,381 | $52.997 | $1.104 |
| Tura Balanced, low effort only | 56/88 | 38/56 | 9,718,165 | $20.020 | $0.527 |
| Stock Codex 0.146 | 88/88 | 54/88 | 49,151,323 | $50.365 | $0.933 |
| CodexZero v0.5 Safe | 88/88 | 52/88 | 58,934,046 | $56.025 | $1.077 |
| CodexZero v0.5 Standard | 88/88 | 53/88 | 40,433,152 | $44.356 | $0.837 |
| CodexZero v0.5 Focused | 88/88 | 54/88 | 36,235,443 | $41.773 | $0.774 |

Primary files:

* [Human readable audit](terminal-bench-metrics-audit-2026-08-13.md)
* [Full audit JSON](terminal-bench-metrics-audit-2026-08-13.json)
* [Source map](terminal-bench-metrics-sources-2026-08-13.json)
* [Compact totals](terminal-bench-total-comparison-2026-08-13.json)
* [Low effort extension](terminal-bench-fast-comparison-2026-08-13.md)

## Completed benchmark families

### Repeated Terminal Bench comparison

Twelve tasks were repeated three times for each setup. Codex and CodexZero both scored 29/36. CodexZero used 22,691,418 tokens versus 26,580,391 for Codex, a 14.63% reduction. RTK scored 32/36 and used 31,550,572 tokens.

Files:

* [Summary](terminal-bench-2.1-replication/README.md)
* [Machine summary](terminal-bench-2.1-replication/summary.json)
* [Trials](terminal-bench-2.1-replication/trials.json)
* [Attempts](terminal-bench-2.1-replication/attempts.json)
* [Preregistration](terminal-bench-2.1-replication/preregistration.json)
* [Infrastructure addendum](terminal-bench-2.1-replication/infrastructure-addendum.json)
* [Run manifest](terminal-bench-2.1-replication/run-manifest.json)

### Fresh micro comparison

The fast benchmark contains 327 completed fresh agent cells across six deterministic workloads, plus linked public benchmark results. In the 18 cell current mode comparison, every CodexZero mode passed all tasks and verifier checks.

| Setup | Strict tasks | Mean tokens | Token change | Mean cost | Cost change |
|---|---:|---:|---:|---:|---:|
| Stock Codex | 36/36 | 46,772 | baseline | $0.081 | baseline |
| CodexZero Safe v0.4 | 18/18 | 44,275 | 4.3% fewer | $0.062 | 19.0% lower |
| CodexZero Standard v0.4 | 18/18 | 38,777 | 17.1% fewer | $0.065 | 20.2% lower |
| CodexZero Focused v0.4 | 18/18 | 40,454 | 13.5% fewer | $0.069 | 15.6% lower |
| Codex plus RTK | 35/36 | 48,979 | 4.7% more | $0.095 | 16.5% higher |
| Codex plus Caveman | 36/36 | 65,063 | 39.1% more | $0.115 | 40.8% higher |
| Codex plus RTK plus Caveman | 36/36 | 68,536 | 46.5% more | $0.124 | 53.1% higher |
| Context Mode 1.0.169 | 15/18 | 87,220 | 86.5% more | $0.180 | 121.7% higher |
| LeanCTX 3.9.12 | 5/6 | 128,454 | 159.8% more | $0.195 | 145.6% higher |
| Headroom proxy only | 0/18 | 41,612 | 11.0% fewer | $0.078 | 3.6% lower |
| Headroom default stack | 0/18 | 77,293 | 65.3% more | $0.147 | 81.0% higher |
| CodexZero historical lean adapter | 18/18 | 39,767 | 15.9% fewer | $0.070 | 19.4% lower |

Files:

* [Fast benchmark report](fast-benchmark-2026-07-28.md)
* [Fast benchmark data](fast-benchmark-2026-07-28.json)
* [Complete comparison](complete-comparison-2026-07-28.md)
* [Complete comparison data](complete-comparison-2026-07-28.json)

### Independent Max Savings repeat

The separate 36 cell repeat passed 18/18 in each arm. Max Savings used 13.67% fewer tokens and 20.60% lower weighted cost than its stock control. It is included in the complete comparison files above.

### Quick Max routing comparison

One high effort multi file JavaScript task compared the previous Max profile, direct tool Max, and Focused. All passed. Direct tool Max used 14.1% fewer total tokens than previous Max and one fewer request.

Files: [report](quick-max-benchmark-2026-07-26.md) and [data](quick-max-benchmark-2026-07-26.json).

### Factorial interaction benchmark

The 36 cell factorial crossed three CodexZero modes, RTK on or off, and Caveman on or off. The historical best result was Max Savings plus RTK at 19.14% fewer tokens than paired stock. The fixed workload deliberately stressed repeated output.

Files: [report](archive/combination-benchmark.md) and [data](archive/combination-benchmark.json).

### Five way isolated benchmark

Ninety medium effort trials covered six workloads and five setups. All 18 cells per setup passed. CodexZero Max Savings used 13.72% fewer tokens than Codex. RTK used 7.56% more, Caveman 45.87% more, and RTK plus Caveman 52.84% more.

Files: [report](archive/five-way-benchmark.md) and [data](archive/five-way-benchmark.json).

### DeepSWE

There are three distinct DeepSWE evidence sets.

| Run | Scope | Main result | Status |
|---|---|---|---|
| Pilot | One task, medium | Both resolved; CodexZero used 31.3% fewer tokens | Historical pilot |
| Fresh stress test | Three repositories, high | Codex and CodexZero both resolved 2/3; CodexZero used 32.47% fewer tokens | Included in fast benchmark |
| Ten task five way | 50 trials, high | Codex 8/10; historical Max Savings 6/10 and 4.75% fewer tokens | Superseded harness |

Files:

* [Pilot report](archive/deepswe-pilot.md) and [pilot data](archive/deepswe-pilot.json)
* [Ten task report](archive/deepswe-sol-high-10/README.md)
* [Ten task summary](archive/deepswe-sol-high-10/summary.json)
* [Ten task metrics](archive/deepswe-sol-high-10/task-metrics.csv)
* [Ten task provenance](archive/deepswe-sol-high-10/provenance.json)
* [Paused predecessor](archive/deepswe-sol-high-paused/README.md)

### Competitor specific screens

| System | Scope | Result | Primary evidence |
|---|---|---|---|
| Ponytail 4.8.4 | 18 micro tasks | 18/18; 12.19% more provider tokens; modeled cost effectively tied | Complete comparison and private micro summary |
| Tamp 0.8.16 | 54 cells | Both L5 and L9 passed 18/18; 18.51% and 16.09% fewer tokens; 3.60% and 4.76% higher modeled cost | Complete comparison and private report |
| Tura 0.1.34 local probe | Five strict cells | 0/5 strict because required output and workspace contract were not preserved | Complete comparison and private evidence |
| Tura Balanced Terminal Bench extension | 56 low effort tasks | 38/56 with partial corpus coverage | Metrics audit |
| sqz 1.3.0 | Three task screen | 3/3; 34.0% more provider tokens | [Output tool comparison](additional-output-tools-comparison-2026-07-28.md) |
| Squeez 1.44.0 | Three task screen | 3/3; 40.0% more provider tokens | [Output tool comparison](additional-output-tools-comparison-2026-07-28.md) |

The six candidate trial details for sqz and Squeez are in [the screen report](additional-output-tools-screen-2026-07-28.md) and [JSON](additional-output-tools-screen-2026-07-28.json).

## Static and local efficiency measurements

### Fixture payload replay

The deterministic fixture corpus reduced 6,699 tool result tokens to 1,072, eliminating 5,627 tokens or 84.0%. The result is dominated by repeated lines and a repeated stack trace and is not a typical session estimate.

Files: [fixture report](archive/before-after.md) and [payload data](archive/fixture-payload-report.json).

### Prompt token measurements

These are tokenizer comparisons, not end to end provider usage.

| Reference | Baseline | Bundled prompt | Difference |
|---|---:|---:|---:|
| GPT 5.6 Sol, July 24 historical snapshot | 3,552 | 738 | 2,814 fewer, 79.2% |
| GPT 5.5 historical lineage | 4,069 | 738 | 3,331 fewer, 81.9% |
| GPT 6 Astra local catalog snapshot, September 7 | 4,110 | 1,141 | 2,969 fewer, 72.2% |

Files: [historical prompt report](archive/prompt-benchmark.md), [historical prompt data](archive/prompt-benchmark.json), [measurement method](../docs/measurement.md#prompt-benchmark), and [client upgrade report](client-upgrade-2026-09-07.md#astra-prompt).

### Savings monitor implementation benchmark

With 50,000 existing usage records and 20 appends, the incremental reader reduced bytes read from 220,544,100 to 10,506,760 and elapsed time from 1,522 ms to 180 ms in one local run. This is local application work, not model token savings.

File: [client upgrade report](client-upgrade-2026-09-07.md#monitor-benchmark).

## Historical and superseded evidence

The archive is deliberately retained. Its contents are not interchangeable with the current public headline.

* [Archive index](archive/README.md)
* [Terminal Bench mini panel](archive/terminal-bench-2.1-mini/README.md)
* [Paused DeepSWE run](archive/deepswe-sol-high-paused/README.md)
* [Acceptance audit](acceptance-audit.md)

## Raw evidence and private workspaces

`private-artifacts/` is ignored by Git. It contains raw streams, temporary homes, copied sources, checkpoints, manifests, and competitor specific evidence. The important benchmark roots are:

| Root | Purpose |
|---|---|
| `private-artifacts/baseline-20260723-013000` | Initial Codex run capture and fixtures |
| `private-artifacts/combination-benchmark-20260724T190721Z` | Early factorial attempt |
| `private-artifacts/combination-benchmark-20260724T192736Z` | Completed factorial evidence |
| `private-artifacts/five-way-benchmark-20260724T205536Z` | Five way raw benchmark |
| `private-artifacts/fast-benchmark-20260728T013916Z` | Consolidated fresh micro campaign and competitor runs |
| `private-artifacts/additional-tools-screen-20260728` | sqz and Squeez screen |
| `private-artifacts/leanctx-benchmark` | LeanCTX probes and source snapshot |
| `private-artifacts/ponytail-benchmark` | Ponytail inventory and micro run |
| `private-artifacts/tamp-benchmark` | Tamp package, probes, and 54 cell report |
| `private-artifacts/tura-investigation` | Tura local and published evidence review |
| `private-artifacts/terminal-bench-2.1-mini` | Private raw file manifest |
| `private-artifacts/terminal-bench-2.1-replication` | Private raw file manifest |
| `private-artifacts/squeez-benchmark` | Squeez isolated adapter work |
| `private-artifacts/rtk-isolation-smoke*` | RTK isolation checks |

Large copied source trees, package archives, temporary homes, and release bundles under `private-artifacts/` are supporting material rather than independent benchmark results.

## Harnesses and analyzers

The executable benchmark and analysis code is under `tools/`:

* `analyze-deepswe-five-way.py`
* `analyze-deepswe-pilot.py`
* `analyze-past-usage.py`
* `analyze-prompt-metadata.py`
* `analyze-terminal-bench-metrics.py`
* `analyze-terminal-bench-replication.py`
* `analyze-terminal-bench.py`
* `benchmark-client.mjs`
* `benchmark-combinations.py`
* `benchmark-five-way.py`
* `benchmark-five-way-max-savings-v1.py`
* `capture-codex-runs.mjs`
* `capture-deepswe-provenance.py`
* `capture-fixtures.mjs`
* `count-codex-run-tokens.py`
* `count-fixture-tokens.py`
* `evaluate-fixture-payloads.py`
* `generate-benchmark-charts.py`
* `harbor_tura_agent.py`
* `harbor_tura_fast_agent.py`
* `harbor_tura_profiles.py`
* `measure-prompt-savings.py`
* `merge-deepswe-checkpoints.py`
* `pause-deepswe-five-way.py`
* `prepare-tura-gap-campaign.py`
* `prepare-tura-gap-campaigns.py`
* `run-deepswe-five-way.py`
* `run-deepswe-five-way-v2.py`
* `run-terminal-bench-eight-way.py`
* `run-terminal-bench-profile.py`
* `supervise-terminal-bench-eight-way.sh`
* `test-deepswe-harness.py`
* `test_terminal_bench_eight_way.py`

The methodology and interpretation boundaries are in [Measurement](../docs/measurement.md).

## Presentation layer

`benchmark-site/` is a separate local site that hardcodes a normalized view of 23 measured setup rows. The root `README.md`, `index.html`, `PROJECT_REFERENCE.md`, and `assets/benchmarks/` also mirror selected results. They are presentation and reference layers, not additional evidence sources. The underlying sources remain the reports and private roots indexed above.
