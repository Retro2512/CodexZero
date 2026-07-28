# Architecture

CodexZero keeps policy, enforcement, and evidence separate.

## Components

### Patched core

The Rust patch adds five default-off feature flags:

- `codex_zero_compact_exec_output`
- `codex_zero_lossless_terminal_codec`
- `codex_zero_command_aware_projection`
- `codex_zero_exact_duplicate_results`
- `codex_zero_event_driven_wait`

The UI-facing command result remains unchanged. A separate model-facing candidate is created, counted with the exact production tokenizer, and selected only when smaller.

### Scoped batching runtime

Focused enables Codex's own code-mode-only runtime. The model initially sees the `exec` and `wait` entrypoints plus tools that Codex must keep direct. Full nested schemas stay inside the local runtime, and deferred tools are loaded through Codex tool search only when needed.

One `exec` cell can compose several existing Codex tool handlers. Independent reads can run concurrently; dependent edits remain ordered by the JavaScript program. Every nested call still passes through the normal Codex router, approval policy, sandbox, hooks, cancellation, and UI events. CodexZero does not add a second shell or permission system.

### Event-driven process waiting

An empty `write_stdin` call remains inside the harness until the process emits
output, exits, is cancelled, enters a permission pause, receives user
interruption, or reaches the configured hard timeout. Requested polling
intervals no longer create empty model-visible results. The UI keeps its local
running state, and non-empty stdin keeps stock timing behavior.

### Artifact store

Raw command output is written before a compact payload can be selected. The store:

- addresses files by SHA-256;
- records original byte count and token count;
- verifies any existing object before reuse;
- fails closed if an object at the expected hash has different bytes.

### Command-aware projections

Successful test, build, check, and lint commands with at least 80 output lines can produce a deterministic diagnostic projection. It keeps the opening context, warning/error/pass summaries with adjacent locations, and the final output tail. Failed commands and unknown command families are never projected.

The raw artifact is stored first. The projection competes with the plain and reversible line-RLE candidates under the exact tokenizer, so it is selected only when it is the smallest representation. Telemetry records the projection identifier and raw artifact hash.

### Duplicate-result cache

Reuse is limited to commands proven read-only:

- file reads include file blob hash and exact byte range;
- local Git status commands include HEAD, index, porcelain status, and hashes for changed paths;
- repository searches support proven read-only `rg`, `git grep`, and `git ls-files`
  invocations and bind the result to the repository state;
- search modes that can cross repository boundaries, follow links, include hidden
  or ignored sources, or invoke preprocessors are excluded;
- remote, side-effecting, or unproven commands are excluded;
- references are used only while the original result is still active in model context.

Command-result metadata that can legitimately change between calls—chunk ID,
wall time, process state, exit status, artifact hash, and byte count—remains
attached to the current call. Only byte-identical model-visible output content
is referenced.

### Validation batch runner

`codex-zero run-checks <profile>` executes a repository-defined fixed command list locally. UI progress does not wake the model. One structured result includes every command, exit status, signal, and raw stdout/stderr artifact.

### Monitor

The monitor watches the telemetry directory for changes and atomically writes an aggregate state file. It does not poll Codex, invoke a model, or inspect conversation content.

### Desktop launcher

`codex-zero desktop` starts the installed signed app with its supported `CODEX_CLI_PATH` override pointing at the side-by-side core. `CODEX_APP_SERVER_FORCE_CLI=1` prevents an existing daemon from bypassing that path. A custom runtime environment switch injects the same default-off feature overrides used by the CLI launcher. Focused passes `CODEX_ZERO_SCOPED_RUNTIME=1`; Standard, Max Savings, and Focused pass the installed prompt path through `CODEX_ZERO_INSTRUCTIONS_FILE`. The command refuses to launch while an existing Desktop process is active because a single-instance handoff would keep the old process environment.

### Optimization modes

The installer records `safe`, `standard`, `max-save`, or `focused` in `~/.codex/codexzero/install.json`. New installs default to `standard`.

- `safe` preserves Codex model instructions and the direct tool surface while activating the patched result pipeline.
- `standard` keeps the direct tool surface and adds a per-launch `model_instructions_file` override.
- `max-save` preserves Standard's direct-tool, lean-prompt behavior as a legacy mode name.
- `focused` adds the scoped batching runtime to the lean prompt's stopping and checkpoint guidance.

The bundled prompt is copied under the CodexZero installation. User, global, and project instruction files are neither edited nor replaced. Existing `command-output` metadata normalizes to `safe`; existing `full-lean` metadata normalizes to `max-save`. `codex-zero mode` changes the recorded choice for new CodexZero tasks.

## Responsibility boundaries

| Layer | Responsibility |
|---|---|
| Optional lean prompt | Goals, scope, authorization, preservation, verification budget, context handoff, concise progress updates, honest reporting |
| Scoped code runtime | Small initial schema set, lazy nested tools, safe composition of existing handlers |
| Codex harness | Tool execution, context, feature flags, exact selection, telemetry |
| Artifact store | Byte-identical raw evidence |
| Wrapper | Side-by-side launch, environment defaults, monitor, stock fallback |
| Sandbox and approval system | Permission enforcement |
| Renderer | Full human-facing tool output |
| Project instructions | Repository-specific requirements |

CodexZero does not move permission enforcement into model judgment.
