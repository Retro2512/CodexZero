# Quick Max benchmark — 2026-07-26

## Result

On one paired multi-file JavaScript task, the new direct-tool Max profile was correct and used fewer tokens, requests, time, and weighted cost than the previous Max profile.

| Profile | Correctness | Wall time | Input | Uncached input | Output | Total | Requests | Tool calls | Weighted proxy |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Previous CodexZero Max, 738-token prompt | pass | 64.2 s | 105,046 | 22,358 | 1,307 | 106,353 | 6 | 5 | 0.1923 |
| New CodexZero Max, 874-token prompt | pass | 58.4 s | 90,064 | 21,456 | 1,260 | 91,324 | 5 | 4 | 0.1794 |
| New Focused, scoped runtime | pass | 84.4 s | 127,601 | 22,641 | 1,600 | 129,201 | 7 | 6 | 0.2137 |

New Max versus previous Max:

- 14.1% fewer total tokens;
- 4.0% fewer uncached input tokens;
- 3.6% fewer output tokens;
- one fewer inference request and one fewer model-visible tool call;
- 9.0% less wall time;
- 6.7% lower weighted cost proxy.

The scoped Focused run was worse on this small task. It also recovered from one Windows process-start failure, which added a request. This result is why Standard now uses the direct Max path and Focused is opt-in for tool-heavy work.

## Task and controls

The model implemented tag normalization, record filtering, and index exports across three source files. It had to validate inputs, preserve record order and object identity, avoid mutation, change only `src`, and run the visible test suite.

All compared CodexZero runs used:

- GPT-5.6 SOL at high reasoning;
- the same task wording, fixture, permissions, and installed core binary;
- five visible tests plus an independent hidden verifier;
- source-scope verification for `package.json`, tests, and file inventory.

Every CodexZero cell passed all five visible tests, the hidden edge cases, identity and mutation checks, and source-scope checks.

The weighted proxy is:

```text
(5 × uncached input + 0.5 × cached input + 30 × output) / 1,000,000
```

## Limits

This is one run per cell, so the differences are directional rather than statistically stable.

The task's successful test output was below the new 80-line projection gate. It therefore measures the new prompt and mode routing, not command-aware projection. The new projection and scoped-mode precedence are covered by targeted Rust tests. A full patched CLI build was not available on this Windows host because unrelated native dependencies failed during compilation.

Raw JSONL SHA-256:

- previous Max: `65fce2e80f1aafa8530487c13abb0165e75272472ca9af50d8f8a3c1fd0f2f8b`
- new Max: `1c168f8506b2f7e160115d7c4fc3eac944335df0845384cddc38027acb674c56`
- Focused: `59496a2023f4470cfc4ff828a167dee7a1203efe32c1932fb4554aa69d7bf0b4`
