# Security

## Guarantees

- Raw output is stored before any compact form can be selected.
- Artifact identity uses SHA-256 and existing objects are verified before reuse.
- Only lossless, explicitly supported transforms are allowed.
- Exact token counts decide selection; equal or larger candidates fall back.
- Duplicate references require output identity, source-state identity, and an active original item.
- Side-effecting and remote commands are excluded from duplicate reuse.
- Feature flags default off in upstream-compatible source.
- Stock Codex and signed Desktop packages are not modified.

## Telemetry

Local telemetry contains numeric counters, event names, timestamps, booleans, and hashes. It does not need prompt text, tool-output content, commands, repository paths, environment variables, or credentials.

## Reporting a vulnerability

Open a private GitHub security advisory for the repository. Do not place credentials, private tool output, or raw local artifacts in a public issue.

## Scope

CodexZero does not weaken Codex sandbox or approval policy. It does not grant authority, modify external services, or change model routing.
