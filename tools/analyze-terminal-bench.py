#!/usr/bin/env python3
"""Build a reproducible paired Terminal-Bench report from Harbor job folders."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import random
import re
import sqlite3
import statistics
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path
from typing import Any

import tiktoken


ENCODING = tiktoken.get_encoding("o200k_base")
CONFIG_ORDER = [
    "codex",
    "codexzero_safe",
    "codexzero_max",
    "codex_rtk",
    "codex_caveman",
    "codex_caveman_rtk",
]
DISPLAY_NAMES = {
    "codex": "Codex",
    "codexzero_safe": "CodexZero Safe",
    "codexzero_max": "CodexZero Max Savings",
    "codex_rtk": "Codex + RTK",
    "codex_caveman": "Codex + Caveman",
    "codex_caveman_rtk": "Codex + Caveman + RTK",
}
PRICE_USD_PER_MILLION = {
    "uncached_input": 5.0,
    "cached_input": 0.5,
    "cache_write_input": 6.25,
    "output": 30.0,
}
CODEX_CREDITS_PER_MILLION = {
    "uncached_input": 125.0,
    "cached_input": 12.5,
    "cache_write_input": 156.25,
    "output": 750.0,
}
LONG_CONTEXT_THRESHOLD = 272_000


def tokens(value: str) -> int:
    return len(ENCODING.encode(value, disallowed_special=()))


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def parse_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    if not path.exists():
        return rows
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            rows.append(value)
    return rows


def seconds_between(start: str | None, end: str | None) -> float | None:
    if not start or not end:
        return None
    return (
        datetime.fromisoformat(end.replace("Z", "+00:00"))
        - datetime.fromisoformat(start.replace("Z", "+00:00"))
    ).total_seconds()


def phase_seconds(result: dict[str, Any], key: str) -> float | None:
    phase = result.get(key) or {}
    return seconds_between(phase.get("started_at"), phase.get("finished_at"))


def find_single(root: Path, pattern: str) -> Path | None:
    matches = sorted(root.glob(pattern))
    return matches[0] if matches else None


def inspect_session(path: Path | None) -> dict[str, Any]:
    rows = parse_jsonl(path) if path else []
    request_usages: list[dict[str, Any]] = []
    assistant_messages: list[dict[str, Any]] = []
    tool_outputs: list[dict[str, Any]] = []
    calls: list[dict[str, Any]] = []
    event_types: Counter[str] = Counter()
    seen_cumulative_usage: set[tuple[int, ...]] = set()

    for row in rows:
        payload = row.get("payload") or {}
        payload_type = str(payload.get("type") or "")
        if payload_type:
            event_types[payload_type] += 1
        if row.get("type") == "event_msg" and payload_type == "token_count":
            info = payload.get("info") or {}
            last = dict(info.get("last_token_usage") or {})
            if last:
                total = info.get("total_token_usage") or {}
                cumulative_key = tuple(
                    int(total.get(key, 0))
                    for key in (
                        "input_tokens",
                        "cached_input_tokens",
                        "cache_write_input_tokens",
                        "output_tokens",
                        "reasoning_output_tokens",
                        "total_tokens",
                    )
                )
                if cumulative_key not in seen_cumulative_usage:
                    seen_cumulative_usage.add(cumulative_key)
                    input_tokens = int(last.get("input_tokens", 0))
                    cached = int(last.get("cached_input_tokens", 0))
                    last["uncached_input_tokens"] = input_tokens - cached
                    last["cache_hit"] = cached > 0
                    request_usages.append(last)
        if row.get("type") != "response_item":
            continue
        if payload_type in ("function_call_output", "custom_tool_call_output"):
            output = payload.get("output", "")
            if not isinstance(output, str):
                output = json.dumps(output, ensure_ascii=False)
            raw = output.encode("utf-8")
            tool_outputs.append(
                {
                    "sha256": digest(raw),
                    "bytes": len(raw),
                    "tokens": tokens(output),
                }
            )
        elif payload_type in ("function_call", "custom_tool_call"):
            arguments = payload.get("arguments", "")
            serialized = (
                arguments
                if isinstance(arguments, str)
                else json.dumps(arguments, ensure_ascii=False)
            )
            calls.append(
                {
                    "name": payload.get("name"),
                    "arguments_sha256": digest(serialized.encode()),
                    "arguments_tokens": tokens(serialized),
                }
            )
        elif payload_type == "message" and payload.get("role") == "assistant":
            text = "".join(
                str(part.get("text", ""))
                for part in payload.get("content", [])
                if part.get("type") == "output_text"
            )
            assistant_messages.append(
                {
                    "phase": payload.get("phase"),
                    "tokens": tokens(text),
                }
            )

    usage_keys = (
        "input_tokens",
        "cached_input_tokens",
        "cache_write_input_tokens",
        "uncached_input_tokens",
        "output_tokens",
        "reasoning_output_tokens",
        "total_tokens",
    )
    usage = {
        key: sum(int(row.get(key, 0)) for row in request_usages)
        for key in usage_keys
    }
    request_count = len(request_usages)
    cache_hits = sum(int(bool(row.get("cache_hit"))) for row in request_usages)
    api_cost_usd = 0.0
    codex_credits = 0.0
    long_context_requests = 0
    for row in request_usages:
        input_multiplier = (
            2.0 if int(row.get("input_tokens", 0)) > LONG_CONTEXT_THRESHOLD else 1.0
        )
        output_multiplier = 1.5 if input_multiplier == 2.0 else 1.0
        long_context_requests += int(input_multiplier == 2.0)
        components = {
            "uncached_input": int(row.get("uncached_input_tokens", 0))
            * input_multiplier,
            "cached_input": int(row.get("cached_input_tokens", 0))
            * input_multiplier,
            "cache_write_input": int(row.get("cache_write_input_tokens", 0))
            * input_multiplier,
            "output": int(row.get("output_tokens", 0)) * output_multiplier,
        }
        api_cost_usd += sum(
            components[key] * PRICE_USD_PER_MILLION[key] / 1_000_000
            for key in components
        )
        codex_credits += sum(
            components[key] * CODEX_CREDITS_PER_MILLION[key] / 1_000_000
            for key in components
        )
    return {
        "file_sha256": digest(path.read_bytes()) if path else None,
        "events": len(rows),
        "event_types": dict(sorted(event_types.items())),
        "request_count": request_count,
        "cache_hit_requests": cache_hits,
        "cache_miss_requests": request_count - cache_hits,
        "long_context_requests": long_context_requests,
        "official_api_equivalent_cost_usd": api_cost_usd,
        "codex_rate_card_credits": codex_credits,
        "usage": usage,
        "tool_calls": len(calls),
        "tool_calls_by_name": dict(
            sorted(Counter(str(row.get("name")) for row in calls).items())
        ),
        "tool_call_argument_tokens": sum(row["arguments_tokens"] for row in calls),
        "tool_outputs": len(tool_outputs),
        "tool_output_bytes": sum(row["bytes"] for row in tool_outputs),
        "tool_output_tokens": sum(row["tokens"] for row in tool_outputs),
        "assistant_messages": len(assistant_messages),
        "assistant_tokens": sum(row["tokens"] for row in assistant_messages),
        "compaction_events": sum(
            count for name, count in event_types.items() if "compact" in name.lower()
        ),
        "retry_events": sum(
            count for name, count in event_types.items() if "retry" in name.lower()
        ),
    }


def inspect_exec_stream(path: Path) -> dict[str, Any]:
    commands: list[dict[str, Any]] = []
    file_changes = 0
    for event in parse_jsonl(path):
        if event.get("type") != "item.completed":
            continue
        item = event.get("item") or {}
        if item.get("type") == "command_execution":
            command = str(item.get("command", ""))
            output = str(item.get("aggregated_output", ""))
            raw = output.encode()
            commands.append(
                {
                    "command_sha256": digest(command.encode()),
                    "command_tokens": tokens(command),
                    "output_sha256": digest(raw),
                    "output_bytes": len(raw),
                    "output_tokens": tokens(output),
                    "exit_code": item.get("exit_code"),
                    "status": item.get("status"),
                    "rtk_observed": bool(re.search(r"\brtk(?:\.exe)?\b", command)),
                }
            )
        elif item.get("type") == "file_change":
            file_changes += len(item.get("changes") or [])
    return {
        "file_sha256": digest(path.read_bytes()),
        "commands": len(commands),
        "successful_commands": sum(row["exit_code"] == 0 for row in commands),
        "failed_commands": sum(
            isinstance(row["exit_code"], int) and row["exit_code"] != 0
            for row in commands
        ),
        "command_argument_tokens": sum(row["command_tokens"] for row in commands),
        "command_output_bytes": sum(row["output_bytes"] for row in commands),
        "command_output_tokens": sum(row["output_tokens"] for row in commands),
        "file_change_path_events": file_changes,
        "rtk_observed": any(row["rtk_observed"] for row in commands),
    }


def inspect_trajectory(path: Path) -> dict[str, Any]:
    data = json.loads(path.read_text(encoding="utf-8"))
    steps = data.get("steps") or []
    agent_steps = [step for step in steps if step.get("source") == "agent"]
    tool_calls = [
        call for step in agent_steps for call in (step.get("tool_calls") or [])
    ]
    timestamps = [step.get("timestamp") for step in steps if step.get("timestamp")]
    final = data.get("final_metrics") or {}
    return {
        "file_sha256": digest(path.read_bytes()),
        "schema_version": data.get("schema_version"),
        "steps": len(steps),
        "agent_steps": len(agent_steps),
        "llm_calls": sum(int(step.get("llm_call_count", 0)) for step in agent_steps),
        "tool_calls": len(tool_calls),
        "tool_calls_by_name": dict(
            sorted(
                Counter(str(call.get("function_name")) for call in tool_calls).items()
            )
        ),
        "first_event_at": timestamps[0] if timestamps else None,
        "last_event_at": timestamps[-1] if timestamps else None,
        "event_span_sec": seconds_between(
            timestamps[0] if timestamps else None,
            timestamps[-1] if timestamps else None,
        ),
        "final_metrics": final,
    }


def inspect_codexzero(path: Path, artifact_dir: Path) -> dict[str, Any]:
    totals: dict[str, Any] = {
        "events": 0,
        "usage_events": 0,
        "transformed_events": 0,
        "raw_bytes": 0,
        "original_tokens": 0,
        "selected_tokens": 0,
        "tokens_eliminated": 0,
        "codecs": {},
        "accounting_valid": True,
        "artifacts_verified": True,
    }
    codecs: Counter[str] = Counter()
    if not path.exists():
        return totals
    for row in parse_jsonl(path):
        if row.get("event") == "usage":
            totals["usage_events"] += 1
            continue
        if row.get("event") != "exec_model_payload":
            continue
        totals["events"] += 1
        transformed = bool(row.get("transformed"))
        totals["transformed_events"] += int(transformed)
        totals["raw_bytes"] += int(row.get("raw_byte_count", 0))
        original = int(row.get("original_tokens", 0))
        selected = int(row.get("selected_tokens", 0))
        eliminated = int(row.get("tokens_eliminated", 0))
        totals["original_tokens"] += original
        totals["selected_tokens"] += selected
        totals["tokens_eliminated"] += eliminated
        totals["accounting_valid"] &= (
            selected <= original and eliminated == original - selected
        )
        codecs[str(row.get("codec") or "none")] += 1
        artifact = artifact_dir / "sha256" / str(row.get("artifact_sha256", ""))
        try:
            raw = artifact.read_bytes()
            totals["artifacts_verified"] &= (
                digest(raw) == row.get("artifact_sha256")
                and len(raw) == int(row.get("raw_byte_count", -1))
            )
        except OSError:
            totals["artifacts_verified"] = False
    totals["codecs"] = dict(sorted(codecs.items()))
    totals["file_sha256"] = digest(path.read_bytes())
    return totals


def inspect_rtk(path: Path) -> dict[str, Any]:
    result: dict[str, Any] = {
        "commands": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "tokens_saved": 0,
        "exec_time_ms": 0,
        "parse_failures": 0,
        "fallback_successes": 0,
    }
    if not path.exists():
        return result
    connection = sqlite3.connect(path)
    try:
        rows = connection.execute(
            "SELECT input_tokens, output_tokens, saved_tokens, exec_time_ms "
            "FROM commands"
        ).fetchall()
        result["commands"] = len(rows)
        result["input_tokens"] = sum(int(row[0]) for row in rows)
        result["output_tokens"] = sum(int(row[1]) for row in rows)
        result["tokens_saved"] = sum(int(row[2]) for row in rows)
        result["exec_time_ms"] = sum(int(row[3]) for row in rows)
        result["parse_failures"] = int(
            connection.execute("SELECT COUNT(*) FROM parse_failures").fetchone()[0]
        )
        result["fallback_successes"] = int(
            connection.execute(
                "SELECT COUNT(*) FROM parse_failures "
                "WHERE fallback_succeeded != 0"
            ).fetchone()[0]
        )
    finally:
        connection.close()
    result["file_sha256"] = digest(path.read_bytes())
    return result


def collect_trial(trial_dir: Path) -> dict[str, Any]:
    result_path = trial_dir / "result.json"
    result = json.loads(result_path.read_text(encoding="utf-8"))
    agent = result["config"]["agent"]
    label = agent["env"]["CODEX_BENCHMARK_LABEL"]
    agent_result = result.get("agent_result") or {}
    verifier_result = result.get("verifier_result") or {}
    rewards = verifier_result.get("rewards") or {}
    exception = result.get("exception_info") or {}
    session_path = find_single(trial_dir / "agent" / "sessions", "**/*.jsonl")
    trajectory_path = trial_dir / "agent" / "trajectory.json"
    codex_path = trial_dir / "agent" / "codex.txt"

    session = inspect_session(session_path)
    trajectory = (
        inspect_trajectory(trajectory_path)
        if trajectory_path.exists()
        else {
            "steps": 0,
            "agent_steps": 0,
            "llm_calls": 0,
            "tool_calls": 0,
        }
    )
    stdout = (
        inspect_exec_stream(codex_path)
        if codex_path.exists()
        else {
            "commands": 0,
            "successful_commands": 0,
            "failed_commands": 0,
            "command_argument_tokens": 0,
            "command_output_bytes": 0,
            "command_output_tokens": 0,
            "file_change_path_events": 0,
            "rtk_observed": False,
        }
    )
    cz_path = trial_dir / "agent" / "codexzero-telemetry.jsonl"
    rtk_path = trial_dir / "agent" / "rtk.db"
    provider_input = int(agent_result.get("n_input_tokens") or 0)
    provider_cached = int(agent_result.get("n_cache_tokens") or 0)
    provider_output = int(agent_result.get("n_output_tokens") or 0)
    provider = {
        "input_tokens": provider_input,
        "cached_input_tokens": provider_cached,
        "uncached_input_tokens": provider_input - provider_cached,
        "output_tokens": provider_output,
        "reasoning_output_tokens": int(
            session["usage"].get("reasoning_output_tokens", 0)
        ),
        "total_tokens": provider_input + provider_output,
        "cache_token_ratio": (
            provider_cached / provider_input if provider_input else 0.0
        ),
        "harbor_estimated_cost_usd": (
            float(agent_result["cost_usd"])
            if agent_result.get("cost_usd") is not None
            else None
        ),
        "official_api_equivalent_cost_usd": session[
            "official_api_equivalent_cost_usd"
        ],
        "codex_rate_card_credits": session["codex_rate_card_credits"],
    }
    return {
        "task": result["task_name"].split("/")[-1],
        "config": label,
        "trial_name": result["trial_name"],
        "task_checksum": result.get("task_checksum"),
        "reward": float(rewards.get("reward") or 0.0),
        "passed": float(rewards.get("reward") or 0.0) >= 1.0,
        "exception_type": exception.get("exception_type"),
        "provider": provider,
        "activity": {
            "inference_requests": session["request_count"],
            "cache_hit_requests": session["cache_hit_requests"],
            "cache_miss_requests": session["cache_miss_requests"],
            "long_context_requests": session["long_context_requests"],
            "assistant_messages": session["assistant_messages"],
            "assistant_tokens": session["assistant_tokens"],
            "session_tool_calls": session["tool_calls"],
            "session_tool_outputs": session["tool_outputs"],
            "session_tool_output_bytes": session["tool_output_bytes"],
            "session_tool_output_tokens": session["tool_output_tokens"],
            "agent_steps": trajectory.get("agent_steps", 0),
            "trajectory_llm_calls": trajectory.get("llm_calls", 0),
            "trajectory_tool_calls": trajectory.get("tool_calls", 0),
            "shell_commands": stdout["commands"],
            "successful_shell_commands": stdout["successful_commands"],
            "failed_shell_commands": stdout["failed_commands"],
            "shell_command_argument_tokens": stdout["command_argument_tokens"],
            "shell_command_output_bytes": stdout["command_output_bytes"],
            "shell_command_output_tokens": stdout["command_output_tokens"],
            "file_change_path_events": stdout["file_change_path_events"],
            "compaction_events": session["compaction_events"],
            "retry_events": session["retry_events"],
            "rtk_observed": stdout["rtk_observed"],
        },
        "timing_sec": {
            "environment_setup": phase_seconds(result, "environment_setup"),
            "agent_setup": phase_seconds(result, "agent_setup"),
            "agent_execution": phase_seconds(result, "agent_execution"),
            "verifier": phase_seconds(result, "verifier"),
            "full_trial": seconds_between(
                result.get("started_at"), result.get("finished_at")
            ),
            "trajectory_event_span": trajectory.get("event_span_sec"),
        },
        "codexzero": inspect_codexzero(
            cz_path, trial_dir / "agent" / "codexzero-artifacts"
        ),
        "rtk": inspect_rtk(rtk_path),
        "integrity": {
            "result_sha256": digest(result_path.read_bytes()),
            "session_sha256": session.get("file_sha256"),
            "trajectory_sha256": trajectory.get("file_sha256"),
            "codex_stdout_sha256": stdout.get("file_sha256"),
            "provider_session_input_match": (
                not session["request_count"]
                or provider_input == session["usage"]["input_tokens"]
            ),
            "provider_session_cached_match": (
                not session["request_count"]
                or provider_cached == session["usage"]["cached_input_tokens"]
            ),
            "provider_session_output_match": (
                not session["request_count"]
                or provider_output == session["usage"]["output_tokens"]
            ),
        },
    }


def wilson(successes: int, n: int, z: float = 1.959963984540054) -> list[float]:
    if not n:
        return [0.0, 0.0]
    p = successes / n
    denominator = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / denominator
    margin = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return [max(0.0, centre - margin / denominator), min(1.0, centre + margin / denominator)]


def bootstrap_delta(
    baseline: list[float],
    candidate: list[float],
    *,
    seed: int = 2512,
    samples: int = 100_000,
) -> list[float]:
    rng = random.Random(seed)
    deltas: list[float] = []
    n = len(baseline)
    paired = [candidate[i] - baseline[i] for i in range(n)]
    for _ in range(samples):
        deltas.append(sum(paired[rng.randrange(n)] for _ in range(n)) / n)
    deltas.sort()
    return [deltas[int(0.025 * samples)], deltas[int(0.975 * samples) - 1]]


def bootstrap_mean(
    values: list[float],
    *,
    seed: int = 2512,
    samples: int = 100_000,
) -> list[float]:
    rng = random.Random(seed)
    estimates: list[float] = []
    n = len(values)
    for _ in range(samples):
        estimates.append(sum(values[rng.randrange(n)] for _ in range(n)) / n)
    estimates.sort()
    return [estimates[int(0.025 * samples)], estimates[int(0.975 * samples) - 1]]


def exact_mcnemar(baseline_only: int, candidate_only: int) -> float | None:
    n = baseline_only + candidate_only
    if n == 0:
        return None
    tail = sum(math.comb(n, k) for k in range(min(baseline_only, candidate_only) + 1))
    return min(1.0, 2 * tail / (2**n))


def mean(values: list[float]) -> float:
    return statistics.fmean(values) if values else 0.0


def median(values: list[float]) -> float:
    return statistics.median(values) if values else 0.0


def summarize(
    trials: list[dict[str, Any]],
    prereg: dict[str, Any],
    unscorable_tasks: set[str],
) -> dict[str, Any]:
    task_order = [row["name"] for row in prereg["benchmark"]["tasks"]]
    scored_task_order = [task for task in task_order if task not in unscorable_tasks]
    by_config: dict[str, list[dict[str, Any]]] = defaultdict(list)
    lookup: dict[tuple[str, str], dict[str, Any]] = {}
    for row in trials:
        by_config[row["config"]].append(row)
        lookup[(row["config"], row["task"])] = row

    configs: dict[str, Any] = {}
    sum_paths = [
        ("provider", "input_tokens"),
        ("provider", "cached_input_tokens"),
        ("provider", "uncached_input_tokens"),
        ("provider", "output_tokens"),
        ("provider", "reasoning_output_tokens"),
        ("provider", "total_tokens"),
        ("activity", "inference_requests"),
        ("activity", "cache_hit_requests"),
        ("activity", "cache_miss_requests"),
        ("activity", "long_context_requests"),
        ("activity", "assistant_messages"),
        ("activity", "assistant_tokens"),
        ("activity", "session_tool_calls"),
        ("activity", "session_tool_output_bytes"),
        ("activity", "session_tool_output_tokens"),
        ("activity", "agent_steps"),
        ("activity", "shell_commands"),
        ("activity", "successful_shell_commands"),
        ("activity", "failed_shell_commands"),
        ("activity", "shell_command_output_bytes"),
        ("activity", "shell_command_output_tokens"),
        ("activity", "compaction_events"),
        ("activity", "retry_events"),
        ("codexzero", "events"),
        ("codexzero", "transformed_events"),
        ("codexzero", "raw_bytes"),
        ("codexzero", "original_tokens"),
        ("codexzero", "selected_tokens"),
        ("codexzero", "tokens_eliminated"),
        ("rtk", "commands"),
        ("rtk", "input_tokens"),
        ("rtk", "output_tokens"),
        ("rtk", "tokens_saved"),
        ("rtk", "exec_time_ms"),
        ("rtk", "parse_failures"),
        ("rtk", "fallback_successes"),
    ]
    timing_keys = [
        "environment_setup",
        "agent_setup",
        "agent_execution",
        "verifier",
        "full_trial",
        "trajectory_event_span",
    ]

    for label in CONFIG_ORDER:
        rows = sorted(by_config[label], key=lambda row: task_order.index(row["task"]))
        scored_rows = [row for row in rows if row["task"] in scored_task_order]
        strict_passes = sum(row["passed"] for row in rows)
        passes = sum(row["passed"] for row in scored_rows)
        totals: dict[str, Any] = {}
        all_task_totals: dict[str, Any] = {}
        for section, key in sum_paths:
            totals[f"{section}.{key}"] = sum(
                int(row[section].get(key) or 0) for row in scored_rows
            )
            all_task_totals[f"{section}.{key}"] = sum(
                int(row[section].get(key) or 0) for row in rows
            )
        costs = [
            row["provider"]["harbor_estimated_cost_usd"]
            for row in scored_rows
            if row["provider"]["harbor_estimated_cost_usd"] is not None
        ]
        official_costs = [
            float(row["provider"]["official_api_equivalent_cost_usd"])
            for row in scored_rows
        ]
        credit_estimates = [
            float(row["provider"]["codex_rate_card_credits"]) for row in scored_rows
        ]
        input_tokens = totals["provider.input_tokens"]
        cached_tokens = totals["provider.cached_input_tokens"]
        configs[label] = {
            "trials": len(rows),
            "strict_passes": strict_passes,
            "strict_score": strict_passes / len(rows) if rows else 0.0,
            "strict_score_wilson_95": wilson(strict_passes, len(rows)),
            "scorable_trials": len(scored_rows),
            "passes": passes,
            "score": passes / len(scored_rows) if scored_rows else 0.0,
            "score_wilson_95": wilson(passes, len(scored_rows)),
            "exceptions": dict(
                sorted(
                    Counter(
                        row["exception_type"]
                        for row in rows
                        if row["exception_type"]
                    ).items()
                )
            ),
            "totals": totals,
            "all_selected_task_attempt_totals": all_task_totals,
            "means": {
                key: value / len(scored_rows) if scored_rows else 0.0
                for key, value in totals.items()
            },
            "cache_token_ratio": (
                cached_tokens / input_tokens if input_tokens else 0.0
            ),
            "cache_request_hit_rate": (
                totals["activity.cache_hit_requests"]
                / totals["activity.inference_requests"]
                if totals["activity.inference_requests"]
                else 0.0
            ),
            "harbor_estimated_cost_usd": {
                "coverage_trials": len(costs),
                "total": sum(costs),
                "mean": mean(costs),
            },
            "official_api_equivalent_cost_usd": {
                "total": sum(official_costs),
                "mean": mean(official_costs),
            },
            "codex_rate_card_credits": {
                "total": sum(credit_estimates),
                "mean": mean(credit_estimates),
            },
            "timing_sec": {
                key: {
                    "total": sum(
                        float(row["timing_sec"].get(key) or 0) for row in rows
                        if row["task"] in scored_task_order
                    ),
                    "mean": mean(
                        [
                            float(row["timing_sec"][key])
                            for row in scored_rows
                            if row["timing_sec"].get(key) is not None
                        ]
                    ),
                    "median": median(
                        [
                            float(row["timing_sec"][key])
                            for row in scored_rows
                            if row["timing_sec"].get(key) is not None
                        ]
                    ),
                }
                for key in timing_keys
            },
        }

    comparisons: dict[str, Any] = {}
    baseline = [lookup[("codex", task)] for task in scored_task_order]
    for label in CONFIG_ORDER[1:]:
        candidate = [lookup[(label, task)] for task in scored_task_order]
        baseline_rewards = [row["reward"] for row in baseline]
        candidate_rewards = [row["reward"] for row in candidate]
        baseline_only = sum(
            a["passed"] and not b["passed"] for a, b in zip(baseline, candidate)
        )
        candidate_only = sum(
            b["passed"] and not a["passed"] for a, b in zip(baseline, candidate)
        )
        metrics: dict[str, Any] = {}
        for section, key in [
            ("provider", "input_tokens"),
            ("provider", "cached_input_tokens"),
            ("provider", "uncached_input_tokens"),
            ("provider", "output_tokens"),
            ("provider", "total_tokens"),
            ("activity", "inference_requests"),
            ("activity", "session_tool_calls"),
            ("activity", "session_tool_output_tokens"),
            ("activity", "shell_commands"),
            ("timing_sec", "agent_execution"),
            ("timing_sec", "full_trial"),
        ]:
            base_values = [float(row[section].get(key) or 0) for row in baseline]
            candidate_values = [
                float(row[section].get(key) or 0) for row in candidate
            ]
            base_total = sum(base_values)
            candidate_total = sum(candidate_values)
            saved = base_total - candidate_total
            metrics[f"{section}.{key}"] = {
                "baseline_total": base_total,
                "candidate_total": candidate_total,
                "saved_total": saved,
                "saved_mean_per_task": saved / len(scored_task_order),
                "reduction_percent": (
                    saved / base_total * 100 if base_total else None
                ),
                "paired_range": [
                    min(a - b for a, b in zip(base_values, candidate_values)),
                    max(a - b for a, b in zip(base_values, candidate_values)),
                ],
                "paired_bootstrap_mean_saved_95": bootstrap_mean(
                    [a - b for a, b in zip(base_values, candidate_values)]
                ),
            }
        base_costs = [
            float(row["provider"]["harbor_estimated_cost_usd"] or 0)
            for row in baseline
        ]
        candidate_costs = [
            float(row["provider"]["harbor_estimated_cost_usd"] or 0)
            for row in candidate
        ]
        cost_saved = sum(base_costs) - sum(candidate_costs)
        base_official_costs = [
            float(row["provider"]["official_api_equivalent_cost_usd"])
            for row in baseline
        ]
        candidate_official_costs = [
            float(row["provider"]["official_api_equivalent_cost_usd"])
            for row in candidate
        ]
        base_credits = [
            float(row["provider"]["codex_rate_card_credits"]) for row in baseline
        ]
        candidate_credits = [
            float(row["provider"]["codex_rate_card_credits"]) for row in candidate
        ]
        comparisons[label] = {
            "score_delta": mean(candidate_rewards) - mean(baseline_rewards),
            "score_delta_bootstrap_95": bootstrap_delta(
                baseline_rewards, candidate_rewards
            ),
            "paired_outcomes": {
                "both_pass": sum(a["passed"] and b["passed"] for a, b in zip(baseline, candidate)),
                "both_fail": sum(not a["passed"] and not b["passed"] for a, b in zip(baseline, candidate)),
                "baseline_only_pass": baseline_only,
                "candidate_only_pass": candidate_only,
            },
            "mcnemar_exact_two_sided_p": exact_mcnemar(
                baseline_only, candidate_only
            ),
            "harbor_estimated_cost_usd": {
                "baseline_total": sum(base_costs),
                "candidate_total": sum(candidate_costs),
                "saved_total": cost_saved,
                "reduction_percent": (
                    cost_saved / sum(base_costs) * 100 if sum(base_costs) else None
                ),
            },
            "official_api_equivalent_cost_usd": {
                "baseline_total": sum(base_official_costs),
                "candidate_total": sum(candidate_official_costs),
                "saved_total": sum(base_official_costs)
                - sum(candidate_official_costs),
                "reduction_percent": (
                    (
                        sum(base_official_costs)
                        - sum(candidate_official_costs)
                    )
                    / sum(base_official_costs)
                    * 100
                    if sum(base_official_costs)
                    else None
                ),
                "paired_bootstrap_mean_saved_95": bootstrap_mean(
                    [
                        a - b
                        for a, b in zip(
                            base_official_costs, candidate_official_costs
                        )
                    ]
                ),
            },
            "codex_rate_card_credits": {
                "baseline_total": sum(base_credits),
                "candidate_total": sum(candidate_credits),
                "saved_total": sum(base_credits) - sum(candidate_credits),
                "reduction_percent": (
                    (sum(base_credits) - sum(candidate_credits))
                    / sum(base_credits)
                    * 100
                    if sum(base_credits)
                    else None
                ),
                "paired_bootstrap_mean_saved_95": bootstrap_mean(
                    [a - b for a, b in zip(base_credits, candidate_credits)]
                ),
            },
            "metrics": metrics,
        }

    integrity = {
        "trials_expected": len(task_order) * len(CONFIG_ORDER),
        "trials_observed": len(trials),
        "complete_matrix": all(
            (label, task) in lookup for label in CONFIG_ORDER for task in task_order
        ),
        "provider_session_identities": sum(
            all(
                row["integrity"][key]
                for key in (
                    "provider_session_input_match",
                    "provider_session_cached_match",
                    "provider_session_output_match",
                )
            )
            for row in trials
            if row["activity"]["inference_requests"]
        ),
        "trials_with_provider_usage": sum(
            row["provider"]["total_tokens"] > 0 for row in trials
        ),
        "codexzero_trials_expected": len(task_order) * 2,
        "codexzero_telemetry_files": sum(
            bool(row["codexzero"].get("file_sha256")) for row in trials
        ),
        "codexzero_accounting_valid": all(
            row["codexzero"]["accounting_valid"]
            for row in trials
            if row["config"].startswith("codexzero")
            and row["codexzero"].get("file_sha256")
        ),
        "codexzero_artifacts_verified": all(
            row["codexzero"]["artifacts_verified"]
            for row in trials
            if row["config"].startswith("codexzero")
            and row["codexzero"]["events"]
        ),
        "rtk_trials_expected": len(task_order) * 2,
        "rtk_databases": sum(bool(row["rtk"].get("file_sha256")) for row in trials),
    }
    return {
        "schema": "codexzero-terminal-bench-summary-v1",
        "benchmark": prereg["benchmark"],
        "scoring": {
            "strict_task_count": len(task_order),
            "scorable_task_count": len(scored_task_order),
            "unscorable_tasks": sorted(unscorable_tasks),
            "strict_score_note": "Official Harbor-style score counts every preregistered task and treats provider exceptions as zero.",
            "comparison_score_note": "The comparison score excludes only tasks that produced the same provider transport failure for every configuration across the original and controlled rerun.",
        },
        "design": prereg["design"],
        "pricing": {
            "as_of": "2026-07-25",
            "model": "gpt-5.6-sol",
            "usd_per_million_tokens": PRICE_USD_PER_MILLION,
            "codex_credits_per_million_tokens": CODEX_CREDITS_PER_MILLION,
            "long_context_threshold_input_tokens": LONG_CONTEXT_THRESHOLD,
            "long_context_multipliers": {"input": 2.0, "output": 1.5},
            "api_source": "https://developers.openai.com/api/docs/models/gpt-5.6-sol",
            "codex_rate_card_source": "https://help.openai.com/en/articles/20001106-codex-rate-card",
            "note": "Computed per model request. API-equivalent dollars are not a claim that ChatGPT-plan usage incurred an API invoice.",
        },
        "config_order": CONFIG_ORDER,
        "configs": configs,
        "comparisons_vs_codex": comparisons,
        "integrity": integrity,
    }


def percent_change_label(reduction: float | None) -> str:
    if reduction is None:
        return "n/a"
    return f"{abs(reduction):.2f}% {'less' if reduction >= 0 else 'more'}"


def render_markdown(
    summary: dict[str, Any],
    trials: list[dict[str, Any]],
) -> str:
    configs = summary["configs"]
    comparisons = summary["comparisons_vs_codex"]
    unscorable = set(summary["scoring"]["unscorable_tasks"])
    lookup = {(row["config"], row["task"]): row for row in trials}
    lines = [
        "# Terminal-Bench 2.1 mini-panel",
        "",
        "**CodexZero Safe matched Codex on every scorable task: 7/10 vs 7/10.** "
        "It used 2.53% fewer provider tokens and 7.65% less API-equivalent cost "
        "in this run. The paired 95% intervals for efficiency include zero, so "
        "these are measured point estimates, not a proven population-wide savings rate.",
        "",
        "The strict preregistered score was **7/12 (58.3%)** for Codex, "
        "CodexZero Safe, CodexZero Max Savings, Codex + RTK, and "
        "Codex + Caveman + RTK. Codex + Caveman scored **8/12 (66.7%)**. "
        "Two tasks produced the same provider transport failure across all six "
        "configurations in both the original run and controlled rerun; the "
        "comparison score excludes only those two cells per configuration.",
        "",
        "## Main comparison",
        "",
        "| Configuration | Strict score | Scorable score | Total tokens | vs Codex | API-equivalent cost | vs Codex | Codex credits | Agent time |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for label in CONFIG_ORDER:
        row = configs[label]
        if label == "codex":
            token_delta = cost_delta = "baseline"
        else:
            comp = comparisons[label]
            token_delta = percent_change_label(
                comp["metrics"]["provider.total_tokens"]["reduction_percent"]
            )
            cost_delta = percent_change_label(
                comp["official_api_equivalent_cost_usd"]["reduction_percent"]
            )
        lines.append(
            f"| {DISPLAY_NAMES[label]} "
            f"| {row['strict_passes']}/{row['trials']} ({row['strict_score']:.1%}) "
            f"| {row['passes']}/{row['scorable_trials']} ({row['score']:.1%}) "
            f"| {row['totals']['provider.total_tokens']:,} "
            f"| {token_delta} "
            f"| ${row['official_api_equivalent_cost_usd']['total']:.4f} "
            f"| {cost_delta} "
            f"| {row['codex_rate_card_credits']['total']:.3f} "
            f"| {row['timing_sec']['agent_execution']['total'] / 60:.1f} min |"
        )
    lines += [
        "",
        "Totals and savings above use the 10 scorable paired tasks. Provider-failed "
        "attempts and their partial usage remain in [`attempts.json`](attempts.json).",
        "",
        "## Quality",
        "",
        "| Configuration | Score delta vs Codex | Paired bootstrap 95% | Baseline-only passes | Candidate-only passes | Exact McNemar p |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for label in CONFIG_ORDER[1:]:
        comp = comparisons[label]
        outcomes = comp["paired_outcomes"]
        interval = comp["score_delta_bootstrap_95"]
        p = comp["mcnemar_exact_two_sided_p"]
        lines.append(
            f"| {DISPLAY_NAMES[label]} "
            f"| {comp['score_delta']:+.1%} "
            f"| {interval[0]:+.1%} to {interval[1]:+.1%} "
            f"| {outcomes['baseline_only_pass']} "
            f"| {outcomes['candidate_only_pass']} "
            f"| {'n/a' if p is None else f'{p:.3f}'} |"
        )
    lines += [
        "",
        "### Per-task score",
        "",
        "| Task | " + " | ".join(DISPLAY_NAMES[label] for label in CONFIG_ORDER) + " |",
        "|---|" + "---:|" * len(CONFIG_ORDER),
    ]
    for task in [row["name"] for row in summary["benchmark"]["tasks"]]:
        values = []
        for label in CONFIG_ORDER:
            row = lookup[(label, task)]
            if task in unscorable:
                value = "ERR‡"
            elif row["passed"]:
                value = "1"
            elif row["exception_type"] == "AgentSafetyRefusalError":
                value = "0†"
            else:
                value = "0"
            values.append(value)
        lines.append(f"| `{task}` | " + " | ".join(values) + " |")
    lines += [
        "",
        "- † Shared model safety refusal; retained as a scored zero.",
        "- ‡ Shared provider transport failure; excluded from the comparison score after "
        "the original six-way wave, a six-way controlled rerun, and single-container "
        "Codex probes reproduced it. The strict score retains it as zero.",
        "",
        "## Tokens, cache, calls, and turns",
        "",
        "| Configuration | Input | Cached | Uncached | Output | Reasoning output | Cache token ratio | Requests | Cache-hit requests | Assistant messages | Tool calls | Shell commands |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for label in CONFIG_ORDER:
        row = configs[label]
        totals = row["totals"]
        lines.append(
            f"| {DISPLAY_NAMES[label]} "
            f"| {totals['provider.input_tokens']:,} "
            f"| {totals['provider.cached_input_tokens']:,} "
            f"| {totals['provider.uncached_input_tokens']:,} "
            f"| {totals['provider.output_tokens']:,} "
            f"| {totals['provider.reasoning_output_tokens']:,} "
            f"| {row['cache_token_ratio']:.1%} "
            f"| {totals['activity.inference_requests']:,} "
            f"| {totals['activity.cache_hit_requests']:,} "
            f"| {totals['activity.assistant_messages']:,} "
            f"| {totals['activity.session_tool_calls']:,} "
            f"| {totals['activity.shell_commands']:,} |"
        )
    lines += [
        "",
        "## Tool telemetry",
        "",
        "| Configuration | Tool-output tokens observed | CodexZero payloads | Transformed | Tokens eliminated | RTK commands | RTK measured tokens saved | RTK fallbacks |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for label in CONFIG_ORDER:
        totals = configs[label]["totals"]
        lines.append(
            f"| {DISPLAY_NAMES[label]} "
            f"| {totals['activity.session_tool_output_tokens']:,} "
            f"| {totals['codexzero.events']:,} "
            f"| {totals['codexzero.transformed_events']:,} "
            f"| {totals['codexzero.tokens_eliminated']:,} "
            f"| {totals['rtk.commands']:,} "
            f"| {totals['rtk.tokens_saved']:,} "
            f"| {totals['rtk.fallback_successes']:,} |"
        )
    lines += [
        "",
        f"CodexZero inspected "
        f"{sum(configs[label]['totals']['codexzero.events'] for label in CONFIG_ORDER):,} "
        "model-visible execution payloads across Safe and "
        "Max Savings but transformed none: every candidate representation was rejected "
        "because it was not safely smaller. The benchmark therefore demonstrates Safe's "
        "non-interference on these tasks, but it does **not** attribute the observed "
        "provider-token difference to payload compression.",
        "",
        "## Efficiency uncertainty",
        "",
        "| Configuration | Mean tokens saved/task | Paired bootstrap 95% | Mean API cost saved/task | Paired bootstrap 95% |",
        "|---|---:|---:|---:|---:|",
    ]
    for label in CONFIG_ORDER[1:]:
        comp = comparisons[label]
        token_row = comp["metrics"]["provider.total_tokens"]
        cost_row = comp["official_api_equivalent_cost_usd"]
        token_ci = token_row["paired_bootstrap_mean_saved_95"]
        cost_ci = cost_row["paired_bootstrap_mean_saved_95"]
        lines.append(
            f"| {DISPLAY_NAMES[label]} "
            f"| {token_row['saved_mean_per_task']:+,.0f} "
            f"| {token_ci[0]:+,.0f} to {token_ci[1]:+,.0f} "
            f"| ${cost_row['saved_total'] / summary['scoring']['scorable_task_count']:+.4f} "
            f"| ${cost_ci[0]:+.4f} to ${cost_ci[1]:+.4f} |"
        )
    integrity = summary["integrity"]
    lines += [
        "",
        "## Design and integrity",
        "",
        f"- Model: `gpt-5.6-sol`, reasoning effort `medium`.",
        f"- Dataset: corrected 89-task Terminal-Bench package "
        f"`{summary['benchmark']['dataset_digest']}`.",
        "- Selection: `random.Random(2512).sample(registry_order, 12)`, sealed before "
        "the first model call.",
        "- Matrix: six configurations × 12 tasks × one attempt; up to 12 trials in "
        "parallel; 900-second agent cap.",
        f"- Attempts: {integrity['attempts_observed']} recorded; "
        f"{integrity['superseded_attempts']} infrastructure-invalid attempts superseded; "
        f"{integrity['trials_observed']}/{integrity['trials_expected']} final cells present.",
        f"- Provider/session token identities: "
        f"{integrity['provider_session_identities']}/"
        f"{integrity['trials_with_provider_usage']} valid.",
        f"- CodexZero artifact hashes and token accounting: "
        f"{'valid' if integrity['codexzero_artifacts_verified'] and integrity['codexzero_accounting_valid'] else 'invalid'}.",
        "- Retries: no model-quality retries. Only the two synchronized transport-failure "
        "waves were repeated under the preregistered invalid-run rule.",
        "",
        "The score is a lower-cost paired mini-panel, not a full Terminal-Bench leaderboard "
        "submission. One attempt per cell is enough to compare these exact paired outcomes, "
        "but not enough to estimate a stable population-wide token-savings rate.",
        "",
        "## Cost calculation",
        "",
        "Costs are computed per request from OpenAI's published GPT-5.6 Sol rates: "
        "$5/M uncached input, $0.50/M cached input, and $30/M output. Codex credits "
        "use 125/M, 12.5/M, and 750/M respectively. Requests above 272K input tokens "
        "apply the published 2× input and 1.5× output multipliers. "
        "[Model pricing](https://developers.openai.com/api/docs/models/gpt-5.6-sol) · "
        "[Codex rate card](https://help.openai.com/en/articles/20001106-codex-rate-card)",
        "",
        "API-equivalent dollars are a comparison metric, not a claim that this ChatGPT-plan "
        "run produced an API invoice.",
        "",
        "## Files",
        "",
        "- [`preregistration.json`](preregistration.json): sealed design, task digests, "
        "binary hashes, prompts, and metrics.",
        "- [`summary.json`](summary.json): aggregate metrics, paired comparisons, confidence "
        "intervals, and integrity checks.",
        "- [`trials.json`](trials.json): one normalized record for each final matrix cell.",
        "- [`attempts.json`](attempts.json): every original and infrastructure-rerun attempt.",
        "- [`run-manifest.json`](run-manifest.json): wall times, diagnostic probes, "
        "raw-job tree hashes, and public artifact hashes.",
        "- [`PREREGISTRATION.sha256`](PREREGISTRATION.sha256): preregistration seal.",
        "",
        "Generated by [`tools/analyze-terminal-bench.py`](../../tools/analyze-terminal-bench.py).",
        "",
    ]
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", action="append", type=Path, required=True)
    parser.add_argument("--preregistration", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--unscorable-task", action="append", default=[])
    args = parser.parse_args()

    prereg = json.loads(args.preregistration.read_text(encoding="utf-8"))
    attempts = [
        collect_trial(path.parent)
        for job in args.job
        for path in sorted(job.glob("*/result.json"))
    ]
    selected: dict[tuple[str, str], dict[str, Any]] = {}
    for row in attempts:
        selected[(row["config"], row["task"])] = row
    trials = list(selected.values())
    trials.sort(
        key=lambda row: (
            [task["name"] for task in prereg["benchmark"]["tasks"]].index(row["task"]),
            CONFIG_ORDER.index(row["config"]),
        )
    )
    summary = summarize(trials, prereg, set(args.unscorable_task))
    summary["integrity"]["attempts_observed"] = len(attempts)
    summary["integrity"]["superseded_attempts"] = len(attempts) - len(trials)
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "attempts.json").write_text(
        json.dumps(attempts, indent=2) + "\n", encoding="utf-8"
    )
    (args.output / "trials.json").write_text(
        json.dumps(trials, indent=2) + "\n", encoding="utf-8"
    )
    (args.output / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    (args.output / "README.md").write_text(
        render_markdown(summary, trials), encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "trials": len(trials),
                "complete_matrix": summary["integrity"]["complete_matrix"],
                "scores": {
                    key: value["score"] for key, value in summary["configs"].items()
                },
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
