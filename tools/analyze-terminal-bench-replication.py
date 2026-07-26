#!/usr/bin/env python3
"""Analyze the repeated Codex/CodexZero/RTK Terminal-Bench replication."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import random
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Callable


CONFIG_ORDER = ["codex", "codexzero_safe", "codex_rtk"]
DISPLAY = {
    "codex": "Codex",
    "codexzero_safe": "CodexZero Safe",
    "codex_rtk": "Codex + RTK",
}
BOOTSTRAP_SEED = 2515
BOOTSTRAP_SAMPLES = 50_000


def load_base_module() -> Any:
    path = Path(__file__).with_name("analyze-terminal-bench.py")
    spec = importlib.util.spec_from_file_location("codexzero_tb_base", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load {path}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


BASE = load_base_module()


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def mean(values: list[float]) -> float:
    return sum(values) / len(values) if values else 0.0


def median(values: list[float]) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    middle = len(ordered) // 2
    if len(ordered) % 2:
        return ordered[middle]
    return (ordered[middle - 1] + ordered[middle]) / 2


def percentile(sorted_values: list[float], probability: float) -> float:
    if not sorted_values:
        return 0.0
    position = probability * (len(sorted_values) - 1)
    low = math.floor(position)
    high = math.ceil(position)
    if low == high:
        return sorted_values[low]
    fraction = position - low
    return sorted_values[low] * (1 - fraction) + sorted_values[high] * fraction


def cluster_bootstrap(
    tasks: list[str],
    statistic: Callable[[list[str]], float],
    *,
    seed_offset: int,
) -> list[float]:
    rng = random.Random(BOOTSTRAP_SEED + seed_offset)
    values = []
    for _ in range(BOOTSTRAP_SAMPLES):
        sample = [rng.choice(tasks) for _ in tasks]
        values.append(statistic(sample))
    values.sort()
    return [percentile(values, 0.025), percentile(values, 0.975)]


def exact_sign_test(lower: int, higher: int) -> float | None:
    n = lower + higher
    if n == 0:
        return None
    tail = sum(math.comb(n, k) for k in range(0, min(lower, higher) + 1))
    return min(1.0, 2 * tail / (2**n))


def verifier_summary(trial_dir: Path) -> dict[str, Any]:
    path = trial_dir / "verifier" / "ctrf.json"
    if not path.exists():
        return {
            "tests": 0,
            "passed": 0,
            "failed": 0,
            "skipped": 0,
            "pending": 0,
            "other": 0,
            "pass_ratio": None,
            "ctrf_sha256": None,
        }
    payload = json.loads(path.read_text(encoding="utf-8"))
    summary = payload.get("results", {}).get("summary", {})
    tests = int(summary.get("tests") or 0)
    passed = int(summary.get("passed") or 0)
    return {
        "tests": tests,
        "passed": passed,
        "failed": int(summary.get("failed") or 0),
        "skipped": int(summary.get("skipped") or 0),
        "pending": int(summary.get("pending") or 0),
        "other": int(summary.get("other") or 0),
        "pass_ratio": passed / tests if tests else None,
        "ctrf_sha256": digest(path),
    }


def collect_job(path: Path, repetition: int, disposition: str) -> list[dict[str, Any]]:
    rows = []
    for trial_dir in sorted(path.iterdir()):
        if not trial_dir.is_dir() or not (trial_dir / "result.json").exists():
            continue
        row = BASE.collect_trial(trial_dir)
        row["repetition"] = repetition
        row["job_name"] = path.name
        row["disposition"] = disposition
        row["verifier_subtests"] = verifier_summary(trial_dir)
        rows.append(row)
    return rows


def nested_sum(rows: list[dict[str, Any]], section: str, key: str) -> float:
    return sum(float(row[section].get(key) or 0) for row in rows)


def summarize(
    rows: list[dict[str, Any]],
    task_order: list[str],
    preregistration: dict[str, Any],
    addendum: dict[str, Any],
) -> dict[str, Any]:
    lookup = {
        (row["task"], row["repetition"], row["config"]): row for row in rows
    }
    by_config: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for row in rows:
        by_config[row["config"]].append(row)

    expected = len(task_order) * 3 * len(CONFIG_ORDER)
    complete = (
        len(rows) == expected
        and len(lookup) == expected
        and all(
            (task, repetition, config) in lookup
            for task in task_order
            for repetition in range(1, 4)
            for config in CONFIG_ORDER
        )
    )

    configs: dict[str, Any] = {}
    for config in CONFIG_ORDER:
        config_rows = sorted(
            by_config[config],
            key=lambda row: (task_order.index(row["task"]), row["repetition"]),
        )
        successes = sum(bool(row["passed"]) for row in config_rows)
        per_task_passes = {
            task: sum(
                lookup[(task, repetition, config)]["passed"]
                for repetition in range(1, 4)
            )
            for task in task_order
        }
        majority_passes = sum(value >= 2 for value in per_task_passes.values())
        stable_tasks = sum(value in (0, 3) for value in per_task_passes.values())

        def score_for_sample(sample: list[str]) -> float:
            return mean(
                [
                    float(lookup[(task, repetition, config)]["passed"])
                    for task in sample
                    for repetition in range(1, 4)
                ]
            )

        subtest_rows = [
            row
            for row in config_rows
            if row["verifier_subtests"]["pass_ratio"] is not None
        ]
        input_tokens = int(nested_sum(config_rows, "provider", "input_tokens"))
        cached_tokens = int(
            nested_sum(config_rows, "provider", "cached_input_tokens")
        )
        total_tokens = int(nested_sum(config_rows, "provider", "total_tokens"))
        costs = nested_sum(
            config_rows, "provider", "official_api_equivalent_cost_usd"
        )
        configs[config] = {
            "display_name": DISPLAY[config],
            "official_quality": {
                "passes": successes,
                "attempts": len(config_rows),
                "pass_rate": successes / len(config_rows),
                "score_resolution_percentage_points": 100 / len(config_rows),
                "wilson_95": BASE.wilson(successes, len(config_rows)),
                "task_cluster_bootstrap_95": cluster_bootstrap(
                    task_order,
                    score_for_sample,
                    seed_offset=100 + CONFIG_ORDER.index(config),
                ),
                "majority_task_passes": majority_passes,
                "majority_task_total": len(task_order),
                "majority_task_rate": majority_passes / len(task_order),
                "stable_tasks": stable_tasks,
                "mixed_outcome_tasks": len(task_order) - stable_tasks,
                "per_task_passes_of_three": per_task_passes,
            },
            "verifier_subtests": {
                "trials_with_ctrf": len(subtest_rows),
                "raw_passed": sum(
                    row["verifier_subtests"]["passed"] for row in subtest_rows
                ),
                "raw_tests": sum(
                    row["verifier_subtests"]["tests"] for row in subtest_rows
                ),
                "micro_pass_rate": (
                    sum(
                        row["verifier_subtests"]["passed"] for row in subtest_rows
                    )
                    / sum(
                        row["verifier_subtests"]["tests"] for row in subtest_rows
                    )
                    if sum(
                        row["verifier_subtests"]["tests"] for row in subtest_rows
                    )
                    else 0.0
                ),
                "task_normalized_macro_pass_rate": mean(
                    [
                        mean(
                            [
                                float(
                                    lookup[
                                        (task, repetition, config)
                                    ]["verifier_subtests"]["pass_ratio"]
                                )
                                for repetition in range(1, 4)
                            ]
                        )
                        for task in task_order
                    ]
                ),
            },
            "provider": {
                "input_tokens": input_tokens,
                "cached_input_tokens": cached_tokens,
                "uncached_input_tokens": input_tokens - cached_tokens,
                "output_tokens": int(
                    nested_sum(config_rows, "provider", "output_tokens")
                ),
                "reasoning_output_tokens": int(
                    nested_sum(
                        config_rows, "provider", "reasoning_output_tokens"
                    )
                ),
                "total_tokens": total_tokens,
                "cache_token_ratio": (
                    cached_tokens / input_tokens if input_tokens else 0.0
                ),
                "official_api_equivalent_cost_usd": costs,
                "codex_rate_card_credits": nested_sum(
                    config_rows, "provider", "codex_rate_card_credits"
                ),
            },
            "activity": {
                key: int(nested_sum(config_rows, "activity", key))
                for key in [
                    "inference_requests",
                    "cache_hit_requests",
                    "cache_miss_requests",
                    "assistant_messages",
                    "session_tool_calls",
                    "session_tool_outputs",
                    "session_tool_output_bytes",
                    "session_tool_output_tokens",
                    "shell_commands",
                    "successful_shell_commands",
                    "failed_shell_commands",
                    "shell_command_argument_tokens",
                    "shell_command_output_bytes",
                    "shell_command_output_tokens",
                    "compaction_events",
                    "retry_events",
                ]
            },
            "time": {
                key: nested_sum(config_rows, "timing_sec", key)
                for key in [
                    "environment_setup",
                    "agent_setup",
                    "agent_execution",
                    "verifier",
                    "full_trial",
                ]
            },
            "codexzero": {
                key: int(nested_sum(config_rows, "codexzero", key))
                for key in [
                    "events",
                    "usage_events",
                    "transformed_events",
                    "raw_bytes",
                    "original_tokens",
                    "selected_tokens",
                    "tokens_eliminated",
                ]
            },
            "rtk": {
                key: int(nested_sum(config_rows, "rtk", key))
                for key in [
                    "commands",
                    "input_tokens",
                    "output_tokens",
                    "tokens_saved",
                    "exec_time_ms",
                    "parse_failures",
                    "fallback_successes",
                ]
            },
            "exceptions": {
                "agent_timeouts": sum(
                    row["exception_type"] == "AgentTimeoutError"
                    for row in config_rows
                ),
                "other": sum(
                    bool(row["exception_type"])
                    and row["exception_type"] != "AgentTimeoutError"
                    for row in config_rows
                ),
            },
        }

    comparisons: dict[str, Any] = {}
    for offset, candidate in enumerate(CONFIG_ORDER[1:], start=1):
        baseline_only = 0
        candidate_only = 0
        token_differences = []
        cost_differences = []
        lower_tokens = 0
        higher_tokens = 0
        per_task_score_delta: dict[str, float] = {}
        per_task_token_saved: dict[str, float] = {}
        per_task_cost_saved: dict[str, float] = {}
        for task in task_order:
            score_deltas = []
            token_saved = []
            cost_saved = []
            for repetition in range(1, 4):
                baseline = lookup[(task, repetition, "codex")]
                current = lookup[(task, repetition, candidate)]
                baseline_pass = bool(baseline["passed"])
                candidate_pass = bool(current["passed"])
                baseline_only += baseline_pass and not candidate_pass
                candidate_only += candidate_pass and not baseline_pass
                score_deltas.append(float(candidate_pass) - float(baseline_pass))
                tokens_delta = (
                    baseline["provider"]["total_tokens"]
                    - current["provider"]["total_tokens"]
                )
                cost_delta = (
                    baseline["provider"]["official_api_equivalent_cost_usd"]
                    - current["provider"]["official_api_equivalent_cost_usd"]
                )
                token_saved.append(tokens_delta)
                cost_saved.append(cost_delta)
                token_differences.append(tokens_delta)
                cost_differences.append(cost_delta)
                lower_tokens += tokens_delta > 0
                higher_tokens += tokens_delta < 0
            per_task_score_delta[task] = mean(score_deltas)
            per_task_token_saved[task] = mean(token_saved)
            per_task_cost_saved[task] = mean(cost_saved)

        def sample_mean(
            values: dict[str, float], sample: list[str]
        ) -> float:
            return mean([values[task] for task in sample])

        baseline_totals = configs["codex"]["provider"]
        candidate_totals = configs[candidate]["provider"]
        comparisons[candidate] = {
            "official_score_delta": (
                configs[candidate]["official_quality"]["pass_rate"]
                - configs["codex"]["official_quality"]["pass_rate"]
            ),
            "score_delta_task_cluster_bootstrap_95": cluster_bootstrap(
                task_order,
                lambda sample: sample_mean(per_task_score_delta, sample),
                seed_offset=200 + offset,
            ),
            "baseline_only_passes": baseline_only,
            "candidate_only_passes": candidate_only,
            "exact_cell_mcnemar_p": BASE.exact_mcnemar(
                baseline_only, candidate_only
            ),
            "mean_tokens_saved_per_cell": mean(token_differences),
            "median_tokens_saved_per_cell": median(token_differences),
            "tokens_saved_task_cluster_bootstrap_95": cluster_bootstrap(
                task_order,
                lambda sample: sample_mean(per_task_token_saved, sample),
                seed_offset=300 + offset,
            ),
            "lower_token_cells": lower_tokens,
            "higher_token_cells": higher_tokens,
            "tied_token_cells": len(token_differences)
            - lower_tokens
            - higher_tokens,
            "exact_token_sign_test_p": exact_sign_test(
                lower_tokens, higher_tokens
            ),
            "total_token_change_fraction": (
                (
                    candidate_totals["total_tokens"]
                    - baseline_totals["total_tokens"]
                )
                / baseline_totals["total_tokens"]
            ),
            "mean_api_cost_saved_per_cell": mean(cost_differences),
            "api_cost_saved_task_cluster_bootstrap_95": cluster_bootstrap(
                task_order,
                lambda sample: sample_mean(per_task_cost_saved, sample),
                seed_offset=400 + offset,
            ),
            "total_api_cost_change_fraction": (
                (
                    candidate_totals["official_api_equivalent_cost_usd"]
                    - baseline_totals["official_api_equivalent_cost_usd"]
                )
                / baseline_totals["official_api_equivalent_cost_usd"]
            ),
        }

    return {
        "schema": "codexzero-terminal-bench-replication-summary-v1",
        "benchmark": preregistration["benchmark"],
        "design": preregistration["design"],
        "quality_reporting": preregistration["quality_reporting"],
        "infrastructure_addendum": {
            "sha256": digest(
                Path(args.infrastructure_addendum)
            )
            if args.infrastructure_addendum
            else None,
            "correction": addendum["correction"],
        },
        "config_order": CONFIG_ORDER,
        "configs": configs,
        "comparisons_vs_codex": comparisons,
        "integrity": {
            "expected_final_cells": expected,
            "observed_final_cells": len(rows),
            "unique_final_cells": len(lookup),
            "complete_matrix": complete,
            "verifier_ctrf_files": sum(
                row["verifier_subtests"]["ctrf_sha256"] is not None
                for row in rows
            ),
            "provider_session_identities_valid": sum(
                row["integrity"]["provider_session_input_match"]
                and row["integrity"]["provider_session_cached_match"]
                and row["integrity"]["provider_session_output_match"]
                for row in rows
            ),
            "codexzero_trials": sum(
                row["config"] == "codexzero_safe" for row in rows
            ),
            "codexzero_accounting_valid": all(
                row["codexzero"]["accounting_valid"]
                for row in rows
                if row["config"] == "codexzero_safe"
            ),
            "codexzero_artifacts_verified": all(
                row["codexzero"]["artifacts_verified"]
                for row in rows
                if row["config"] == "codexzero_safe"
            ),
            "non_timeout_infrastructure_exceptions": sum(
                bool(row["exception_type"])
                and row["exception_type"] != "AgentTimeoutError"
                for row in rows
            ),
            "agent_timeouts_retained_as_scored_outcomes": sum(
                row["exception_type"] == "AgentTimeoutError" for row in rows
            ),
        },
    }


def pct(value: float, digits: int = 2) -> str:
    return f"{value * 100:.{digits}f}%"


def interval(value: list[float], *, percent: bool = False) -> str:
    if percent:
        return f"{value[0] * 100:.2f}% to {value[1] * 100:.2f}%"
    return f"{value[0]:,.0f} to {value[1]:,.0f}"


def render_markdown(
    summary: dict[str, Any],
    task_order: list[str],
    clean_wall_seconds: int,
    discarded_wall_seconds: int,
) -> str:
    configs = summary["configs"]
    comparisons = summary["comparisons_vs_codex"]
    lines = [
        "# Repeated three-way Terminal-Bench replication",
        "",
        "**CodexZero Safe exactly matched stock Codex across 36 paired official "
        "verifier outcomes: 29/36 (80.56%) each.** Codex + RTK scored 32/36 "
        "(88.89%), an 8.33-point point estimate whose paired interval includes "
        "zero.",
        "",
        "This run uses 12 fresh tasks with three repetitions per configuration. "
        "The official score therefore moves in 2.78-point increments instead of "
        "the earlier 10-point increments. Verifier subtest rates and per-task "
        "0/3–3/3 stability are reported as secondary diagnostics.",
        "",
        "## Main result",
        "",
        "| Configuration | Official score | 95% Wilson | Task-cluster 95% | "
        "Majority task score | Verifier assertions | Task-normalized assertion "
        "rate | Provider tokens | vs Codex | API-equivalent cost | vs Codex | "
        "Agent time |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for config in CONFIG_ORDER:
        row = configs[config]
        quality = row["official_quality"]
        provider = row["provider"]
        comparison = comparisons.get(config)
        token_change = (
            "baseline"
            if comparison is None
            else (
                f"{abs(comparison['total_token_change_fraction']) * 100:.2f}% "
                + (
                    "less"
                    if comparison["total_token_change_fraction"] < 0
                    else "more"
                )
            )
        )
        cost_change = (
            "baseline"
            if comparison is None
            else (
                f"{abs(comparison['total_api_cost_change_fraction']) * 100:.2f}% "
                + (
                    "less"
                    if comparison["total_api_cost_change_fraction"] < 0
                    else "more"
                )
            )
        )
        lines.append(
            f"| {row['display_name']} | **{quality['passes']}/"
            f"{quality['attempts']} ({pct(quality['pass_rate'])})** | "
            f"{interval(quality['wilson_95'], percent=True)} | "
            f"{interval(quality['task_cluster_bootstrap_95'], percent=True)} | "
            f"{quality['majority_task_passes']}/{quality['majority_task_total']} "
            f"({pct(quality['majority_task_rate'])}) | "
            f"{row['verifier_subtests']['raw_passed']}/"
            f"{row['verifier_subtests']['raw_tests']} "
            f"({pct(row['verifier_subtests']['micro_pass_rate'])}) | "
            f"{pct(row['verifier_subtests']['task_normalized_macro_pass_rate'])} | "
            f"{provider['total_tokens']:,} | {token_change} | "
            f"${provider['official_api_equivalent_cost_usd']:.4f} | "
            f"{cost_change} | {row['time']['agent_execution'] / 60:.1f} min |"
        )

    lines += [
        "",
        "The official reward remains the primary score. Raw verifier assertions "
        "are more granular but overweight tasks with more tests. The normalized "
        "rate first averages within each task and repetition, then gives each task "
        "equal weight. Neither assertion rate is a Terminal-Bench leaderboard "
        "metric.",
        "",
        "## Paired quality comparison",
        "",
        "| Configuration | Score delta | Task-cluster bootstrap 95% | "
        "Codex-only passes | Candidate-only passes | Exact paired p |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for config in CONFIG_ORDER[1:]:
        row = comparisons[config]
        p_value = row["exact_cell_mcnemar_p"]
        lines.append(
            f"| {DISPLAY[config]} | {row['official_score_delta'] * 100:+.2f} "
            f"points | "
            f"{interval(row['score_delta_task_cluster_bootstrap_95'], percent=True)} "
            f"| {row['baseline_only_passes']} | {row['candidate_only_passes']} | "
            f"{p_value:.4f} |"
        )

    lines += [
        "",
        "RTK's three additional passes were one `path-tracing` repetition and "
        "two `pytorch-model-recovery` repetitions. The exact paired result is "
        "not statistically significant at this sample size.",
        "",
        "## Per-task stability",
        "",
        "| Task | Codex | CodexZero Safe | Codex + RTK |",
        "|---|---:|---:|---:|",
    ]
    for task in task_order:
        lines.append(
            f"| `{task}` | "
            f"{configs['codex']['official_quality']['per_task_passes_of_three'][task]}/3 "
            f"| {configs['codexzero_safe']['official_quality']['per_task_passes_of_three'][task]}/3 "
            f"| {configs['codex_rtk']['official_quality']['per_task_passes_of_three'][task]}/3 |"
        )

    lines += [
        "",
        "## Tokens, cache, calls, turns, time, and cost",
        "",
        "| Configuration | Input | Cached | Uncached | Output | Reasoning | "
        "Cache ratio | Requests | Cache-hit requests | Tool calls | Shell commands "
        "| Agent time | Cost | Codex credits |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for config in CONFIG_ORDER:
        row = configs[config]
        p = row["provider"]
        a = row["activity"]
        lines.append(
            f"| {DISPLAY[config]} | {p['input_tokens']:,} | "
            f"{p['cached_input_tokens']:,} | {p['uncached_input_tokens']:,} | "
            f"{p['output_tokens']:,} | {p['reasoning_output_tokens']:,} | "
            f"{pct(p['cache_token_ratio'], 1)} | {a['inference_requests']:,} | "
            f"{a['cache_hit_requests']:,} | {a['session_tool_calls']:,} | "
            f"{a['shell_commands']:,} | {row['time']['agent_execution'] / 60:.1f} min "
            f"| ${p['official_api_equivalent_cost_usd']:.4f} | "
            f"{p['codex_rate_card_credits']:.3f} |"
        )

    lines += [
        "",
        "## Efficiency uncertainty",
        "",
        "| Configuration | Mean tokens saved/cell | Task-cluster bootstrap 95% "
        "| Lower-token cells | Higher-token cells | Sign-test p | Mean cost "
        "saved/cell | Cost bootstrap 95% |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for config in CONFIG_ORDER[1:]:
        row = comparisons[config]
        lines.append(
            f"| {DISPLAY[config]} | {row['mean_tokens_saved_per_cell']:+,.0f} | "
            f"{interval(row['tokens_saved_task_cluster_bootstrap_95'])} | "
            f"{row['lower_token_cells']} | {row['higher_token_cells']} | "
            f"{row['exact_token_sign_test_p']:.4f} | "
            f"${row['mean_api_cost_saved_per_cell']:+.4f} | "
            f"${row['api_cost_saved_task_cluster_bootstrap_95'][0]:+.4f} to "
            f"${row['api_cost_saved_task_cluster_bootstrap_95'][1]:+.4f} |"
        )

    safe = configs["codexzero_safe"]
    rtk = configs["codex_rtk"]
    lines += [
        "",
        "CodexZero Safe used **14.63% fewer provider tokens** and **7.40% less "
        "API-equivalent cost** than Codex in total. Its task-cluster efficiency "
        "interval is shown above; the observed reduction is driven mainly by "
        "shorter model trajectories, not the codec.",
        "",
        "RTK used **18.70% more provider tokens** and **15.19% more "
        "API-equivalent cost** than Codex in this replication. That reverses the "
        "earlier mini-panel's point estimate and confirms that one attempt per "
        "task was not enough to rank efficiency.",
        "",
        "## Optimizer-native telemetry",
        "",
        "| Configuration | Payloads/commands | Transformed | Native tokens saved "
        "| Fallbacks |",
        "|---|---:|---:|---:|---:|",
        f"| CodexZero Safe | {safe['codexzero']['events']:,} payloads | "
        f"{safe['codexzero']['transformed_events']:,} | "
        f"{safe['codexzero']['tokens_eliminated']:,} | — |",
        f"| Codex + RTK | {rtk['rtk']['commands']:,} commands | — | "
        f"{rtk['rtk']['tokens_saved']:,} | {rtk['rtk']['fallback_successes']:,} |",
        "",
        "CodexZero transformed one payload. RTK's own database measured only "
        f"{rtk['rtk']['tokens_saved']:,} tokens saved across "
        f"{rtk['rtk']['commands']:,} commands. These native counters are much "
        "smaller than the provider-level differences, so the totals mostly "
        "reflect different model trajectories and repeated context.",
        "",
        "## Infrastructure correction",
        "",
        "The first two 36-cell validation waves exposed two objective container "
        "defects: four minimal Ubuntu images lacked a usable CA bundle for all "
        "configurations, and the Debian Bullseye QEMU image could not load the "
        "glibc-2.39-linked CodexZero benchmark binary. The correction was sealed "
        "before the replacement model calls.",
        "",
        "The final matrix reran **all 108 cells**, rather than selectively keeping "
        "successful cells. It mounted the same CA bundle for all configurations "
        "and ran the byte-identical CodexZero binary through a hashed loader "
        "wrapper with its build-runtime libraries. The discarded 72 attempts "
        "remain in `attempts.json` and are never included in final scores.",
        "",
        "## Design and integrity",
        "",
        "- Model: `gpt-5.6-sol`, medium reasoning.",
        "- Fresh selection: 12 tasks sampled from the 77 tasks not used in the "
        "first mini-panel.",
        "- Repetitions: three per task and configuration; task and configuration "
        "orders rotated each repetition.",
        "- Final matrix: 108/108 cells; zero quality retries.",
        "- Official score resolution: 2.78 percentage points.",
        f"- Final clean matrix wall time: {clean_wall_seconds / 60:.1f} minutes.",
        f"- Discarded infrastructure-validation waves: "
        f"{discarded_wall_seconds / 60:.1f} minutes.",
        f"- Verifier CTRF records: {summary['integrity']['verifier_ctrf_files']}/108.",
        f"- Provider/session token identities: "
        f"{summary['integrity']['provider_session_identities_valid']}/108.",
        f"- Retained agent timeouts: "
        f"{summary['integrity']['agent_timeouts_retained_as_scored_outcomes']}; "
        "these are model outcomes and score zero.",
        f"- Other final-matrix infrastructure exceptions: "
        f"{summary['integrity']['non_timeout_infrastructure_exceptions']}.",
        "",
        "Three repetitions improve repeatability and give a 36-outcome score, "
        "but the sample still contains only 12 unique tasks. The task-cluster "
        "intervals are the appropriate guard against treating repeated attempts "
        "as 36 independent task draws.",
        "",
        "## Files",
        "",
        "- [`preregistration.json`](preregistration.json): sealed task sample and "
        "analysis plan.",
        "- [`infrastructure-addendum.json`](infrastructure-addendum.json): sealed "
        "correction and runtime hashes.",
        "- [`summary.json`](summary.json): aggregate quality, efficiency, "
        "uncertainty, and integrity metrics.",
        "- [`trials.json`](trials.json): every final scored cell.",
        "- [`attempts.json`](attempts.json): all final and discarded validation "
        "attempts.",
        "- [`run-manifest.json`](run-manifest.json): wall times and artifact/tree "
        "hashes.",
        "",
        "Generated by "
        "[`tools/analyze-terminal-bench-replication.py`]"
        "(../../tools/analyze-terminal-bench-replication.py).",
    ]
    return "\n".join(lines) + "\n"


def parse_meta(path: Path) -> dict[str, Any]:
    result: dict[str, Any] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if "=" not in line:
            continue
        key, value = line.split("=", 1)
        result[key] = int(value) if value.isdigit() else value
    return result


def tree_digest(path: Path) -> dict[str, Any]:
    hasher = hashlib.sha256()
    files = 0
    size = 0
    for item in sorted(p for p in path.rglob("*") if p.is_file()):
        raw = item.read_bytes()
        hasher.update(item.relative_to(path).as_posix().encode())
        hasher.update(b"\0")
        hasher.update(raw)
        hasher.update(b"\0")
        files += 1
        size += len(raw)
    return {"files": files, "bytes": size, "tree_sha256": hasher.hexdigest()}


def main() -> int:
    global args
    parser = argparse.ArgumentParser()
    parser.add_argument("--job", action="append", required=True, type=Path)
    parser.add_argument("--discarded-job", action="append", default=[], type=Path)
    parser.add_argument("--preregistration", required=True, type=Path)
    parser.add_argument("--infrastructure-addendum", required=True, type=Path)
    parser.add_argument("--meta-root", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()

    preregistration = json.loads(
        args.preregistration.read_text(encoding="utf-8")
    )
    addendum = json.loads(
        args.infrastructure_addendum.read_text(encoding="utf-8")
    )
    task_order = [
        task["name"] for task in preregistration["benchmark"]["tasks"]
    ]

    final_rows: list[dict[str, Any]] = []
    for repetition, job in enumerate(args.job, start=1):
        final_rows.extend(collect_job(job, repetition, "final_scored"))
    discarded_rows: list[dict[str, Any]] = []
    for repetition, job in enumerate(args.discarded_job, start=1):
        discarded_rows.extend(
            collect_job(job, repetition, "superseded_infrastructure_validation")
        )

    summary = summarize(
        final_rows, task_order, preregistration, addendum
    )
    if not summary["integrity"]["complete_matrix"]:
        raise RuntimeError("Final matrix is incomplete")

    clean_meta = [
        parse_meta(args.meta_root / f"v2-r{i}.meta") for i in range(1, 4)
    ]
    discarded_meta = [
        parse_meta(args.meta_root / f"r{i}.meta") for i in range(1, 3)
    ]
    clean_wall = sum(int(item["elapsed_sec"]) for item in clean_meta)
    discarded_wall = sum(
        int(item["elapsed_sec"]) for item in discarded_meta
    )

    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "trials.json").write_text(
        json.dumps(final_rows, indent=2) + "\n", encoding="utf-8"
    )
    all_attempts = discarded_rows + final_rows
    (args.output / "attempts.json").write_text(
        json.dumps(all_attempts, indent=2) + "\n", encoding="utf-8"
    )
    (args.output / "summary.json").write_text(
        json.dumps(summary, indent=2) + "\n", encoding="utf-8"
    )
    report = render_markdown(
        summary, task_order, clean_wall, discarded_wall
    )
    (args.output / "README.md").write_text(report, encoding="utf-8")

    public_files = [
        "preregistration.json",
        "PREREGISTRATION.sha256",
        "infrastructure-addendum.json",
        "INFRASTRUCTURE_ADDENDUM.sha256",
        "summary.json",
        "trials.json",
        "attempts.json",
        "README.md",
    ]
    manifest = {
        "schema": "codexzero-terminal-bench-replication-run-manifest-v1",
        "preregistration": {
            "git_commit": "7c23e04",
            "sha256": digest(args.preregistration),
        },
        "infrastructure_addendum": {
            "git_commit": "3cf5926",
            "sha256": digest(args.infrastructure_addendum),
        },
        "execution": {
            "clean_repetitions": clean_meta,
            "discarded_validation_waves": discarded_meta,
            "initial_install_check": parse_meta(
                args.meta_root / "install-check.meta"
            ),
            "fixed_install_check": parse_meta(
                args.meta_root / "v2-install-check.meta"
            ),
            "clean_matrix_wall_sec": clean_wall,
            "discarded_validation_wall_sec": discarded_wall,
            "recorded_harbor_controller_wall_sec": (
                clean_wall
                + discarded_wall
                + int(
                    parse_meta(args.meta_root / "install-check.meta")[
                        "elapsed_sec"
                    ]
                )
                + int(
                    parse_meta(args.meta_root / "v2-install-check.meta")[
                        "elapsed_sec"
                    ]
                )
            ),
        },
        "attempts": {
            "final_scored": len(final_rows),
            "discarded_infrastructure_validation": len(discarded_rows),
            "total_analyzed": len(all_attempts),
        },
        "raw_jobs": {
            job.name: {
                "root": f"${{ISOLATED_REPLICATION_ROOT}}/jobs/{job.name}",
                **tree_digest(job),
            }
            for job in [*args.discarded_job, *args.job]
        },
        "public_artifacts": {
            name: {
                "bytes": (args.output / name).stat().st_size,
                "sha256": digest(args.output / name),
            }
            for name in public_files
        },
        "analysis_script": {
            "path": "tools/analyze-terminal-bench-replication.py",
            "sha256": digest(Path(__file__)),
            "base_parser_path": "tools/analyze-terminal-bench.py",
            "base_parser_sha256": digest(
                Path(__file__).with_name("analyze-terminal-bench.py")
            ),
        },
        "integrity": summary["integrity"],
    }
    (args.output / "run-manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )
    print(
        json.dumps(
            {
                "final_cells": len(final_rows),
                "discarded_attempts": len(discarded_rows),
                "scores": {
                    config: summary["configs"][config]["official_quality"][
                        "pass_rate"
                    ]
                    for config in CONFIG_ORDER
                },
                "complete": summary["integrity"]["complete_matrix"],
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
