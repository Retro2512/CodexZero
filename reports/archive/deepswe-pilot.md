# DeepSWE public-verifier pilot

> **Superseded.** Retained as a one-task pilot. It is not used in the current public benchmark summary.

Both configurations solved the same published DeepSWE task with the official
Pier runner and the task's held-out functional verifier.

| Configuration | Resolved | Feature tests | Regression tests | Provider tokens | Peak context | Agent time |
|---|---:|---:|---:|---:|---:|---:|
| Codex | 1/1 | 25/25 | 1,679/1,679 | 6,171,914 | 118,313 | 11.1 min |
| CodexZero | 1/1 | 25/25 | 1,679/1,679 | 4,239,491 | 77,703 | 10.7 min |

CodexZero kept the same score while using **31.3% fewer
provider-counted tokens**, **34.3% less peak context**,
and **3.3% less agent time** on this task.

## Token and execution detail

| Configuration | Input | Cached input | Cache token ratio | Uncached input | Output | Reasoning output | Steps |
|---|---:|---:|---:|---:|---:|---:|---:|
| Codex | 6,150,409 | 5,989,888 | 97.4% | 160,521 | 21,505 | 7,043 | 75 |
| CodexZero | 4,219,819 | 4,095,744 | 97.1% | 124,075 | 19,672 | 6,821 | 70 |

CodexZero used **22.7% less uncached input**
and **8.5% fewer output tokens**. Cache token
ratios were measured, not assumed.

## Scope

- Benchmark: [DeepSWE](https://github.com/datacurve-ai/deep-swe), commit
  `e016041a6ccf8da29906afc9a3f5a8df940a1f78`.
- Runner and verifier: [Pier](https://github.com/datacurve-ai/pier), commit
  `fefa7475a32bb05271abdea378e8083c83eb5c35`, with the documented Codex CLI agent.
- Task: `datacurve/arktype-json-schema-refs-dependencies`, checksum `c76f0c8ec2f874858c6db78320769f2da362bbeee864d7dd33794af9bc00c635`.
- Model: `gpt-5.6-sol`, medium reasoning. Codex cores:
  `0.145.0-alpha.30`.
- The stock trial had no custom binary or CodexZero flags. The CodexZero trial
  used the patched binary, lean model instructions, and all four guarded
  output/runtime optimizations. Sanitized configuration hashes are in JSON.
- This is a paired **one-task validation pilot**, not a DeepSWE leaderboard
  score or an estimate of performance across all 113 tasks.
- A five-task expansion was started, but the account usage limit interrupted
  three stock trials before CodexZero could be run. Those incomplete attempts
  are excluded rather than counted as quality failures.

Raw trajectories, verifier output, and patches remain private because they may
contain repository content. Their hashes and all sanitized counters are in
[`deepswe-pilot.json`](deepswe-pilot.json).
