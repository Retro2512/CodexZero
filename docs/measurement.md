# Measurement

CodexZero publishes deterministic fixture replay, not private usage telemetry.

## Fixture replay

`tools/evaluate-fixture-payloads.py` replays checked-in fixture output through the same deterministic rules used by the optimizer. Results in `reports/fixture-payload-report.json` are test evidence, not production savings.

The fixture corpus includes:

- a silent 60-second process;
- repeated complete lines;
- ANSI-colored output;
- identical file reads;
- identical Git status;
- a three-command validation sequence;
- a large failing-test stack trace.

The strict gate selects a candidate only when exact `o200k_base` counting proves it is smaller. Equal or larger candidates fall back to stock output. Raw fixture bytes remain addressable by SHA-256.

## Local counters

`codex-zero savings` reads counters stored on the current machine. Those counters are not part of the repository and are not uploaded by CodexZero.
