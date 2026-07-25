#!/usr/bin/env python3
"""Build a public, sanitized report from paired DeepSWE/Pier trial artifacts."""

from __future__ import annotations

import argparse
import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
CODEXZERO_FEATURES = (
    "codex_zero_compact_exec_output",
    "codex_zero_lossless_terminal_codec",
    "codex_zero_exact_duplicate_results",
    "codex_zero_event_driven_wait",
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def seconds(start: str, end: str) -> float:
    return (
        datetime.fromisoformat(end.replace("Z", "+00:00"))
        - datetime.fromisoformat(start.replace("Z", "+00:00"))
    ).total_seconds()


def read_trial(path: Path, label: str) -> dict:
    config_path = path / "config.json"
    result_path = path / "result.json"
    reward_path = path / "verifier" / "reward.json"
    trajectory_path = path / "agent" / "trajectory.json"
    patch_path = path / "artifacts" / "model.patch"
    config = json.loads(config_path.read_text(encoding="utf-8"))
    result = json.loads(result_path.read_text(encoding="utf-8"))
    reward = json.loads(reward_path.read_text(encoding="utf-8"))
    trajectory = json.loads(trajectory_path.read_text(encoding="utf-8"))
    metrics = trajectory["final_metrics"]
    agent = config["agent"]
    kwargs = agent["kwargs"]
    config_toml = kwargs.get("config_toml", "")
    if (
        agent["model_name"] != "gpt-5.6-sol"
        or kwargs["reasoning_effort"] != "medium"
        or kwargs["version"] != "0.145.0-alpha.30"
    ):
        raise AssertionError(f"agent configuration mismatch for {label}")
    if label == "codex":
        if config_toml or "CODEX_BINARY_PATH" in agent["env"]:
            raise AssertionError("stock trial was not stock")
    else:
        required = [
            'model_instructions_file = "/tmp/codex-model-instructions.md"',
            *(f"{feature} = true" for feature in CODEXZERO_FEATURES),
        ]
        if (
            not all(value in config_toml for value in required)
            or "CODEX_BINARY_PATH" not in agent["env"]
            or "CODEX_MODEL_INSTRUCTIONS_PATH" not in agent["env"]
        ):
            raise AssertionError("CodexZero trial optimizations were not active")
    prompt = int(metrics["total_prompt_tokens"])
    cached = int(metrics["total_cached_tokens"])
    output = int(metrics["total_completion_tokens"])
    total = int(metrics["extra"]["total_tokens"])
    feature_passed = int(reward["f2p_passed"])
    feature_total = int(reward["f2p_total"])
    regression_passed = int(reward["p2p_passed"])
    regression_total = int(reward["p2p_total"])
    if not 0 <= cached <= prompt or min(prompt, output, total) < 0:
        raise AssertionError(f"invalid provider counters for {label}")
    if total != prompt + output:
        raise AssertionError(f"provider token identity failed for {label}")
    if (
        reward["reward"] != 1
        or reward["partial"] != 1
        or feature_passed != feature_total
        or regression_passed != regression_total
        or result["exception_info"] is not None
    ):
        raise AssertionError(f"DeepSWE quality gate failed for {label}")
    return {
        "configuration": label,
        "task": result["task_name"],
        "task_checksum": result["task_checksum"],
        "resolved": True,
        "reward": reward["reward"],
        "feature_tests": {
            "passed": feature_passed,
            "total": feature_total,
            "rate": reward["f2p"],
        },
        "regression_tests": {
            "passed": regression_passed,
            "total": regression_total,
            "rate": reward["p2p"],
        },
        "partial_score": reward["partial"],
        "configuration_evidence": {
            "trial_config_sha256": sha256(config_path),
            "model": agent["model_name"],
            "reasoning_effort": kwargs["reasoning_effort"],
            "codex_version": kwargs["version"],
            "custom_binary": label == "codexzero",
            "lean_model_instructions": label == "codexzero",
            "enabled_codexzero_features": (
                list(CODEXZERO_FEATURES) if label == "codexzero" else []
            ),
        },
        "provider_tokens": {
            "input": prompt,
            "cached_input": cached,
            "uncached_input": prompt - cached,
            "output": output,
            "reasoning_output": metrics["extra"]["reasoning_output_tokens"],
            "total": total,
            "cache_token_ratio": round(cached / prompt, 6),
        },
        "peak_context_tokens": metrics["extra"]["peak_context_tokens"],
        "summarization_count": metrics["extra"]["summarization_count"],
        "agent_steps": result["n_agent_steps"],
        "agent_time_seconds": round(
            seconds(
                result["agent_execution"]["started_at"],
                result["agent_execution"]["finished_at"],
            ),
            3,
        ),
        "patch": {
            "bytes": patch_path.stat().st_size,
            "sha256": sha256(patch_path),
        },
        "evidence": {
            "result_sha256": sha256(result_path),
            "reward_sha256": sha256(reward_path),
            "trajectory_sha256": sha256(trajectory_path),
        },
    }


def reduction(before: float, after: float) -> dict:
    difference = before - after
    return {
        "absolute": round(difference, 3),
        "percent": round(difference / before * 100, 3) if before else 0,
    }


def markdown(report: dict) -> str:
    stock, optimized = report["trials"]
    comparison = report["comparison"]
    return f"""\
# DeepSWE public-verifier pilot

Both configurations solved the same published DeepSWE task with the official
Pier runner and the task's held-out functional verifier.

| Configuration | Resolved | Feature tests | Regression tests | Provider tokens | Peak context | Agent time |
|---|---:|---:|---:|---:|---:|---:|
| Codex | 1/1 | {stock['feature_tests']['passed']}/{stock['feature_tests']['total']} | {stock['regression_tests']['passed']:,}/{stock['regression_tests']['total']:,} | {stock['provider_tokens']['total']:,} | {stock['peak_context_tokens']:,} | {stock['agent_time_seconds'] / 60:.1f} min |
| CodexZero | 1/1 | {optimized['feature_tests']['passed']}/{optimized['feature_tests']['total']} | {optimized['regression_tests']['passed']:,}/{optimized['regression_tests']['total']:,} | {optimized['provider_tokens']['total']:,} | {optimized['peak_context_tokens']:,} | {optimized['agent_time_seconds'] / 60:.1f} min |

CodexZero kept the same score while using **{comparison['provider_total_tokens']['percent']:.1f}% fewer
provider-counted tokens**, **{comparison['peak_context_tokens']['percent']:.1f}% less peak context**,
and **{comparison['agent_time_seconds']['percent']:.1f}% less agent time** on this task.

## Token and execution detail

| Configuration | Input | Cached input | Cache token ratio | Uncached input | Output | Reasoning output | Steps |
|---|---:|---:|---:|---:|---:|---:|---:|
| Codex | {stock['provider_tokens']['input']:,} | {stock['provider_tokens']['cached_input']:,} | {stock['provider_tokens']['cache_token_ratio']:.1%} | {stock['provider_tokens']['uncached_input']:,} | {stock['provider_tokens']['output']:,} | {stock['provider_tokens']['reasoning_output']:,} | {stock['agent_steps']} |
| CodexZero | {optimized['provider_tokens']['input']:,} | {optimized['provider_tokens']['cached_input']:,} | {optimized['provider_tokens']['cache_token_ratio']:.1%} | {optimized['provider_tokens']['uncached_input']:,} | {optimized['provider_tokens']['output']:,} | {optimized['provider_tokens']['reasoning_output']:,} | {optimized['agent_steps']} |

CodexZero used **{comparison['provider_uncached_input_tokens']['percent']:.1f}% less uncached input**
and **{comparison['provider_output_tokens']['percent']:.1f}% fewer output tokens**. Cache token
ratios were measured, not assumed.

## Scope

- Benchmark: [DeepSWE](https://github.com/datacurve-ai/deep-swe), commit
  `{report['provenance']['deep_swe_commit']}`.
- Runner and verifier: [Pier](https://github.com/datacurve-ai/pier), commit
  `{report['provenance']['pier_commit']}`, with the documented Codex CLI agent.
- Task: `{stock['task']}`, checksum `{stock['task_checksum']}`.
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
"""


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--stock-trial", type=Path, required=True)
    parser.add_argument("--codexzero-trial", type=Path, required=True)
    parser.add_argument("--codexzero-binary", type=Path, required=True)
    parser.add_argument(
        "--lean-prompt",
        type=Path,
        default=ROOT / "prompts" / "codex-core-lean-v1.md",
    )
    parser.add_argument("--deep-swe-commit", required=True)
    parser.add_argument("--pier-commit", required=True)
    args = parser.parse_args()

    stock = read_trial(args.stock_trial, "codex")
    optimized = read_trial(args.codexzero_trial, "codexzero")
    if (
        stock["task"] != optimized["task"]
        or stock["task_checksum"] != optimized["task_checksum"]
    ):
        raise AssertionError("paired trials do not use the same task")
    comparison = {
        "quality_delta": optimized["reward"] - stock["reward"],
        "provider_total_tokens": reduction(
            stock["provider_tokens"]["total"],
            optimized["provider_tokens"]["total"],
        ),
        "provider_uncached_input_tokens": reduction(
            stock["provider_tokens"]["uncached_input"],
            optimized["provider_tokens"]["uncached_input"],
        ),
        "provider_output_tokens": reduction(
            stock["provider_tokens"]["output"],
            optimized["provider_tokens"]["output"],
        ),
        "peak_context_tokens": reduction(
            stock["peak_context_tokens"], optimized["peak_context_tokens"]
        ),
        "agent_time_seconds": reduction(
            stock["agent_time_seconds"], optimized["agent_time_seconds"]
        ),
    }
    runner_patches = {
        path.name: sha256(path)
        for path in sorted((ROOT / "tools").glob("pier-*.patch"))
    }
    report = {
        "schema": "codexzero-deepswe-pilot-v1",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "benchmark": "DeepSWE",
        "runner": "Pier",
        "model": "gpt-5.6-sol",
        "reasoning_effort": "medium",
        "sample_size": 1,
        "resolved_rate": {"codex": 1.0, "codexzero": 1.0},
        "trials": [stock, optimized],
        "comparison": comparison,
        "provenance": {
            "deep_swe_commit": args.deep_swe_commit,
            "pier_commit": args.pier_commit,
            "codex_version": "0.145.0-alpha.30",
            "codexzero_binary_sha256": sha256(args.codexzero_binary),
            "lean_prompt_sha256": sha256(args.lean_prompt),
            "runner_patch_sha256": runner_patches,
        },
        "limitations": [
            "One paired task cannot estimate full-corpus resolved rate.",
            "The five-task expansion was stopped by the account usage limit.",
            "No interrupted or incomplete attempt is counted as a quality result.",
        ],
    }
    json_path = ROOT / "reports" / "deepswe-pilot.json"
    md_path = ROOT / "reports" / "deepswe-pilot.md"
    json_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    md_path.write_text(markdown(report), encoding="utf-8")
    print(md_path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
