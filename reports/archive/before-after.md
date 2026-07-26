# Fixture before and after

> **Superseded.** Retained as historical fixture evidence. It is not used in the current public benchmark summary.

This report contains reproducible project fixtures only. Local production telemetry is not committed.

## Baseline task fixtures

| Fixture | Model requests | Input tokens | Tool-output tokens | Result |
|---|---:|---:|---:|---|
| Silent 60-second process | 2 | 31,659 | 17 | No intermediate request |
| Repeated lines | 2 | 33,932 | 2,276 | Baseline captured |
| ANSI output | 2 | 31,706 | 63 | Baseline captured |
| Read unchanged file twice | 3 | 48,037 | 200 | Baseline captured |
| Git status twice | 3 | 46,461 | 142 | Baseline captured |
| Three validation commands | 4 | 63,917 | 125 | Baseline captured |
| Large failing stack | 2 | 35,606 | 3,947 | Baseline captured |

## Deterministic fixture replay

| Fixture group | Original | Candidate | Eliminated |
|---|---:|---:|---:|
| All payloads | 6,699 | 1,072 | 5,627 (84.0%) |

Repeated output and the large stack trace became smaller. ANSI, reads, Git status, validation output, and silent output used stock fallback because the candidate did not pass the strict gate.

## What the replay does and does not show

- **Model calls:** the replay does not measure a change.
- **Cache effects:** not part of the replay.
- **Latency:** no improvement is claimed. The event-driven regression
  waits locally until output or exit instead of returning an empty result at
  the stock interval.
- **Exact duplicate references:** verified by integration test. Small read and Git-status fixtures stayed on stock
  output because their references were not smaller.
- **Silent-process baseline:** the original 60-second fixture already
  produced no intermediate request for that command shape.
The 84.0% corpus reduction is dominated by repeated lines and the large repeated stack. It is not a typical-session estimate. Future scenarios are not included here.

## Optional prompt comparison

Max Savings mode is benchmarked separately from the fixture replay:

| Dated model-instruction reference | Before | Max Savings | Difference |
|---|---:|---:|---:|
| GPT-5.6-sol, July 24 | 3,552 | 738 | 2,814 fewer (79.2%) |

The bundled prompt keeps concise intermediary updates. This row is an exact static tokenizer comparison, not observed provider usage, and is never added to the 84.0% tool-result figure. See [the full prompt report](prompt-benchmark.md).

At 50 model requests per day, the dated difference scales arithmetically to 140,700 tokens per day, 4,221,000 per 30 days, and 51,355,500 per year. These are projections, not production telemetry.
