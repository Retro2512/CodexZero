# Client upgrade verification

## Scope

Updated the source client and rebased the core patch from Codex 0.151.0 to
0.153.4, commit `3d2ee51ca2d5db578f328aa75e20aa22c0197c9a`.
The release was checked against the [official upstream release](https://github.com/openai/codex/releases/tag/rust-v0.153.4).

The rebase retains the new upstream tool response envelope and fallback token
limit metadata while applying CodexZero duplicate result selection. It does
not change model access, account limits, permissions, or the selected reasoning
effort. No installed application or account configuration was changed.

## Astra prompt

The bundled prompt now uses 1,141 tokens, down from 1,356, a reduction of 215
tokens or 15.9%. The literal Astra instruction template available in the local
model catalog on September 7 contained 4,110 tokens. The bundled prompt is
2,969 tokens smaller than that dated snapshot, a 72.2% difference on this
instruction surface only. Global instructions, project instructions, tool
schemas, persistent model instructions, and conversation history are outside
that comparison. The manifest contains hashes and counts, not private prompt
text. Historical comparisons retain their original counts.

Prompt changes follow the [official Astra guidance](https://developers.openai.com/api/docs/guides/latest-model)
and [prompt caching guidance](https://developers.openai.com/api/docs/guides/prompt-caching):
resolve routine gaps, retain completed work when steered, preserve stable
history and tool definitions, batch useful independent reads, use bounded
delegation only when authorized, and stop verification once sufficient.

No context window or compaction limit is forced. The client uses Codex's
model catalog and explicit caller overrides. API model context limits are not
substituted for the limits available through a Codex account.

## Monitor benchmark

The local benchmark starts with 50,000 usage records and performs 20 single
record appends. Every incremental aggregate is compared with a full reread.

| Measurement | Full reread | Incremental reader |
| :--- | ---: | ---: |
| Bytes read | 220,544,100 | 10,506,760 |
| Elapsed time | 1,522 ms | 180 ms |
| Parsed records | 1,050,210 | 50,020 |

This run used Node 24.15.0 on Windows. Disk reads fell by 95.24%, including the
initial scan and continuity checks. Timings are one local run, not a cross
platform latency guarantee. The optimization reduces local work; it does not
count as model token savings.

Reproduce with `node tools/benchmark-client.mjs`.

## Check output

`run-checks --summary` returns statuses and artifact paths without inline output.
Complete stdout, stderr, combined output, exit codes, and signals remain
available. Normal mode retains its existing response shape. The entire batch
is validated before running its first command.

## Verification

* `npm test`: 37 passed, including concurrent artifact publication, corruption
  protection, partial JSON and UTF8 writes, rotation, truncation, monitor update
  serialization, continuous output, timer limits, check summaries, batch
  validation, caller environment preservation, and Windows metadata encoding.
* `cargo check --locked -p codex-cli`: passed with Rust 1.95.0.
* Focused `just test` run: 22 passed, 3,639 unrelated tests skipped. Coverage
  includes the codec, strict token selection, saved output, duplicate results,
  tool mode selection, fallback token limit metadata, schema generation, and
  waiting for silent process completion. Test execution took 16.7 seconds after
  the initial dependency build.
* `just bazel-lock-update`: passed.
* `just fmt`: passed.
* Scoped `just fix` for `codex-core` and `codex-zero-codec`, including tests:
  passed.
* Formatted patch application against a clean upstream index: passed.
* Exact prompt token count, byte count, and SHA256 verification: passed.
* Local monitor benchmark: every aggregate matched the full reread baseline.

No live Astra quality comparison, paid inference benchmark, release build,
Desktop launch, macOS run, or account limit measurement was performed.
