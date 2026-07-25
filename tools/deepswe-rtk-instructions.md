# RTK - Rust Token Killer (Codex CLI)

**Usage**: Token-optimized CLI proxy for shell commands.

## Rule

Use `rtk` for verbose external commands that resolve to executables on PATH,
especially git, package managers, build tools, linters, and test runners.
Do not prefix shell built-ins or simple file inspection commands unless they are
real executables on PATH.

Examples:

```bash
rtk git status
rtk cargo test
rtk npm run build
rtk pytest -q
```

## Meta Commands

```bash
rtk gain
rtk gain --history
rtk proxy <cmd>
```
