# Architecture

CodexZero keeps policy, enforcement, and evidence separate.

## Components

### Patched core

The Rust patch adds three default-off feature flags:

- `codex_zero_compact_exec_output`
- `codex_zero_lossless_terminal_codec`
- `codex_zero_exact_duplicate_results`

The UI-facing command result remains unchanged. A separate model-facing candidate is created, counted with the exact production tokenizer, and selected only when smaller.

### Artifact store

Raw command output is written before a compact payload can be selected. The store:

- addresses files by SHA-256;
- records original byte count and token count;
- verifies any existing object before reuse;
- fails closed if an object at the expected hash has different bytes.

### Duplicate-result cache

Reuse is limited to commands proven read-only:

- file reads include file blob hash and exact byte range;
- local Git status commands include HEAD, index, porcelain status, and hashes for changed paths;
- remote, side-effecting, or unproven commands are excluded;
- references are used only while the original result is still active in model context.

### Validation batch runner

`codex-zero run-checks <profile>` executes a repository-defined fixed command list locally. UI progress does not wake the model. One structured result includes every command, exit status, signal, and raw stdout/stderr artifact.

### Monitor

The monitor watches the telemetry directory for changes and atomically writes an aggregate state file. It does not poll Codex, invoke a model, or inspect conversation content.

## Responsibility boundaries

| Layer | Responsibility |
|---|---|
| Core prompt | Goals, scope, authorization, preservation, verification, honest reporting |
| Codex harness | Tool execution, context, feature flags, exact selection, telemetry |
| Artifact store | Byte-identical raw evidence |
| Wrapper | Side-by-side launch, environment defaults, monitor, stock fallback |
| Sandbox and approval system | Permission enforcement |
| Renderer | Full human-facing tool output |
| Project instructions | Repository-specific requirements |

CodexZero does not move permission enforcement into model judgment.
