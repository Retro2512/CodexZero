# Measurement

CodexZero separates local observation, fixture replay, cache effects, and projection.

It also keeps Safe-mode tool-output measurement separate from the optional Max Savings prompt benchmark. The two surfaces must not be added into one percentage.

## Local observation

Production telemetry records one event per model-payload decision:

- original token count;
- selected token count;
- tokens eliminated;
- whether the candidate was selected;
- raw artifact SHA-256 and byte count;
- codec identifier.

No prompt, command output, repository path, or conversation text is required. Local totals belong to the person running CodexZero and are not committed as project-wide evidence.

## Fixture replay

`tools/evaluate-fixture-payloads.py` replays fixed fixture output through equivalent deterministic rules. Historical results in `reports/archive/fixture-payload-report.json` are test evidence, not production telemetry.

The fixture corpus includes:

- a silent 60-second process;
- repeated complete lines;
- ANSI-colored output;
- identical file reads;
- identical Git status;
- a three-command validation sequence;
- a large failing-test stack trace.

## Optional local history

`tools/analyze-past-usage.py` reads only:

- event timestamps;
- final cumulative token counters per session;
- event types;
- CodexZero counter telemetry.

It writes no prompts, tool output, file paths, or conversation text. Taking only each session’s final cumulative counter prevents double counting. Generated history reports are ignored by Git.

## Combination benchmark

`tools/benchmark-combinations.py` runs a full factorial comparison:

- stock-equivalent Codex, CodexZero Safe mode, and CodexZero Max Savings
  mode;
- RTK off and on;
- Caveman off and on.

Every configuration uses the same pinned Codex core, model, effort, workspace,
and deterministic task. Stock-equivalent runs explicitly disable every
CodexZero feature in the pinned core, avoiding a Codex-version confound. Each
trial runs in a fresh thread with an isolated temporary Codex home. Provider
usage counters, exact `o200k_base` tool-result counts, visible assistant-text
counts, CodexZero telemetry, command coverage, and wall time are recorded.

Run three randomized repetitions:

```sh
python tools/benchmark-combinations.py --repetitions 3
```

Interrupted or extended runs can resume from the public report:

```sh
python tools/benchmark-combinations.py \
  --resume reports/archive/combination-benchmark.json \
  --repetitions 3
```

The aggregate report is committed at
[`reports/archive/combination-benchmark.md`](../reports/archive/combination-benchmark.md).
Exact command output and per-run logs remain under ignored
`private-artifacts/`. The benchmark copies authentication only into temporary
homes and removes those homes when the run finishes.

The fixed stress workload includes 600 identical lines so the compact-output
path is exercised. A separate non-repetitive control verifies stock fallback.
Neither percentage is a typical-session forecast.

## Five-way end-to-end benchmark

`tools/benchmark-five-way.py` compares the five user-facing setups directly:

- Codex;
- CodexZero;
- Codex + RTK;
- Codex + Caveman;
- Codex + Caveman + RTK.

The committed run uses `gpt-5.6-sol` at medium reasoning across six workloads,
three repetitions, and 90 fresh threads. Configuration order is randomized
inside paired workload blocks. Each run gets a disposable Git workspace, a
temporary Codex home, per-trial CodexZero telemetry, and a per-trial RTK
database. It does not install, replace, or reconfigure the user's Codex binary.

The suite records provider input, cached input, cache writes, uncached input,
output, reasoning, and total tokens for every inference. It also records cache
hits by request, tool-result tokens, shell-output tokens, assistant and final
answer tokens, execution events, wall time, CodexZero artifact hashes, RTK
fallbacks, and task-specific quality gates.

Run or resume it with:

```sh
python tools/benchmark-five-way.py --repetitions 3
python tools/benchmark-five-way.py \
  --resume private-artifacts/five-way-benchmark-YYYYMMDDTHHMMSSZ/checkpoint.json \
  --repetitions 3
```

Read the [archived five-way report](../reports/archive/five-way-benchmark.md) for the
historical results and [`five-way-benchmark.json`](../reports/archive/five-way-benchmark.json) for
every trial, distribution, paired difference, and cache counter. Raw command
streams and exact tool payloads stay under ignored `private-artifacts/`.

Provider totals are the end-to-end result. CodexZero and RTK native counters are
diagnostics, not substitutes for provider accounting. RTK parse failures and
successful stock-command fallbacks are both reported. Before writing the
report, the harness rehashes every raw stream and tool payload, rechecks token
identities and quality gates, then calculates workload-stratified paired
bootstrap intervals and exact sign tests.

## DeepSWE five-way public-verifier benchmark

The public quality check uses the published
[DeepSWE](https://github.com/datacurve-ai/deep-swe) task set and official
[Pier](https://github.com/datacurve-ai/pier) runner. The staged 10-task sample
contains the completed pilot task plus nine tasks from the seed-2512 task order.
It is a cheaper directional sample, not a DeepSWE leaderboard submission or a
random estimate of all 113 tasks.

Each completed historical task ran five configurations:

- Codex;
- CodexZero Max Savings;
- Codex + RTK;
- Codex + Caveman;
- Codex + Caveman + RTK.

All configurations use `gpt-5.6-sol` at high reasoning, the same task checksum,
repository image, task prompt, and held-out verifier. Each trial gets a fresh
container and Codex home. The five added tasks ran concurrently, with all five
configurations also concurrent inside each task shard. This reduced the added
batch to 81 minutes of wall time; summed trial wall time was much larger and is
reported separately.

The historical CodexZero trial supplied the bundled lean model instructions,
which maps to Max Savings. It did not supply the artifact-store environment
required by the compact exec-payload path, so it is not a Safe-mode or
codec-isolation result. Future runs must record the selected mode and reject a
codec trial whose telemetry proves that no eligible transformation ran.

The run records strict resolved reward, partial reward, feature and regression
tests, input, cached input, uncached input, output and reasoning tokens, model
calls, cache-bearing calls, agent and trajectory steps, assistant turns, tool
calls, shell and patch calls, context summaries, peak context, setup, agent,
verifier and wall time, Sol credits, API-equivalent cost, RTK-native counters,
patch sizes, and SHA-256 hashes for private evidence files.

Run, merge, and analyze shards with:

```sh
python tools/run-deepswe-five-way-v2.py --codexzero-mode safe \
  [isolated paths and task arguments]
python tools/merge-deepswe-checkpoints.py \
  --checkpoint BASE --checkpoint SHARD [...] \
  --task TASK [...] --parallel-task-shards 5 \
  --output MERGED_CHECKPOINT
python tools/analyze-deepswe-five-way.py \
  --checkpoint MERGED_CHECKPOINT \
  --output-dir reports/deepswe-sol-high-10
```

The reproducibility patches in `tools/pier-*.patch` add support for a supplied
Codex binary and instruction file and allow the authentication endpoints needed
by the Codex CLI. They are applied to an isolated Pier checkout, not the user's
Codex installation. Authentication is copied to a temporary benchmark-only
path and removed when the controller exits.

One Arcane shard was initially misclassified because a generic `rate limit`
matcher found those words in application source. The original checkpoint is
retained. The classifier now requires provider-specific quota text and checks
valid result artifacts first; all five Arcane trials were revalidated against
complete trajectories, provider metrics, and held-out rewards.

The archived [10-task report](../reports/archive/deepswe-sol-high-10/README.md) includes
aggregate results and task-by-task scores.
[`task-metrics.csv`](../reports/archive/deepswe-sol-high-10/task-metrics.csv) contains
every recorded trial metric and evidence hash, while
[`provenance.json`](../reports/archive/deepswe-sol-high-10/provenance.json) records
repository commits, binary hashes, tool hashes, and runtime versions.

## Projections

The site calculator uses:

```text
tool results per day
× assumed eligible share
× assumed average tokens eliminated per eligible result
× horizon days
```

All three inputs are chosen by the reader. The result is a scenario, not observed savings or a forecast.

Codex plan rate limits have no published token conversion. Cached input can also have different service cost from uncached input. Reports therefore never convert projected input tokens into guaranteed messages, quota, dollars, or wall time.

## Prompt benchmark

`tools/measure-prompt-savings.py` counts the bundled prompt with `o200k_base`, verifies its byte count and SHA-256 against `prompts/manifest.json`, and can compare another local instruction file with `--baseline PATH`. `--model-cache PATH --model SLUG` reads a model’s `base_instructions` from a local Codex model cache without printing the prompt text.

The dated GPT-5.6-sol reference is:

```text
3,552 baseline model-instruction tokens
1,356 bundled model-instruction tokens
2,196-token reference difference per model request (61.8%)
```

This is a static comparison, not runtime telemetry. A model update can change the baseline. Prompt caching and provider accounting can also change its practical effect.

The original July 22 refactor measured 5,099 → 946 combined tokens (81.4%). Restoring concise intermediary updates produced 5,099 → 1,004 (80.3%). Adding batching, stopping, context-handoff, and product-authority guidance makes the current lineage 5,099 → 1,622 (68.2%). None of the combined figures replaces the user’s global or project instruction files.

## Scoped-runtime benchmark

Direct and scoped profiles must be measured separately. The required factorial is:

- Safe: direct tools, stock model instructions;
- Standard: direct tools, lean model instructions;
- Max Savings: legacy alias profile with direct tools and lean model instructions;
- Focused: scoped code runtime, lean model instructions.

For each cell, record initial tool-schema tokens, provider input/cached/output/reasoning tokens, model-visible calls, nested tool calls, wall time, weighted cost, verifier result, and changed paths. A projection trial is valid only when telemetry records `projection: "successful-check-v1"` and the raw artifact hash verifies.
