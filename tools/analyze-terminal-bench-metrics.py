#!/usr/bin/env python3
"""Build a reproducible, task-level Terminal-Bench metrics audit.

The input manifest names immutable Harbor campaign roots and the profiles to
take from each campaign.  Accepted trials in each controller checkpoint are
the source of truth; raw trial results are read only to recover usage, timing,
failure, model, and reasoning-effort fields.
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_MANIFEST = ROOT / "reports" / "terminal-bench-metrics-sources-2026-08-13.json"
DEFAULT_JSON = ROOT / "reports" / "terminal-bench-metrics-audit-2026-08-13.json"
DEFAULT_MD = ROOT / "reports" / "terminal-bench-metrics-audit-2026-08-13.md"


def load_json(path: Path) -> dict[str, Any]:
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError(f"expected JSON object: {path}")
    return value


def parse_time(value: Any) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def interval_seconds(value: Any) -> float | None:
    if not isinstance(value, dict):
        return None
    start = parse_time(value.get("started_at"))
    finish = parse_time(value.get("finished_at"))
    if start is None or finish is None:
        return None
    return max(0.0, (finish - start).total_seconds())


def percentile(values: list[float], quantile: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    if len(ordered) == 1:
        return ordered[0]
    position = (len(ordered) - 1) * quantile
    lower = math.floor(position)
    upper = math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def wilson_interval(passes: int, total: int, z: float = 1.959963984540054) -> list[float] | None:
    if total <= 0:
        return None
    proportion = passes / total
    denominator = 1.0 + z * z / total
    centre = (proportion + z * z / (2.0 * total)) / denominator
    margin = z * math.sqrt(
        proportion * (1.0 - proportion) / total + z * z / (4.0 * total * total)
    ) / denominator
    return [100.0 * max(0.0, centre - margin), 100.0 * min(1.0, centre + margin)]


def exact_mcnemar_p(candidate_only: int, baseline_only: int) -> float:
    discordant = candidate_only + baseline_only
    if discordant == 0:
        return 1.0
    smaller = min(candidate_only, baseline_only)
    lower_tail = sum(math.comb(discordant, k) for k in range(smaller + 1)) / (2**discordant)
    return min(1.0, 2.0 * lower_tail)


def reward_value(result: dict[str, Any]) -> float:
    verifier = result.get("verifier_result") or {}
    rewards = verifier.get("rewards") or {}
    value = rewards.get("reward", 0.0)
    return float(value) if isinstance(value, (int, float)) else 0.0


def exception_name(result: dict[str, Any]) -> str | None:
    info = result.get("exception_info") or {}
    value = info.get("exception_type") or info.get("type")
    return str(value) if value else None


def failure_category(passed: bool, exception: str | None) -> str:
    if passed:
        return "pass"
    lowered = (exception or "").lower()
    if "timeout" in lowered:
        return "timeout"
    if "safetyrefusal" in lowered or "safety_refusal" in lowered:
        return "safety_refusal"
    if "nonzeroagentexit" in lowered or "process" in lowered:
        return "process_failure"
    if lowered:
        return "other_exception"
    return "verifier_failure"


def profile_from_result(result: dict[str, Any]) -> str | None:
    agent = ((result.get("config") or {}).get("agent") or {})
    env = agent.get("env") or {}
    return env.get("CODEX_BENCHMARK_LABEL") or env.get("TURA_BENCHMARK_LABEL")


def reasoning_effort(result: dict[str, Any]) -> str:
    agent = ((result.get("config") or {}).get("agent") or {})
    env = agent.get("env") or {}
    kwargs = agent.get("kwargs") or {}
    return str(kwargs.get("reasoning_effort") or env.get("TURA_REASONING_EFFORT") or "unknown")


def model_name(result: dict[str, Any]) -> str:
    model = ((result.get("agent_info") or {}).get("model_info") or {}).get("name")
    if model:
        return str(model)
    agent = ((result.get("config") or {}).get("agent") or {})
    return str(agent.get("model_name") or "unknown")


def result_to_cell(
    result: dict[str, Any], *, profile: str, campaign: str, trial_path: Path
) -> dict[str, Any]:
    agent_result = result.get("agent_result") or {}
    input_tokens = agent_result.get("n_input_tokens")
    cache_tokens = agent_result.get("n_cache_tokens")
    output_tokens = agent_result.get("n_output_tokens")
    cost = agent_result.get("cost_usd")
    usage_present = all(isinstance(v, (int, float)) for v in (input_tokens, output_tokens, cost))
    exception = exception_name(result)
    reward = reward_value(result)
    passed = reward > 0.0
    started = parse_time(result.get("started_at"))
    finished = parse_time(result.get("finished_at"))
    wall_seconds = None
    if started is not None and finished is not None:
        wall_seconds = max(0.0, (finished - started).total_seconds())
    return {
        "task": str(result.get("task_name") or "unknown"),
        "profile": profile,
        "campaign": campaign,
        "trial": str(trial_path),
        "reward": reward,
        "passed": passed,
        "input_tokens": int(input_tokens) if isinstance(input_tokens, (int, float)) else None,
        "cache_tokens": int(cache_tokens) if isinstance(cache_tokens, (int, float)) else None,
        "output_tokens": int(output_tokens) if isinstance(output_tokens, (int, float)) else None,
        "cost_usd": float(cost) if isinstance(cost, (int, float)) else None,
        "usage_present": usage_present,
        "exception": exception,
        "failure_category": failure_category(passed, exception),
        "reasoning_effort": reasoning_effort(result),
        "model": model_name(result),
        "wall_seconds": wall_seconds,
        "agent_seconds": interval_seconds(result.get("agent_execution")),
    }


def accepted_cells(campaign: dict[str, Any], excluded: set[str]) -> list[dict[str, Any]]:
    root = Path(campaign["root"])
    checkpoint_path = root / "checkpoint.json"
    checkpoint = load_json(checkpoint_path)
    allowed = set(campaign.get("include_profiles") or [])
    cells: list[dict[str, Any]] = []
    missing_results: list[str] = []
    for task, task_state in (checkpoint.get("tasks") or {}).items():
        if task in excluded:
            continue
        for profile, accepted in (task_state.get("accepted") or {}).items():
            if allowed and profile not in allowed:
                continue
            trial = Path(str((accepted or {}).get("trial") or ""))
            result_path = trial / "result.json"
            if not result_path.is_file():
                missing_results.append(str(result_path))
                continue
            result = load_json(result_path)
            discovered_profile = profile_from_result(result)
            if discovered_profile and discovered_profile != profile:
                raise ValueError(
                    f"checkpoint/result profile mismatch at {result_path}: "
                    f"{profile!r} != {discovered_profile!r}"
                )
            cells.append(
                result_to_cell(
                    result,
                    profile=profile,
                    campaign=str(campaign.get("id") or root.name),
                    trial_path=trial,
                )
            )
    if missing_results:
        preview = "\n".join(missing_results[:5])
        raise FileNotFoundError(f"accepted trials missing result.json:\n{preview}")
    return cells


def sum_present(rows: Iterable[dict[str, Any]], key: str) -> int | float:
    values = [row.get(key) for row in rows]
    return sum(value for value in values if isinstance(value, (int, float)))


def aggregate_profile(
    profile_id: str,
    rows: list[dict[str, Any]],
    metadata: dict[str, Any],
    eligible_tasks: int,
) -> dict[str, Any]:
    tested = len(rows)
    passes = sum(bool(row["passed"]) for row in rows)
    input_tokens = int(sum_present(rows, "input_tokens"))
    cache_tokens = int(sum_present(rows, "cache_tokens"))
    output_tokens = int(sum_present(rows, "output_tokens"))
    cost = float(sum_present(rows, "cost_usd"))
    usage_cells = sum(bool(row["usage_present"]) for row in rows)
    failures = Counter(row["failure_category"] for row in rows if not row["passed"])
    exceptions = Counter(row["exception"] for row in rows if row.get("exception"))
    timeout_cells = sum("timeout" in (row.get("exception") or "").lower() for row in rows)
    timeout_failures = sum(
        "timeout" in (row.get("exception") or "").lower() and not row["passed"] for row in rows
    )
    efforts = Counter(row["reasoning_effort"] for row in rows)
    models = Counter(row["model"] for row in rows)
    wall = [float(row["wall_seconds"]) for row in rows if row.get("wall_seconds") is not None]
    agent = [float(row["agent_seconds"]) for row in rows if row.get("agent_seconds") is not None]
    effort_metrics: dict[str, dict[str, Any]] = {}
    for effort in sorted(efforts):
        effort_rows = [row for row in rows if row["reasoning_effort"] == effort]
        effort_passes = sum(bool(row["passed"]) for row in effort_rows)
        effort_input = int(sum_present(effort_rows, "input_tokens"))
        effort_output = int(sum_present(effort_rows, "output_tokens"))
        effort_cost = float(sum_present(effort_rows, "cost_usd"))
        effort_usage = sum(bool(row["usage_present"]) for row in effort_rows)
        effort_metrics[effort] = {
            "tested": len(effort_rows),
            "passes": effort_passes,
            "pass_rate_pct": 100.0 * effort_passes / len(effort_rows),
            "pass_rate_wilson_95_pct": wilson_interval(effort_passes, len(effort_rows)),
            "usage_cells": effort_usage,
            "usage_coverage_pct": 100.0 * effort_usage / len(effort_rows),
            "measured_cost_usd": effort_cost,
            "measured_cost_per_pass_usd": effort_cost / effort_passes if effort_passes else None,
            "total_tokens": effort_input + effort_output,
            "measured_tokens_per_pass": (
                (effort_input + effort_output) / effort_passes if effort_passes else None
            ),
        }
    return {
        "id": profile_id,
        "label": metadata.get("label", profile_id),
        "group": metadata.get("group", "Other"),
        "tested": tested,
        "eligible_tasks": eligible_tasks,
        "coverage_pct": 100.0 * tested / eligible_tasks if eligible_tasks else 0.0,
        "passes": passes,
        "pass_rate_pct": 100.0 * passes / tested if tested else 0.0,
        "pass_rate_wilson_95_pct": wilson_interval(passes, tested),
        "failures": tested - passes,
        "failure_rate_pct": 100.0 * (tested - passes) / tested if tested else 0.0,
        "failure_categories": dict(sorted(failures.items())),
        "exception_types": dict(sorted(exceptions.items())),
        "timeout_cells": timeout_cells,
        "timeout_failures": timeout_failures,
        "passed_with_timeout_exception": timeout_cells - timeout_failures,
        "timeout_rate_pct": 100.0 * timeout_cells / tested if tested else 0.0,
        "usage_cells": usage_cells,
        "missing_usage_cells": tested - usage_cells,
        "usage_coverage_pct": 100.0 * usage_cells / tested if tested else 0.0,
        "measured_cost_usd": cost,
        "measured_cost_per_attempt_usd": cost / tested if tested else None,
        "measured_cost_per_pass_usd": cost / passes if passes else None,
        "input_tokens": input_tokens,
        "cache_tokens": cache_tokens,
        "uncached_input_tokens": input_tokens - cache_tokens,
        "output_tokens": output_tokens,
        "total_tokens": input_tokens + output_tokens,
        "cache_share_of_input_pct": 100.0 * cache_tokens / input_tokens if input_tokens else None,
        "measured_tokens_per_attempt": (input_tokens + output_tokens) / tested if tested else None,
        "measured_tokens_per_pass": (input_tokens + output_tokens) / passes if passes else None,
        "reasoning_effort_cells": dict(sorted(efforts.items())),
        "reasoning_effort_metrics": effort_metrics,
        "model_cells": dict(sorted(models.items())),
        "wall_time_seconds": {
            "observations": len(wall),
            "median": statistics.median(wall) if wall else None,
            "p95": percentile(wall, 0.95),
            "total": sum(wall),
        },
        "agent_time_seconds": {
            "observations": len(agent),
            "median": statistics.median(agent) if agent else None,
            "p95": percentile(agent, 0.95),
            "total": sum(agent),
        },
    }


def paired_comparison(
    candidate: str,
    baseline: str,
    by_profile: dict[str, dict[str, dict[str, Any]]],
) -> dict[str, Any]:
    candidate_rows = by_profile.get(candidate, {})
    baseline_rows = by_profile.get(baseline, {})
    common = sorted(set(candidate_rows) & set(baseline_rows))
    both_pass = candidate_only = baseline_only = both_fail = 0
    cheaper_candidate = cheaper_baseline = cost_ties = cost_comparable = 0
    fewer_tokens_candidate = fewer_tokens_baseline = token_ties = token_comparable = 0
    for task in common:
        left = candidate_rows[task]
        right = baseline_rows[task]
        if left["passed"] and right["passed"]:
            both_pass += 1
        elif left["passed"]:
            candidate_only += 1
        elif right["passed"]:
            baseline_only += 1
        else:
            both_fail += 1
        if left.get("cost_usd") is not None and right.get("cost_usd") is not None:
            cost_comparable += 1
            delta = float(left["cost_usd"]) - float(right["cost_usd"])
            if abs(delta) < 1e-12:
                cost_ties += 1
            elif delta < 0:
                cheaper_candidate += 1
            else:
                cheaper_baseline += 1
        left_tokens = None
        right_tokens = None
        if left.get("input_tokens") is not None and left.get("output_tokens") is not None:
            left_tokens = int(left["input_tokens"]) + int(left["output_tokens"])
        if right.get("input_tokens") is not None and right.get("output_tokens") is not None:
            right_tokens = int(right["input_tokens"]) + int(right["output_tokens"])
        if left_tokens is not None and right_tokens is not None:
            token_comparable += 1
            if left_tokens == right_tokens:
                token_ties += 1
            elif left_tokens < right_tokens:
                fewer_tokens_candidate += 1
            else:
                fewer_tokens_baseline += 1
    paired_n = len(common)
    return {
        "candidate": candidate,
        "baseline": baseline,
        "paired_tasks": paired_n,
        "candidate_only_pass": candidate_only,
        "baseline_only_pass": baseline_only,
        "both_pass": both_pass,
        "both_fail": both_fail,
        "paired_pass_rate_delta_pct_points": (
            100.0 * (candidate_only - baseline_only) / paired_n if paired_n else None
        ),
        "mcnemar_exact_two_sided_p": exact_mcnemar_p(candidate_only, baseline_only),
        "cost_comparable_tasks": cost_comparable,
        "candidate_cheaper_tasks": cheaper_candidate,
        "baseline_cheaper_tasks": cheaper_baseline,
        "cost_ties": cost_ties,
        "token_comparable_tasks": token_comparable,
        "candidate_fewer_token_tasks": fewer_tokens_candidate,
        "baseline_fewer_token_tasks": fewer_tokens_baseline,
        "token_ties": token_ties,
    }


def fmt_number(value: Any, digits: int = 1) -> str:
    if value is None:
        return "—"
    if isinstance(value, int):
        return f"{value:,}"
    return f"{float(value):,.{digits}f}"


def markdown_report(report: dict[str, Any]) -> str:
    lines = [
        "# Terminal-Bench metrics audit",
        "",
        "Totals are measured over accepted Harbor trials. Pass-rate denominators include "
        "terminal failures; cost and token totals cannot include cells where the provider "
        "returned no usage.",
        "",
        "## Coverage, quality, and efficiency",
        "",
        "| Profile | Coverage | Pass rate (95% Wilson CI) | Measured cost | Cost/pass | Total tokens | Tokens/pass | Usage coverage |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for item in report["profiles"]:
        ci = item["pass_rate_wilson_95_pct"] or [0.0, 0.0]
        lines.append(
            f"| {item['label']} | {item['tested']}/{item['eligible_tasks']} "
            f"({item['coverage_pct']:.1f}%) | {item['passes']}/{item['tested']} "
            f"({item['pass_rate_pct']:.1f}%; {ci[0]:.1f}–{ci[1]:.1f}%) | "
            f"${item['measured_cost_usd']:.3f} | "
            f"${fmt_number(item['measured_cost_per_pass_usd'], 3)} | "
            f"{item['total_tokens']:,} | {fmt_number(item['measured_tokens_per_pass'], 0)} | "
            f"{item['usage_cells']}/{item['tested']} ({item['usage_coverage_pct']:.1f}%) |"
        )
    lines.extend(
        [
            "",
            "## Reasoning-effort strata",
            "",
            "These rows keep the 32-task medium prefix separate from the 56-task low extension.",
            "",
            "| Profile / effort | Pass rate | Measured cost | Cost/pass | Total tokens | Tokens/pass | Usage coverage |",
            "|---|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for item in report["profiles"]:
        for effort, stratum in item["reasoning_effort_metrics"].items():
            lines.append(
                f"| {item['label']} / {effort} | {stratum['passes']}/{stratum['tested']} "
                f"({stratum['pass_rate_pct']:.1f}%) | ${stratum['measured_cost_usd']:.3f} | "
                f"${fmt_number(stratum['measured_cost_per_pass_usd'], 3)} | "
                f"{stratum['total_tokens']:,} | {fmt_number(stratum['measured_tokens_per_pass'], 0)} | "
                f"{stratum['usage_cells']}/{stratum['tested']} ({stratum['usage_coverage_pct']:.1f}%) |"
            )
    lines.extend(
        [
            "",
            "## Cache, failures, and latency",
            "",
            "| Profile | Cached / input tokens | Uncached input | Output | Timeouts | Other failures | Agent median / p95 | Effort mix |",
            "|---|---:|---:|---:|---:|---:|---:|---|",
        ]
    )
    for item in report["profiles"]:
        timeouts = item["timeout_cells"]
        other_failures = item["failures"] - item["timeout_failures"]
        timing = item["agent_time_seconds"]
        effort = ", ".join(f"{key}: {value}" for key, value in item["reasoning_effort_cells"].items())
        lines.append(
            f"| {item['label']} | {item['cache_tokens']:,} / {item['input_tokens']:,} "
            f"({fmt_number(item['cache_share_of_input_pct'], 1)}%) | "
            f"{item['uncached_input_tokens']:,} | {item['output_tokens']:,} | "
            f"{timeouts} ({item['timeout_rate_pct']:.1f}%; "
            f"{item['passed_with_timeout_exception']} later passed) | {other_failures} | "
            f"{fmt_number(timing['median'], 1)}s / {fmt_number(timing['p95'], 1)}s | {effort} |"
        )
    lines.extend(
        [
            "",
            "## Paired task outcomes",
            "",
            "Candidate-only and baseline-only passes are direct task-level wins. The exact "
            "McNemar p-value tests only those discordant task outcomes.",
            "",
            "| Candidate vs baseline | Paired tasks | Pass W–L | Both pass / fail | Pass-rate delta | Exact p | Cheaper task W–L | Fewer-token task W–L |",
            "|---|---:|---:|---:|---:|---:|---:|---:|",
        ]
    )
    labels = {item["id"]: item["label"] for item in report["profiles"]}
    for item in report["paired_comparisons"]:
        delta = item["paired_pass_rate_delta_pct_points"]
        lines.append(
            f"| {labels.get(item['candidate'], item['candidate'])} vs "
            f"{labels.get(item['baseline'], item['baseline'])} | {item['paired_tasks']} | "
            f"{item['candidate_only_pass']}–{item['baseline_only_pass']} | "
            f"{item['both_pass']} / {item['both_fail']} | {fmt_number(delta, 1)} pp | "
            f"{item['mcnemar_exact_two_sided_p']:.4f} | "
            f"{item['candidate_cheaper_tasks']}–{item['baseline_cheaper_tasks']} "
            f"(n={item['cost_comparable_tasks']}) | "
            f"{item['candidate_fewer_token_tasks']}–{item['baseline_fewer_token_tasks']} "
            f"(n={item['token_comparable_tasks']}) |"
        )
    lines.extend(
        [
            "",
            "## Remaining measurement limits",
            "",
            "- Cost and token statistics are measured lower bounds when usage coverage is below 100%.",
            "- Mixed-effort totals are split in the Effort mix column; compare profiles on the paired low-effort subset for a controlled efficiency claim.",
            "- A single accepted attempt per task measures this run, not run-to-run variance. Repeated-task campaigns should be reported separately rather than merged into these totals.",
            "- Wall-clock and agent-time figures include observed completed trial records only; they are not a throughput benchmark under controlled machine load.",
            "",
        ]
    )
    return "\n".join(lines)


def build_report(manifest: dict[str, Any]) -> dict[str, Any]:
    eligible_tasks = int(manifest["eligible_tasks"])
    excluded = set(map(str, manifest.get("excluded_tasks") or []))
    all_cells: list[dict[str, Any]] = []
    source_counts: dict[str, int] = {}
    for campaign in manifest.get("campaigns") or []:
        cells = accepted_cells(campaign, excluded)
        source_counts[str(campaign.get("id") or campaign["root"])] = len(cells)
        all_cells.extend(cells)

    unique: dict[tuple[str, str], dict[str, Any]] = {}
    for cell in all_cells:
        key = (cell["profile"], cell["task"])
        if key in unique:
            raise ValueError(
                f"duplicate accepted profile/task cell {key}: "
                f"{unique[key]['trial']} and {cell['trial']}"
            )
        unique[key] = cell

    metadata = manifest.get("profiles") or {}
    profile_order = list(metadata)
    extras = sorted(set(cell[0] for cell in unique) - set(profile_order))
    profile_order.extend(extras)
    rows_by_profile: dict[str, list[dict[str, Any]]] = defaultdict(list)
    task_map: dict[str, dict[str, dict[str, Any]]] = defaultdict(dict)
    for (profile, task), cell in unique.items():
        rows_by_profile[profile].append(cell)
        task_map[profile][task] = cell
    profiles = [
        aggregate_profile(profile, rows_by_profile.get(profile, []), metadata.get(profile, {}), eligible_tasks)
        for profile in profile_order
        if rows_by_profile.get(profile)
    ]
    comparisons = [
        paired_comparison(str(pair["candidate"]), str(pair["baseline"]), task_map)
        for pair in manifest.get("comparisons") or []
    ]
    return {
        "schema": "codexzero-terminal-bench-metrics-audit-v1",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "eligible_tasks": eligible_tasks,
        "excluded_tasks": sorted(excluded),
        "source_cell_counts": source_counts,
        "unique_profile_task_cells": len(unique),
        "profiles": profiles,
        "paired_comparisons": comparisons,
        "task_cells": sorted(unique.values(), key=lambda row: (row["profile"], row["task"])),
        "methodology": {
            "selection": "accepted trial pointers in each Harbor controller checkpoint",
            "pass": "verifier reward > 0; terminal failures stay in denominator",
            "confidence_interval": "two-sided 95% Wilson score interval",
            "cost_and_tokens": "sum only cells with provider usage; missing usage is counted separately",
            "tokens": "input includes cached input; total tokens = input + output",
            "latency": "trial and agent-execution intervals from Harbor result timestamps",
            "paired_significance": "two-sided exact McNemar/binomial test on discordant pass outcomes",
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, default=DEFAULT_MANIFEST)
    parser.add_argument("--json-out", type=Path, default=DEFAULT_JSON)
    parser.add_argument("--markdown-out", type=Path, default=DEFAULT_MD)
    args = parser.parse_args()
    report = build_report(load_json(args.manifest))
    args.json_out.parent.mkdir(parents=True, exist_ok=True)
    args.markdown_out.parent.mkdir(parents=True, exist_ok=True)
    args.json_out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    args.markdown_out.write_text(markdown_report(report), encoding="utf-8")
    print(f"wrote {args.json_out}")
    print(f"wrote {args.markdown_out}")
    print(f"profiles={len(report['profiles'])} cells={report['unique_profile_task_cells']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
