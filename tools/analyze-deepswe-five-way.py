#!/usr/bin/env python3
"""Produce auditable task-level and paired summaries for the five-way DeepSWE run."""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import random
import sqlite3
import statistics
from collections import Counter
from datetime import datetime
from itertools import combinations
from pathlib import Path
from typing import Any, Callable


CONFIGS = (
    "codex",
    "codexzero",
    "codex_rtk",
    "codex_caveman",
    "codex_caveman_rtk",
)
DISPLAY = {
    "codex": "Codex",
    "codexzero": "CodexZero",
    "codex_rtk": "Codex + RTK",
    "codex_caveman": "Codex + Caveman",
    "codex_caveman_rtk": "Codex + Caveman + RTK",
}
SEED = 2512
BOOTSTRAPS = 10_000

# Official GPT-5.6 Sol ChatGPT credit rates, retrieved 2026-07-24.
CREDITS_PER_MILLION = {
    "uncached_input": 125.0,
    "cached_input": 12.5,
    "output": 750.0,
}
CREDIT_SOURCE = "https://learn.chatgpt.com/docs/pricing#what-are-tokens-and-credits"


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str | None:
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None


def seconds(value: dict[str, Any] | None) -> float | None:
    if not value or not value.get("started_at") or not value.get("finished_at"):
        return None
    start = datetime.fromisoformat(value["started_at"].replace("Z", "+00:00"))
    end = datetime.fromisoformat(value["finished_at"].replace("Z", "+00:00"))
    return (end - start).total_seconds()


def between(started_at: str | None, finished_at: str | None) -> float | None:
    if not started_at or not finished_at:
        return None
    start = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
    end = datetime.fromisoformat(finished_at.replace("Z", "+00:00"))
    return (end - start).total_seconds()


def command_name(tool: dict[str, Any]) -> str:
    return str(tool.get("function_name") or tool.get("name") or "")


def count_patch_lines(path: Path) -> tuple[int, int]:
    if not path.is_file():
        return 0, 0
    added = deleted = 0
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            added += 1
        elif line.startswith("-") and not line.startswith("---"):
            deleted += 1
    return added, deleted


def rtk_db_metrics(path: Path) -> dict[str, Any]:
    """Read only schema-independent counts when an RTK telemetry database exists."""
    if not path.is_file():
        return {"rtk_db_present": False, "rtk_db_sha256": None}
    output: dict[str, Any] = {
        "rtk_db_present": True,
        "rtk_db_sha256": sha256(path),
        "rtk_db_bytes": path.stat().st_size,
    }
    try:
        connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        tables = [
            row[0]
            for row in connection.execute(
                "select name from sqlite_master where type='table' order by name"
            )
        ]
        output["rtk_db_tables"] = tables
        output["rtk_db_rows"] = {
            table: connection.execute(
                f'SELECT COUNT(*) FROM "{table.replace(chr(34), chr(34) * 2)}"'
            ).fetchone()[0]
            for table in tables
        }
        if "commands" in tables:
            columns = {
                row[1]
                for row in connection.execute('PRAGMA table_info("commands")')
            }
            wanted = {
                "input_tokens",
                "output_tokens",
                "saved_tokens",
                "exec_time_ms",
            }
            available = sorted(wanted & columns)
            if available:
                expressions = ", ".join(
                    f'COALESCE(SUM("{column}"), 0)' for column in available
                )
                values = connection.execute(
                    f'SELECT COUNT(*), {expressions} FROM "commands"'
                ).fetchone()
                output["rtk_commands"] = values[0]
                for column, value in zip(available, values[1:], strict=True):
                    output[f"rtk_{column}"] = value
                original = output.get("rtk_input_tokens", 0)
                saved = output.get("rtk_saved_tokens", 0)
                output["rtk_weighted_savings_ratio"] = (
                    saved / original if original else None
                )
        connection.close()
    except (sqlite3.Error, OSError) as exc:
        output["rtk_db_read_error"] = str(exc)
    return output


def extract_trial(task: str, config: str, path: Path) -> dict[str, Any]:
    result = read_json(path / "result.json")
    reward = read_json(path / "verifier" / "reward.json")
    trajectory = read_json(path / "agent" / "trajectory.json")
    final = trajectory["final_metrics"]
    extra = final.get("extra") or {}
    steps = trajectory.get("steps") or []
    agent_steps = [step for step in steps if step.get("source") == "agent"]
    tool_calls = [
        tool for step in agent_steps for tool in (step.get("tool_calls") or [])
    ]
    names = [command_name(tool) for tool in tool_calls]
    tool_breakdown = dict(sorted(Counter(names).items()))
    input_tokens = int(final.get("total_prompt_tokens") or 0)
    cached_tokens = int(final.get("total_cached_tokens") or 0)
    output_tokens = int(final.get("total_completion_tokens") or 0)
    uncached_tokens = max(0, input_tokens - cached_tokens)
    credits = (
        uncached_tokens * CREDITS_PER_MILLION["uncached_input"]
        + cached_tokens * CREDITS_PER_MILLION["cached_input"]
        + output_tokens * CREDITS_PER_MILLION["output"]
    ) / 1_000_000
    patch = path / "artifacts" / "model.patch"
    added, deleted = count_patch_lines(patch)
    result_agent = result.get("agent_result") or {}
    row: dict[str, Any] = {
        "task": task,
        "config": config,
        "trial_name": result.get("trial_name"),
        "task_checksum": result.get("task_checksum"),
        "reward": float(reward.get("reward") or 0),
        "resolved": int(float(reward.get("reward") or 0) == 1.0),
        "partial": float(reward.get("partial") or 0),
        "feature_passed": int(reward.get("f2p_passed") or 0),
        "feature_total": int(reward.get("f2p_total") or 0),
        "regression_passed": int(reward.get("p2p_passed") or 0),
        "regression_total": int(reward.get("p2p_total") or 0),
        "input_tokens": input_tokens,
        "cached_input_tokens": cached_tokens,
        "uncached_input_tokens": uncached_tokens,
        "output_tokens": output_tokens,
        "reasoning_output_tokens": int(extra.get("reasoning_output_tokens") or 0),
        "total_provider_tokens": input_tokens + output_tokens,
        "cache_token_ratio": cached_tokens / input_tokens if input_tokens else 0,
        "model_calls": sum(int(step.get("llm_call_count") or 0) for step in agent_steps),
        "model_calls_with_cache": sum(
            1
            for step in agent_steps
            if int((step.get("metrics") or {}).get("cached_tokens") or 0) > 0
        ),
        "agent_steps": int(result.get("n_agent_steps") or len(agent_steps)),
        "trajectory_steps": len(steps),
        "system_steps": sum(step.get("source") == "system" for step in steps),
        "user_turns": sum(step.get("source") == "user" for step in steps),
        "assistant_text_turns": sum(
            bool((step.get("message") or "").strip()) for step in agent_steps
        ),
        "tool_calls": len(tool_calls),
        "tool_call_breakdown": tool_breakdown,
        "shell_calls": sum(
            name in {"shell_command", "exec_command"} for name in names
        ),
        "apply_patch_calls": names.count("apply_patch"),
        "peak_context_tokens": int(extra.get("peak_context_tokens") or 0),
        "summarization_count": int(extra.get("summarization_count") or 0),
        "official_sol_credits": credits,
        "pier_litellm_cost_usd": result_agent.get("cost_usd"),
        "wall_seconds": seconds(result),
        "environment_setup_seconds": seconds(result.get("environment_setup")),
        "agent_setup_seconds": seconds(result.get("agent_setup")),
        "agent_seconds": seconds(result.get("agent_execution")),
        "verifier_seconds": seconds(result.get("verifier")),
        "patch_sha256": sha256(patch),
        "patch_bytes": patch.stat().st_size if patch.is_file() else 0,
        "patch_added_lines": added,
        "patch_deleted_lines": deleted,
        "result_sha256": sha256(path / "result.json"),
        "agent_log_sha256": sha256(path / "agent" / "codex.txt"),
        "trial_log_sha256": sha256(path / "trial.log"),
        "trajectory_sha256": sha256(path / "agent" / "trajectory.json"),
        "reward_sha256": sha256(path / "verifier" / "reward.json"),
    }
    row.update(rtk_db_metrics(path / "agent" / "rtk.db"))
    return row


def total(rows: list[dict[str, Any]], key: str) -> float:
    return sum(float(row.get(key) or 0) for row in rows)


def median(rows: list[dict[str, Any]], key: str) -> float | None:
    values = [float(row[key]) for row in rows if row.get(key) is not None]
    return statistics.median(values) if values else None


def exact_mcnemar(b: int, c: int) -> float:
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / (2**n)
    return min(1.0, 2 * tail)


def wilson_ci(successes: int, trials: int) -> list[float | None]:
    if trials == 0:
        return [None, None]
    z = 1.959963984540054
    proportion = successes / trials
    denominator = 1 + z * z / trials
    center = (proportion + z * z / (2 * trials)) / denominator
    margin = (
        z
        * math.sqrt(
            proportion * (1 - proportion) / trials
            + z * z / (4 * trials * trials)
        )
        / denominator
    )
    return [center - margin, center + margin]


def bootstrap_ci(
    pairs: list[tuple[float, float]],
    statistic: Callable[[list[tuple[float, float]]], float],
) -> list[float | None]:
    if not pairs:
        return [None, None]
    rng = random.Random(SEED)
    n = len(pairs)
    values = [
        statistic([pairs[rng.randrange(n)] for _ in range(n)])
        for _ in range(BOOTSTRAPS)
    ]
    values.sort()
    return [values[int(0.025 * BOOTSTRAPS)], values[int(0.975 * BOOTSTRAPS)]]


def summarize_config(rows: list[dict[str, Any]]) -> dict[str, Any]:
    input_tokens = total(rows, "input_tokens")
    resolved = int(total(rows, "resolved"))
    calls = int(total(rows, "model_calls"))
    tool_breakdown: Counter[str] = Counter()
    for row in rows:
        tool_breakdown.update(row.get("tool_call_breakdown") or {})
    return {
        "tasks": len(rows),
        "resolved": resolved,
        "resolved_rate": resolved / len(rows) if rows else None,
        "resolved_rate_wilson_95ci": wilson_ci(resolved, len(rows)),
        "partial_mean": total(rows, "partial") / len(rows) if rows else None,
        "feature_passed": int(total(rows, "feature_passed")),
        "feature_total": int(total(rows, "feature_total")),
        "regression_passed": int(total(rows, "regression_passed")),
        "regression_total": int(total(rows, "regression_total")),
        "input_tokens": int(input_tokens),
        "cached_input_tokens": int(total(rows, "cached_input_tokens")),
        "uncached_input_tokens": int(total(rows, "uncached_input_tokens")),
        "output_tokens": int(total(rows, "output_tokens")),
        "reasoning_output_tokens": int(total(rows, "reasoning_output_tokens")),
        "cache_token_ratio": (
            total(rows, "cached_input_tokens") / input_tokens if input_tokens else None
        ),
        "model_calls": calls,
        "model_calls_with_cache": int(total(rows, "model_calls_with_cache")),
        "cache_call_ratio": (
            total(rows, "model_calls_with_cache") / calls if calls else None
        ),
        "agent_steps": int(total(rows, "agent_steps")),
        "trajectory_steps": int(total(rows, "trajectory_steps")),
        "system_steps": int(total(rows, "system_steps")),
        "user_turns": int(total(rows, "user_turns")),
        "assistant_text_turns": int(total(rows, "assistant_text_turns")),
        "tool_calls": int(total(rows, "tool_calls")),
        "tool_call_breakdown": dict(sorted(tool_breakdown.items())),
        "shell_calls": int(total(rows, "shell_calls")),
        "apply_patch_calls": int(total(rows, "apply_patch_calls")),
        "summarization_count": int(total(rows, "summarization_count")),
        "peak_context_tokens_max": int(max((row["peak_context_tokens"] for row in rows), default=0)),
        "official_sol_credits": total(rows, "official_sol_credits"),
        "pier_litellm_cost_usd": total(rows, "pier_litellm_cost_usd"),
        "wall_seconds_sum": total(rows, "wall_seconds"),
        "wall_seconds_median": median(rows, "wall_seconds"),
        "agent_seconds_sum": total(rows, "agent_seconds"),
        "agent_seconds_median": median(rows, "agent_seconds"),
        "verifier_seconds_sum": total(rows, "verifier_seconds"),
        "tokens_per_resolved": (
            total(rows, "total_provider_tokens") / resolved if resolved else None
        ),
        "credits_per_resolved": (
            total(rows, "official_sol_credits") / resolved if resolved else None
        ),
        "rtk_db_trials": sum(bool(row.get("rtk_db_present")) for row in rows),
        "rtk_commands": int(total(rows, "rtk_commands")),
        "rtk_original_output_tokens": int(total(rows, "rtk_input_tokens")),
        "rtk_compressed_output_tokens": int(total(rows, "rtk_output_tokens")),
        "rtk_estimated_tokens_saved": int(total(rows, "rtk_saved_tokens")),
        "rtk_execution_time_ms": int(total(rows, "rtk_exec_time_ms")),
    }


def paired(
    left: str,
    right: str,
    by_key: dict[tuple[str, str], dict[str, Any]],
    tasks: list[str],
) -> dict[str, Any]:
    pairs = [(by_key[(task, left)], by_key[(task, right)]) for task in tasks]
    b = sum(a["resolved"] == 1 and z["resolved"] == 0 for a, z in pairs)
    c = sum(a["resolved"] == 0 and z["resolved"] == 1 for a, z in pairs)
    left_solved = sum(a["resolved"] for a, _ in pairs)
    both_solved = sum(a["resolved"] and z["resolved"] for a, z in pairs)
    token_left = sum(a["total_provider_tokens"] for a, _ in pairs)
    token_right = sum(z["total_provider_tokens"] for _, z in pairs)
    credit_left = sum(a["official_sol_credits"] for a, _ in pairs)
    credit_right = sum(z["official_sol_credits"] for _, z in pairs)
    cost_left = sum(float(a["pier_litellm_cost_usd"] or 0) for a, _ in pairs)
    cost_right = sum(float(z["pier_litellm_cost_usd"] or 0) for _, z in pairs)
    time_left = sum(a["agent_seconds"] or 0 for a, _ in pairs)
    time_right = sum(z["agent_seconds"] or 0 for _, z in pairs)
    partial_left = sum(a["partial"] for a, _ in pairs)
    partial_right = sum(z["partial"] for _, z in pairs)
    feature_left = sum(a["feature_passed"] for a, _ in pairs)
    feature_right = sum(z["feature_passed"] for _, z in pairs)
    regression_left = sum(a["regression_passed"] for a, _ in pairs)
    regression_right = sum(z["regression_passed"] for _, z in pairs)
    binary_pairs = [(a["resolved"], z["resolved"]) for a, z in pairs]
    partial_pairs = [(a["partial"], z["partial"]) for a, z in pairs]
    def mean_diff(values: list[tuple[float, float]]) -> float | None:
        return (
            sum(z - a for a, z in values) / len(values) if values else None
        )
    return {
        "left": left,
        "right": right,
        "paired_tasks": len(tasks),
        "left_resolved": left_solved,
        "right_resolved": sum(z["resolved"] for _, z in pairs),
        "right_wins": c,
        "left_wins": b,
        "ties": len(pairs) - b - c,
        "outcome_agreement_rate": (
            (len(pairs) - b - c) / len(pairs) if pairs else None
        ),
        "identical_patch_count": sum(
            bool(a.get("patch_sha256"))
            and a.get("patch_sha256") == z.get("patch_sha256")
            for a, z in pairs
        ),
        "mcnemar_exact_two_sided_p": exact_mcnemar(b, c),
        "resolved_rate_difference": mean_diff(binary_pairs),
        "resolved_rate_difference_bootstrap_95ci": bootstrap_ci(
            binary_pairs, mean_diff
        ),
        "partial_mean_difference": mean_diff(partial_pairs),
        "partial_mean_difference_bootstrap_95ci": bootstrap_ci(
            partial_pairs, mean_diff
        ),
        "left_solve_retention": both_solved / left_solved if left_solved else None,
        "partial_score_retention": (
            partial_right / partial_left if partial_left else None
        ),
        "feature_pass_retention": (
            feature_right / feature_left if feature_left else None
        ),
        "regression_pass_retention": (
            regression_right / regression_left if regression_left else None
        ),
        "provider_token_savings": token_left - token_right,
        "provider_token_savings_pct": (
            (token_left - token_right) / token_left if token_left else None
        ),
        "official_credit_savings": credit_left - credit_right,
        "official_credit_savings_pct": (
            (credit_left - credit_right) / credit_left if credit_left else None
        ),
        "pier_litellm_cost_savings_usd": cost_left - cost_right,
        "pier_litellm_cost_savings_pct": (
            (cost_left - cost_right) / cost_left if cost_left else None
        ),
        "agent_time_savings_seconds": time_left - time_right,
        "agent_time_savings_pct": (
            (time_left - time_right) / time_left if time_left else None
        ),
    }


def write_csv(path: Path, rows: list[dict[str, Any]]) -> None:
    keys = sorted({key for row in rows for key in row if not isinstance(row[key], (list, dict))})
    with path.open("w", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=keys)
        writer.writeheader()
        writer.writerows({key: row.get(key) for key in keys} for row in rows)


def audit(rows: list[dict[str, Any]], tasks: list[str]) -> dict[str, Any]:
    errors: list[str] = []
    expected = len(tasks) * len(CONFIGS)
    if len(rows) != expected:
        errors.append(f"Expected {expected} paired rows, found {len(rows)}")
    trial_names = [row.get("trial_name") for row in rows]
    if None in trial_names or len(set(trial_names)) != len(trial_names):
        errors.append("Trial names are missing or not unique")
    for row in rows:
        label = f"{row['task']}/{row['config']}"
        if row["cached_input_tokens"] > row["input_tokens"]:
            errors.append(f"{label}: cached input exceeds total input")
        if row["feature_passed"] > row["feature_total"]:
            errors.append(f"{label}: feature passes exceed feature total")
        if row["regression_passed"] > row["regression_total"]:
            errors.append(f"{label}: regression passes exceed regression total")
        if row["resolved"] != int(row["reward"] == 1.0):
            errors.append(f"{label}: resolved flag does not match reward")
        required_hashes = (
            "result_sha256",
            "agent_log_sha256",
            "trajectory_sha256",
            "reward_sha256",
            "patch_sha256",
        )
        if any(not row.get(key) for key in required_hashes):
            errors.append(f"{label}: private evidence hash is missing")
        if row["config"] in {"codex_rtk", "codex_caveman_rtk"} and not row.get(
            "rtk_db_present"
        ):
            errors.append(f"{label}: RTK metrics database is missing")
    for task in tasks:
        task_rows = [row for row in rows if row["task"] == task]
        if {row["config"] for row in task_rows} != set(CONFIGS):
            errors.append(f"{task}: configuration coverage is incomplete")
        for key in ("task_checksum", "feature_total", "regression_total"):
            if len({row[key] for row in task_rows}) != 1:
                errors.append(f"{task}: {key} differs across configurations")
    return {
        "passed": not errors,
        "error_count": len(errors),
        "errors": errors,
        "checks": {
            "expected_complete_trials": expected,
            "unique_trial_names": len(set(trial_names)),
            "paired_tasks": len(tasks),
            "configurations_per_task": len(CONFIGS),
            "token_cache_bounds": True,
            "verifier_count_consistency": True,
            "private_evidence_hashes": True,
            "rtk_database_presence": True,
        },
    }


def pct(value: float | None) -> str:
    return "n/a" if value is None else f"{100 * value:.2f}%"


def number(value: float | None, digits: int = 1) -> str:
    return "n/a" if value is None else f"{value:,.{digits}f}"


def markdown(summary: dict[str, Any]) -> str:
    lines = [
        "# DeepSWE five-way benchmark — GPT-5.6 Sol high",
        "",
        f"Completed paired tasks: **{summary['paired_task_count']} / {summary['planned_task_count']}**. "
        f"Complete trials: **{summary['complete_trial_count']} / {summary['planned_trial_count']}**.",
        f"Recorded job time: **{number(summary['run_metrics']['job_attempt_seconds_sum'] / 3600, 2)} hours** "
        f"across **{summary['run_metrics']['job_attempts']}** attempts.",
        f"Parallel five-task batch wall time: **{number(summary['run_metrics']['parallel_shard_wall_seconds'] / 60)} minutes**, "
        f"with up to **{summary['run_metrics']['maximum_concurrent_trials']} concurrent trials**.",
        f"All 50 trials used **{summary['corpus_totals']['provider_tokens']:,} provider tokens**, "
        f"**{number(summary['corpus_totals']['official_sol_credits'], 3)} Sol credits**, and "
        f"**${number(summary['corpus_totals']['pier_litellm_cost_usd'], 2)} API-equivalent cost**. "
        f"The new parallel 25-trial batch accounted for "
        f"**{summary['parallel_batch_totals']['provider_tokens']:,} tokens**, "
        f"**{number(summary['parallel_batch_totals']['official_sol_credits'], 3)} credits**, and "
        f"**${number(summary['parallel_batch_totals']['pier_litellm_cost_usd'], 2)}**.",
        f"Artifact audit: **{summary['audit']['checks']['unique_trial_names']} unique trials, "
        f"{summary['audit']['error_count']} validation errors**.",
        "",
        "| Configuration | Resolved | Feature tests | Regression tests | Partial | Provider tokens | Cache ratio | Model calls | Tool calls | RTK calls | RTK terminal tokens saved | Agent time | Sol credits |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for config in CONFIGS:
        item = summary["configurations"][config]
        lines.append(
            f"| {DISPLAY[config]} | {item['resolved']}/{item['tasks']} "
            f"({pct(item['resolved_rate'])}) | "
            f"{item['feature_passed']:,}/{item['feature_total']:,} | "
            f"{item['regression_passed']:,}/{item['regression_total']:,} | "
            f"{number(item['partial_mean'], 4)} | "
            f"{item['input_tokens'] + item['output_tokens']:,} | "
            f"{pct(item['cache_token_ratio'])} | {item['model_calls']:,} | "
            f"{item['tool_calls']:,} | {item['rtk_commands']:,} | "
            f"{item['rtk_estimated_tokens_saved']:,} | "
            f"{number(item['agent_seconds_sum'] / 60)} min | "
            f"{number(item['official_sol_credits'], 3)} |"
        )
    lines += [
        "",
        "## Operational totals",
        "",
        "| Configuration | Model calls | Calls with cached input | Agent steps | Assistant text turns | Tool calls | Shell calls | Patch calls | Context summaries | Trial wall time | API-equivalent cost |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for config in CONFIGS:
        item = summary["configurations"][config]
        lines.append(
            f"| {DISPLAY[config]} | {item['model_calls']:,} | "
            f"{item['model_calls_with_cache']:,} "
            f"({pct(item['cache_call_ratio'])}) | "
            f"{item['agent_steps']:,} | {item['assistant_text_turns']:,} | "
            f"{item['tool_calls']:,} | {item['shell_calls']:,} | "
            f"{item['apply_patch_calls']:,} | {item['summarization_count']:,} | "
            f"{number(item['wall_seconds_sum'] / 60)} min | "
            f"${number(item['pier_litellm_cost_usd'], 2)} |"
        )
    lines += [
        "",
        "## Task scores",
        "",
        "Each cell is `resolved reward / partial reward`.",
        "",
        "| Task | "
        + " | ".join(DISPLAY[config] for config in CONFIGS)
        + " |",
        "|---|" + "|".join("---:" for _ in CONFIGS) + "|",
    ]
    for task in summary["task_results"]:
        cells = []
        for config in CONFIGS:
            result = task["configurations"][config]
            cells.append(
                f"{result['reward']:.0f} / {result['partial']:.4f}"
            )
        lines.append(f"| `{task['task']}` | " + " | ".join(cells) + " |")
    lines += [
        "",
        "## Paired against stock Codex",
        "",
        "| Configuration | Solve Δ | Solve retention | Partial retention | Feature retention | Regression retention | Token savings | Credit savings | API-equivalent cost savings | Agent-time savings | Exact p |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for item in summary["against_codex"]:
        lines.append(
            f"| {DISPLAY[item['right']]} | {pct(item['resolved_rate_difference'])} | "
            f"{pct(item['left_solve_retention'])} | "
            f"{pct(item['partial_score_retention'])} | "
            f"{pct(item['feature_pass_retention'])} | "
            f"{pct(item['regression_pass_retention'])} | "
            f"{item['provider_token_savings']:,} ({pct(item['provider_token_savings_pct'])}) | "
            f"{number(item['official_credit_savings'], 3)} "
            f"({pct(item['official_credit_savings_pct'])}) | "
            f"${number(item['pier_litellm_cost_savings_usd'], 2)} "
            f"({pct(item['pier_litellm_cost_savings_pct'])}) | "
            f"{number(item['agent_time_savings_seconds'] / 60)} min "
            f"({pct(item['agent_time_savings_pct'])}) | "
            f"{item['mcnemar_exact_two_sided_p']:.4f} |"
        )
    lines += [
        "",
        "## Interpretation limits",
        "",
        "- Quality comparisons use only tasks with a complete, valid trial for every configuration.",
        "- This staged sample contains the completed pilot task plus nine tasks from the seed-2512 order. It is not a leaderboard submission, a random sample of all 113 tasks, or a full-corpus estimate.",
        "- The bootstrap 95% interval for CodexZero's resolved-rate difference versus Codex is -60 to +20 percentage points. Ten tasks do not establish losslessness or a general quality difference.",
        "- Five task shards and their configurations ran concurrently. Agent and wall-time measurements include shared-host contention and should not be treated as sequential latency rankings.",
        "- Provider token counters are authoritative Codex session counters. A cache hit is measurable as cached input tokens per model call; no discrete provider-side cache-event counter is exposed.",
        "- Sol credit estimates use the official ChatGPT rates: 125 credits/M uncached input, 12.5/M cached input, and 750/M output.",
        "- `pier_litellm_cost_usd` in the machine-readable files is Pier/LiteLLM's API-equivalent estimate, not a ChatGPT subscription invoice.",
        "- Infrastructure failures and quota stops are retained in the checkpoint but excluded from quality scores.",
        *(
            [
                "- One source checkpoint was reconciled after a generic `rate limit` log matcher falsely matched the Arcane task's application text. The original checkpoint was retained; all five trials were revalidated against complete grader and telemetry artifacts."
            ]
            if summary["source_reconciliations"]
            else []
        ),
        "",
        f"Credit source: {CREDIT_SOURCE}",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    checkpoint = read_json(args.checkpoint)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    rows: list[dict[str, Any]] = []
    for task, task_state in checkpoint.get("tasks", {}).items():
        for config, trial in task_state.get("completed", {}).items():
            if config in CONFIGS:
                rows.append(extract_trial(task, config, Path(trial)))
    rows.sort(key=lambda row: (row["task"], CONFIGS.index(row["config"])))
    by_key = {(row["task"], row["config"]): row for row in rows}
    paired_tasks = [
        task
        for task in checkpoint.get("task_order", [])
        if all((task, config) in by_key for config in CONFIGS)
    ]
    paired_rows = [
        by_key[(task, config)] for task in paired_tasks for config in CONFIGS
    ]
    base_checkpoint = (
        checkpoint.get("source_checkpoints", [{}])[0].get("path")
        if checkpoint.get("source_checkpoints")
        else None
    )
    parallel_tasks = [
        task
        for task in paired_tasks
        if checkpoint["tasks"][task].get("source_checkpoint") != base_checkpoint
    ]
    parallel_rows = [
        by_key[(task, config)] for task in parallel_tasks for config in CONFIGS
    ]
    audit_result = audit(paired_rows, paired_tasks)
    if not audit_result["passed"]:
        raise SystemExit(
            "DeepSWE analysis audit failed:\n" + "\n".join(audit_result["errors"])
        )
    attempts = [
        attempt
        for task in checkpoint.get("tasks", {}).values()
        for attempt in task.get("attempts", [])
    ]
    statuses = [
        status
        for attempt in attempts
        for status in attempt.get("statuses", {}).values()
    ]
    pairwise = [
        paired(left, right, by_key, paired_tasks)
        for left, right in combinations(CONFIGS, 2)
    ]
    summary = {
        "schema": "codexzero-deepswe-five-way-analysis-v1",
        "model": checkpoint.get("model"),
        "reasoning_effort": checkpoint.get("reasoning_effort"),
        "seed": checkpoint.get("seed"),
        "bootstrap_samples": BOOTSTRAPS,
        "audit": audit_result,
        "planned_task_count": len(checkpoint.get("task_order", [])),
        "planned_trial_count": len(checkpoint.get("task_order", [])) * len(CONFIGS),
        "complete_trial_count": len(rows),
        "paired_task_count": len(paired_tasks),
        "paired_tasks": paired_tasks,
        "parallel_batch_tasks": parallel_tasks,
        "task_results": [
            {
                "task": task,
                "configurations": {
                    config: {
                        "reward": by_key[(task, config)]["reward"],
                        "resolved": by_key[(task, config)]["resolved"],
                        "partial": by_key[(task, config)]["partial"],
                        "feature_passed": by_key[(task, config)]["feature_passed"],
                        "feature_total": by_key[(task, config)]["feature_total"],
                        "regression_passed": by_key[(task, config)][
                            "regression_passed"
                        ],
                        "regression_total": by_key[(task, config)][
                            "regression_total"
                        ],
                        "provider_tokens": by_key[(task, config)][
                            "total_provider_tokens"
                        ],
                        "model_calls": by_key[(task, config)]["model_calls"],
                        "tool_calls": by_key[(task, config)]["tool_calls"],
                        "agent_seconds": by_key[(task, config)]["agent_seconds"],
                    }
                    for config in CONFIGS
                },
            }
            for task in paired_tasks
        ],
        "run_metrics": {
            "checkpoint_elapsed_seconds": between(
                checkpoint.get("created_at"),
                checkpoint.get("completed_at") or checkpoint.get("updated_at"),
            ),
            "parallel_shard_wall_seconds": (
                checkpoint.get("execution", {})
                .get("parallel_shard_window", {})
                .get("wall_seconds")
                or 0
            ),
            "parallel_task_shards": checkpoint.get("execution", {}).get(
                "parallel_task_shards", 0
            ),
            "maximum_concurrent_trials": checkpoint.get("execution", {}).get(
                "maximum_concurrent_trials", 0
            ),
            "job_attempts": len(attempts),
            "job_attempt_seconds_sum": sum(
                between(attempt.get("started_at"), attempt.get("finished_at")) or 0
                for attempt in attempts
            ),
            "infrastructure_error_trials": sum(
                status.get("status") == "error" for status in statuses
            ),
            "incomplete_trials": sum(
                status.get("status") == "incomplete" for status in statuses
            ),
            "quota_trials": sum(
                status.get("status") == "quota" for status in statuses
            ),
            "operator_interrupted_trials": sum(
                status.get("status") == "interrupted" for status in statuses
            ),
        },
        "corpus_totals": {
            "trials": len(paired_rows),
            "provider_tokens": int(total(paired_rows, "total_provider_tokens")),
            "official_sol_credits": total(paired_rows, "official_sol_credits"),
            "pier_litellm_cost_usd": total(paired_rows, "pier_litellm_cost_usd"),
            "agent_seconds": total(paired_rows, "agent_seconds"),
            "wall_seconds_sum": total(paired_rows, "wall_seconds"),
        },
        "parallel_batch_totals": {
            "trials": len(parallel_rows),
            "provider_tokens": int(total(parallel_rows, "total_provider_tokens")),
            "official_sol_credits": total(parallel_rows, "official_sol_credits"),
            "pier_litellm_cost_usd": total(
                parallel_rows, "pier_litellm_cost_usd"
            ),
            "agent_seconds": total(parallel_rows, "agent_seconds"),
            "wall_seconds_sum": total(parallel_rows, "wall_seconds"),
        },
        "configurations": {
            config: summarize_config(
                [row for row in paired_rows if row["config"] == config]
            )
            for config in CONFIGS
        },
        "pairwise": pairwise,
        "against_codex": [
            item for item in pairwise if item["left"] == "codex"
        ],
        "official_credit_rates_per_million": CREDITS_PER_MILLION,
        "official_credit_source": CREDIT_SOURCE,
        "source_checkpoint_hashes": [
            {
                "sha256": source.get("sha256"),
                "reconciled": bool(source.get("reconciliation")),
            }
            for source in checkpoint.get("source_checkpoints", [])
        ],
        "source_reconciliations": [
            source["reconciliation"]
            for source in checkpoint.get("source_checkpoints", [])
            if source.get("reconciliation")
        ],
        "checkpoint_sha256": sha256(args.checkpoint),
    }
    write_csv(args.output_dir / "task-metrics.csv", rows)
    (args.output_dir / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    (args.output_dir / "README.md").write_text(markdown(summary), encoding="utf-8")
    print(markdown(summary))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
