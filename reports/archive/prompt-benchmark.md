# Lean prompt benchmark

> **Superseded.** Retained as a dated historical comparison. It is not used in the current public benchmark summary.

CodexZero’s optional Max Savings mode replaces the model-instructions file for CodexZero launches. Safe mode leaves model instructions unchanged.

Exact `o200k_base` counts:

| Reference | Before | Full lean | Difference |
|---|---:|---:|---:|
| GPT-5.6-sol model-instruction snapshot, July 24 | 3,552 | 738 | 2,814 fewer (79.2%) |
| GPT-5.5 hotfix lineage, July 5 | 4,069 | 738 | 3,331 fewer (81.9%) |
| Historical model + global stack, July 22 | 5,099 | 1,004 | 4,095 fewer (80.3%) |

The combined row documents the refactor’s lineage. The installer does **not** replace a user’s global `AGENTS.md`, so it must not be treated as the active installed saving.

The original July 22 refactor measured 4,069 → 680 model tokens, 1,030 → 266 global tokens, and 5,099 → 946 combined tokens (81.4%). Restoring concise intermediary updates adds 58 model-prompt tokens, so the equivalent combined lineage is now 5,099 → 1,004 (80.3%).

## What remains in the bundled prompt

- user authority and requested scope;
- protection for existing work;
- explicit authorization boundaries for destructive and external actions;
- prompt-injection boundaries;
- proportional inspection and verification;
- honest reporting of failures and gaps;
- questions only when ambiguity materially changes the result;
- concise intermediary updates for meaningful progress and long operations.

## Scenario for the current reference

The current dated comparison removes 2,814 model-instruction tokens per model request.

| Model requests per day | Day | Week | 30 days | Year |
|---:|---:|---:|---:|---:|
| 10 | 28,140 | 196,980 | 844,200 | 10,271,100 |
| 50 | 140,700 | 984,900 | **4,221,000** | **51,355,500** |
| 100 | 281,400 | 1,969,800 | **8,442,000** | **102,711,000** |

These are arithmetic projections. Provider caching, model updates, and plan accounting affect the practical result. They do not imply a fixed number of extra requests.

Run `python tools/measure-prompt-savings.py` to verify the bundled prompt. Pass `--baseline PATH` to compare another instruction file, or:

```sh
python tools/measure-prompt-savings.py --model-cache ~/.codex/models_cache.json --model gpt-5.6-sol
```
