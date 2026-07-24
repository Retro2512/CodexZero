# Measurement

CodexZero separates local observation, fixture replay, cache effects, and projection.

It also keeps command-output measurement separate from the optional prompt benchmark. The two surfaces must not be added into one percentage.

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

`tools/evaluate-fixture-payloads.py` replays fixed fixture output through equivalent deterministic rules. Results in `reports/fixture-payload-report.json` are test evidence, not production telemetry.

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
  738 bundled model-instruction tokens
2,814-token reference difference per model request (79.2%)
```

This is a static comparison, not runtime telemetry. A model update can change the baseline. Prompt caching and provider accounting can also change its practical effect.

The original July 22 refactor measured 5,099 → 946 combined tokens (81.4%). Restoring concise intermediary updates adds 58 model-prompt tokens, making the recalculated lineage 5,099 → 1,004 (80.3%). Neither combined figure is the installed mode: CodexZero preserves the user’s global and project instruction files.
