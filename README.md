<div align="center">
  <img src="assets/codexzero-mark.svg" width="76" alt="CodexZero">
  <h1>CodexZero</h1>
  <p><strong>Safe by default. Max Savings is opt-in and publishes its quality tradeoff.</strong></p>

  [![CI](https://github.com/Retro2512/CodexZero/actions/workflows/ci.yml/badge.svg)](https://github.com/Retro2512/CodexZero/actions/workflows/ci.yml)
  [![Release](https://img.shields.io/github/v/release/Retro2512/CodexZero?display_name=tag)](https://github.com/Retro2512/CodexZero/releases/latest)
  [![License: MIT](https://img.shields.io/badge/license-MIT-171713.svg)](LICENSE)
</div>

![CodexZero Safe matched stock Codex on a six-way Terminal-Bench mini-panel](assets/social-card.svg)

## Public benchmark first

Twelve seeded [Terminal-Bench 2.1](https://www.tbench.ai/news/terminal-bench-2-1) tasks ran through the official [Harbor](https://www.harborframework.com/docs/run-jobs/run-evals) verifier in isolated containers. The six configurations used the same `gpt-5.6-sol` model at medium reasoning. The task list, binary hashes, metrics, invalid-run rules, and analysis plan were sealed and pushed before the first model call.

| Configuration | Strict score | Scorable score | Provider tokens | Difference vs Codex | API-equivalent cost | Agent time |
|---|---:|---:|---:|---:|---:|---:|
| Codex | 7/12 | 7/10 | 3,506,044 | Baseline | $4.4133 | 29.0 min |
| **CodexZero Safe** | **7/12** | **7/10** | **3,417,215** | **2.53% less** | **$4.0756 · 7.65% less** | **27.0 min** |
| CodexZero Max Savings | 7/12 | 7/10 | 4,243,972 | 21.05% more | $4.8911 · 10.83% more | 30.5 min |
| Codex + RTK | 7/12 | 7/10 | 3,225,158 | 8.01% less | $3.9873 · 9.65% less | 23.7 min |
| Codex + Caveman | 8/12 | 8/10 | 5,483,196 | 56.39% more | $5.8272 · 32.04% more | 33.0 min |
| Codex + Caveman + RTK | 7/12 | 7/10 | 3,978,272 | 13.47% more | $4.6057 · 4.36% more | 26.6 min |

**Safe matched stock Codex on every scorable task: 7/10 vs 7/10.** Its measured point estimates were **2.53% fewer provider tokens** and **7.65% lower API-equivalent cost**. The paired efficiency intervals include zero, so this mini-panel does not establish a universal savings rate.

Two tasks produced the same provider transport failure across all six configurations in the original wave, controlled rerun, and stock-Codex probes. They remain zeroes in the strict 12-task score and are the only tasks excluded from the 10-task comparison score. The run retained **84 attempts**, all **72/72 final matrix cells**, request-level token and cache counters, tool calls, shell commands, assistant turns, timings, cost estimates, telemetry, and evidence hashes.

CodexZero inspected **187** model-visible execution payloads and transformed **none** because no candidate was safely smaller. This establishes non-interference for those payloads, not compression-caused savings. Max Savings also matched Codex’s score here, but used more tokens and cost; it remains opt-in.

[Full Terminal-Bench report](reports/terminal-bench-2.1-mini/README.md) · [Aggregate statistics](reports/terminal-bench-2.1-mini/summary.json) · [Every final trial](reports/terminal-bench-2.1-mini/trials.json) · [Every attempt](reports/terminal-bench-2.1-mini/attempts.json) · [Sealed preregistration](reports/terminal-bench-2.1-mini/preregistration.json)

Historical context: an earlier 10-task [DeepSWE run](reports/deepswe-sol-high-10/README.md) tested what is now Max Savings at high reasoning. It used 4.75% fewer tokens but resolved 6/10 tasks versus stock Codex at 8/10. It did not test Safe mode.

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

Safe targets quality parity by leaving Codex’s model instructions alone. It matched stock Codex task-for-task in the current Terminal-Bench mini-panel. Max Savings reduces the static instruction block, but it used more total tokens in this run and showed a strict-score tradeoff in the earlier DeepSWE sample. Existing `command-output` installs map to Safe; existing `full-lean` installs map to Max Savings.

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

### Public Terminal-Bench mini-panel

The main comparison uses a sealed, deterministic 12-task sample from the corrected 89-task Terminal-Bench 2.1 package. Six configurations ran once per task through Harbor with isolated homes, mounted binaries, official verifiers, a 900-second agent cap, and no quality retries. Two synchronized provider failures were repeated under the preregistered invalid-run rule and reproduced in stock-only probes.

The report retains strict and scorable scores, per-task outcomes, input, cached input, uncached input, output, reasoning output, requests, cache-hit requests, assistant messages, tool calls, shell commands, agent time, API-equivalent cost, Codex credits, optimizer telemetry, confidence intervals, and artifact hashes.

[Read the Terminal-Bench report](reports/terminal-bench-2.1-mini/README.md) · [Inspect the sealed design](reports/terminal-bench-2.1-mini/preregistration.json) · [Inspect normalized trials](reports/terminal-bench-2.1-mini/trials.json)

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
