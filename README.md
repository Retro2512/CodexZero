<div align="center">
  <img src="assets/codexzero-mark.svg" width="76" alt="CodexZero">
  <h1>CodexZero</h1>
  <p><strong>Safe by default. Max Savings is opt-in and publishes its quality tradeoff.</strong></p>

  [![CI](https://github.com/Retro2512/CodexZero/actions/workflows/ci.yml/badge.svg)](https://github.com/Retro2512/CodexZero/actions/workflows/ci.yml)
  [![Release](https://img.shields.io/github/v/release/Retro2512/CodexZero?display_name=tag)](https://github.com/Retro2512/CodexZero/releases/latest)
  [![License: MIT](https://img.shields.io/badge/license-MIT-171713.svg)](LICENSE)
</div>

![CodexZero five-way DeepSWE results across 50 isolated GPT-5.6 Sol high trials](assets/social-card.svg)

## Public benchmark first

Ten published [DeepSWE](https://github.com/datacurve-ai/deep-swe) tasks ran through the [Pier](https://github.com/datacurve-ai/pier) runner and held-out functional verifiers. Every configuration used `gpt-5.6-sol` at high reasoning in an isolated container. All **50/50 trials** have complete grader, trajectory, provider-usage, timing, and evidence-hash records. The CodexZero row used what is now called **Max Savings**; it is not a score for Safe mode.

| Configuration | Resolved | Partial score | Provider tokens | Difference vs Codex | Cache tokens | Agent time |
|---|---:|---:|---:|---:|---:|---:|
| Codex | 8/10 | 0.9898 | 67,547,467 | Baseline | 97.61% | 180.1 min |
| **CodexZero Max Savings** | **6/10** | **0.9849** | **64,337,730** | **4.75% fewer** | **97.70%** | **170.5 min** |
| Codex + RTK | 7/10 | 0.9951 | 76,577,342 | 13.37% more | 97.41% | 192.2 min |
| Codex + Caveman | 7/10 | 0.9808 | 68,866,428 | 1.95% more | 97.42% | 181.0 min |
| Codex + Caveman + RTK | 8/10 | 0.9879 | 106,511,492 | 57.68% more | 97.83% | 253.6 min |

Against stock Codex, Max Savings used **3,209,737 fewer provider tokens**, **78.702 fewer Sol credits**, **$3.15 less in API-equivalent cost**, and **9.7 fewer minutes of agent time**. It did not match stock Codex’s strict resolved score: **6/10 vs 8/10**. Its partial-score retention was **99.51%**, feature-test retention **98.87%**, and regression-test retention **100.00%**.

This 10-task sample is not a leaderboard result or a full-corpus estimate. The exact paired quality test was **p = 0.6250**, and the bootstrap 95% interval for the resolved-rate difference was **−60 to +20 percentage points**. The run does not establish that Max Savings is lossless, nor that the observed strict-score gap generalizes. The harness also omitted the artifact-store environment required to activate compact exec payloads, so this run primarily measures the lean-prompt configuration and model variance—not Safe mode or the codec’s quality.

[Full DeepSWE report](reports/deepswe-sol-high-10/README.md) · [Aggregate statistics](reports/deepswe-sol-high-10/summary.json) · [Every trial metric and evidence hash](reports/deepswe-sol-high-10/task-metrics.csv) · [Environment and binary provenance](reports/deepswe-sol-high-10/provenance.json) · [Historical runner](tools/run-deepswe-five-way.py) · [Safe/Max Savings runner](tools/run-deepswe-five-way-v2.py)

### Controlled repeatable-workload check

Across **90 isolated `gpt-5.6-sol` medium trials** on six fixed workloads, every configuration passed all 18 quality gates:

| Configuration | Quality | Mean provider tokens | Difference vs Codex | Cache token hit | Mean time |
|---|---:|---:|---:|---:|---:|
| Codex | 18/18 | 46,263 | Baseline | 72.1% | 18.1s |
| **CodexZero Max Savings** | **18/18** | **39,915** | **13.72% fewer** | **76.8%** | 22.4s |
| Codex + RTK | 18/18 | 49,763 | 7.56% more | 76.3% | 19.8s |
| Codex + Caveman | 18/18 | 67,482 | 45.87% more | 77.5% | 25.8s |
| Codex + Caveman + RTK | 18/18 | 70,707 | 52.84% more | 79.6% | 29.9s |

CodexZero was lower-token in **16 of 18** paired trials. The exact two-sided sign-test result was **p = 0.001312**; the workload-stratified 95% confidence interval was **5,423 to 7,828 fewer tokens per trial**. Its mean wall time was 4.3 seconds longer than stock Codex.

[Full controlled report](reports/five-way-benchmark.md) · [All controlled-trial metrics](reports/five-way-benchmark.json) · [Historical Max Savings harness](tools/benchmark-five-way-max-savings-v1.py) · [Safe/Max Savings harness](tools/benchmark-five-way.py)

## Two modes

| Mode | Model instructions | Tool-result pipeline | Default |
|---|---|---|---|
| **Safe** | Stock Codex instructions | Guarded compact payloads with raw artifacts and stock fallback | **Yes** |
| **Max Savings** | Bundled 738-token prompt | Same guarded pipeline | No |

Safe targets quality parity by leaving Codex’s model instructions alone. Max Savings removes more input tokens, but its public DeepSWE sample showed a strict-score tradeoff. Existing `command-output` installs map to Safe; existing `full-lean` installs map to Max Savings.

## Install

### Windows

```powershell
irm https://raw.githubusercontent.com/Retro2512/CodexZero/main/scripts/bootstrap.ps1 | iex
```

### macOS

```sh
curl -fsSL https://raw.githubusercontent.com/Retro2512/CodexZero/main/scripts/bootstrap.sh | sh
```

Release packages include the runtime. Supported release targets: Windows x64, Intel Mac, and Apple silicon Mac.

The installer asks which mode you want:

- **Safe (default):** preserve Codex model instructions and compact eligible tool results.
- **Max Savings:** add the 738-token prompt for the largest input reduction.

Change the choice later with `codex-zero mode safe` or `codex-zero mode max-save`.

```text
codex-zero run                    optimized side-by-side CLI
codex-zero desktop                signed Desktop app + side-by-side core
codex-zero savings               measured savings over time
codex-zero mode [MODE]            show or select the optimization mode
codex-zero run-checks <profile>  one local validation batch
codex-zero stock                 untouched stock CLI
codex-zero doctor                installation checks
```

## Where the numbers come from

### Controlled end-to-end benchmark

The five-way result uses six fixed workloads, three repetitions, randomized interleaving, a fresh thread and disposable workspace for every trial, and isolated Codex homes and telemetry. It compares stock and patched cores from the same `0.145.0-alpha.30` release. Provider counters are authoritative; cache reads, uncached input, output, reasoning, requests, tool payloads, visible answers, wall time, and optimizer-native counters are all retained.

The evidence audit rehashed 90 raw execution streams and 192 provider-visible tool payloads before writing the report. The corpus is reproducible evidence for these workloads, not a universal savings percentage.

[Read the benchmark controls and workload results](reports/five-way-benchmark.md)

### Model instructions

The prompt percentages use exact `o200k_base` counts against dated prompt snapshots:

| Dated prompt reference | Before | Max Savings | Difference |
|---|---:|---:|---:|
| GPT-5.6-sol, July 24 | 3,552 | 738 | **2,814 fewer (79.2%)** |
| GPT-5.5 hotfix lineage, July 5 | 4,069 | 738 | **3,331 fewer (81.9%)** |

The weekly example is simple multiplication:

```text
50 requests/day × 7 days × 3,552 tokens = 1,243,200 before
50 requests/day × 7 days ×   738 tokens =   258,300 after
                                              984,900 fewer
```

These are static prompt comparisons, not production telemetry. CodexZero does not replace global or project `AGENTS.md` files.

[Read the prompt benchmark](reports/prompt-benchmark.md) · [Inspect its data](reports/prompt-benchmark.json)

### Tool results

| Fixture replay | Original | Selected | Difference |
|---|---:|---:|---:|
| Eleven fixed payloads | 6,699 tokens | 1,072 tokens | 5,627 fewer (84.0%) |
| Payloads that became smaller | 2 | 2 | Repeated lines and repeated stack frames |
| Payloads kept as stock | 9 | 9 | Candidate was equal or larger |

Almost all of the corpus reduction came from two intentionally repetitive fixtures. This is regression evidence for the gate and codecs, not a predicted session-saving rate. Use `codex-zero savings` to measure your own workload.

[Read the fixture report](reports/before-after.md) · [Inspect machine-readable results](reports/fixture-payload-report.json) · [Review the measurement method](docs/measurement.md)

## How it stays monotonic

```mermaid
flowchart LR
    A["Tool output"] --> B["Save exact raw bytes"]
    B --> C["Build reversible candidate"]
    C --> D{"Exact token count lower?"}
    D -- Yes --> E["Send candidate"]
    D -- No --> F["Send stock payload"]
    E --> G["Record measured difference"]
    F --> G
```

1. **Raw first.** Every transformed terminal result is stored by SHA-256 with its byte count.
2. **Reversible compact views.** Presentation-only ANSI styling may be stripped. OSC links retain visible text and URL. Only identical consecutive complete lines can use exact run-length encoding.
3. **Exact tokenizer gate.** Production uses `o200k_base`; a candidate must have fewer tokens than stock text.
4. **Proven duplicate state.** Read-only duplicates require matching output and file or repository fingerprints. The original item must remain active in context.
5. **Local measurement.** Telemetry stores counters and hashes, not prompt text or tool-output content.

After three successful launches with measured savings, an interactive terminal may show a one-time link to star the repository. CodexZero never stars it automatically.

## What does not change

- Model selection or reasoning effort
- Global and project instructions, output verbosity, compaction thresholds, or subagent policy
- Tools, MCP servers, apps, skills, plugins, permissions, or review capability
- Signed Codex Desktop packages or the installed stock CLI
- Errors, warnings, exit codes, non-identical lines, or raw diagnostics

Safe mode leaves model instructions unchanged. Max Savings mode changes only `model_instructions_file` for CodexZero launches.

For Desktop, quit the app completely and run `codex-zero desktop`. Codex Desktop’s supported `CODEX_CLI_PATH` override starts the signed app with the side-by-side core and runtime feature overrides. CodexZero does not alter or replace the signed package.

## Estimate and measure savings

The [site calculator](https://retro2512.github.io/CodexZero/#projection) lets you compare Safe and Max Savings. Safe counts tool-output savings only; Max Savings adds the dated prompt comparison.

```text
model requests per day
+ tool-output tokens per day
+ your measured tool-output reduction
```

It reports the counted input tokens before, after, saved, and how much farther the same counted budget would go. It covers model instructions and tool results, not every part of plan accounting.

```text
$ codex-zero savings
CodexZero savings
Model-visible tokens eliminated: <measured locally>
Payload tokens: <original> → <selected>
Payloads transformed: <count>
Model calls eliminated: <count>
```

Observed tokens, model calls, cache counters, and rejected candidates stay separate. In Max Savings mode, `codex-zero savings` also shows the dated prompt comparison.

## FAQ

### How is this different from RTK?

[RTK](https://github.com/rtk-ai/rtk) filters shell-command output with command-specific grouping, truncation, and deduplication. CodexZero works inside its Codex build, retains the original result, and rejects any compact view that is not smaller. RTK covers more commands; CodexZero uses a narrower reversible-by-default contract.

### How is this different from Headroom?

[Headroom](https://github.com/headroomlabs-ai/headroom) compresses a broader context surface through a library, proxy, or MCP server and can retrieve omitted content. CodexZero focuses on Codex tool results and exact local fallback. Headroom is broader; CodexZero has less routing and compression machinery.

### What about Caveman and Ponytail?

[Caveman](https://github.com/JuliusBrussee/caveman) asks the model to answer more briefly. [Ponytail](https://github.com/DietrichGebert/ponytail) steers implementation choices toward less code. Both can complement tool-output reduction. CodexZero works on tool-result representation instead of adding those behavior instructions.

### Does the 84.0% fixture result predict session savings?

No. It is the combined result of eleven fixed payloads, and almost all of the reduction came from two highly repetitive fixtures. Real savings depend on the output in each session.

### Do fewer input tokens mean lower cost or more requests?

They leave more room inside the input-token part of the workload. The dated prompt comparison gives **4.8× prompt capacity (+381%)** because 738 tokens fit into 3,552 about 4.8 times. Total price and plan usage do not change by that exact ratio because output, other input, caching, and service rules also count.

### What does Max Savings remove?

It removes redundant behavior scripting, taste rules, response formatting rules, tool rituals, fixed progress timing, repeated safety prose, and obsolete workarounds. It keeps user authority, scope and authorization boundaries, protection for existing work, injection boundaries, proportional verification, honest reporting, and concise intermediary updates.

## Build from source

The release core is pinned to upstream Codex tag `rust-v0.145.0-alpha.30`. The patch is reproducible:

```sh
git clone --branch rust-v0.145.0-alpha.30 https://github.com/openai/codex.git upstream
git -C upstream apply ../CodexZero/patches/codex-rust-v0.145.0-alpha.30.patch
cargo build --manifest-path upstream/codex-rs/Cargo.toml -p codex-cli --release
```

Source-checkout wrapper development requires Node.js 20+:

```sh
npm test
node bin/codex-zero.mjs doctor
```

## Documentation

- [Complete project reference](PROJECT_REFERENCE.md)
- [Architecture and responsibility boundaries](docs/architecture.md)
- [Measurement method](docs/measurement.md)
- [Compatibility](docs/compatibility.md)
- [Rollback and uninstall](docs/rollback.md)
- [Security model](SECURITY.md)
- [Acceptance audit](reports/acceptance-audit.md)
- [Isolated combination benchmark](reports/combination-benchmark.md)
- [Five-way end-to-end benchmark](reports/five-way-benchmark.md)
- [DeepSWE 10-task, five-way public-verifier benchmark](reports/deepswe-sol-high-10/README.md)
- [Release verification](reports/release-verification.json)
- [Contributing](CONTRIBUTING.md)

CodexZero is an independent project and is not an official OpenAI product.
