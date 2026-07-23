#!/usr/bin/env python3
"""Aggregate Codex usage metadata without retaining conversation content."""

from __future__ import annotations

import argparse
import datetime as dt
import json
from pathlib import Path
from typing import Any


TOKEN_FIELDS = (
    "input_tokens",
    "cached_input_tokens",
    "cache_write_input_tokens",
    "output_tokens",
    "reasoning_output_tokens",
    "total_tokens",
)


def parse_timestamp(value: Any) -> dt.datetime | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed.astimezone(dt.timezone.utc)


def session_summary(path: Path) -> dict[str, Any] | None:
    timestamp = None
    last_usage = None
    token_events = 0
    tool_results = 0

    try:
        handle = path.open("r", encoding="utf-8", errors="replace")
    except OSError:
        return None

    with handle:
        for line in handle:
            try:
                item = json.loads(line)
            except json.JSONDecodeError:
                continue

            item_timestamp = parse_timestamp(item.get("timestamp"))
            if item_timestamp and (timestamp is None or item_timestamp > timestamp):
                timestamp = item_timestamp

            payload = item.get("payload")
            if not isinstance(payload, dict):
                continue

            if item.get("type") == "event_msg" and payload.get("type") == "token_count":
                token_events += 1
                info = payload.get("info")
                usage = info.get("total_token_usage") if isinstance(info, dict) else None
                if isinstance(usage, dict):
                    last_usage = {
                        field: int(usage.get(field, 0) or 0) for field in TOKEN_FIELDS
                    }
            elif (
                item.get("type") == "response_item"
                and payload.get("type") in {"function_call_output", "custom_tool_call_output"}
            ):
                tool_results += 1

    if timestamp is None or last_usage is None:
        return None

    last_usage["uncached_input_tokens"] = max(
        0,
        last_usage["input_tokens"]
        - last_usage["cached_input_tokens"]
        - last_usage["cache_write_input_tokens"],
    )
    return {
        "timestamp": timestamp,
        "usage": last_usage,
        "token_events": token_events,
        "tool_results": tool_results,
    }


def aggregate(sessions: list[dict[str, Any]]) -> dict[str, int | float]:
    totals: dict[str, int | float] = {
        "sessions": len(sessions),
        "token_count_events": 0,
        "tool_results": 0,
    }
    for field in (*TOKEN_FIELDS, "uncached_input_tokens"):
        totals[field] = 0

    for session in sessions:
        totals["token_count_events"] += session["token_events"]
        totals["tool_results"] += session["tool_results"]
        for field in (*TOKEN_FIELDS, "uncached_input_tokens"):
            totals[field] += session["usage"][field]

    input_tokens = int(totals["input_tokens"])
    totals["cached_input_percent"] = (
        round(100 * int(totals["cached_input_tokens"]) / input_tokens, 2)
        if input_tokens
        else 0.0
    )
    return totals


def observed_savings(path: Path) -> dict[str, int | float]:
    result: dict[str, int | float] = {
        "payloads_evaluated": 0,
        "payloads_transformed": 0,
        "tokens_before": 0,
        "tokens_after": 0,
        "tokens_eliminated": 0,
        "average_tokens_eliminated_per_transform": 0.0,
    }
    if not path.exists():
        return result

    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            item = json.loads(line)
        except json.JSONDecodeError:
            continue
        if item.get("schema") != "codex-zero-telemetry-v1":
            continue
        if "original_tokens" not in item or "selected_tokens" not in item:
            continue
        result["payloads_evaluated"] += 1
        result["tokens_before"] += int(item["original_tokens"])
        result["tokens_after"] += int(item["selected_tokens"])
        if item.get("transformed"):
            result["payloads_transformed"] += 1
            result["tokens_eliminated"] += int(item.get("tokens_eliminated", 0))

    transformed = int(result["payloads_transformed"])
    if transformed:
        result["average_tokens_eliminated_per_transform"] = round(
            int(result["tokens_eliminated"]) / transformed, 2
        )
    return result


def projection(
    period: dict[str, int | float], observed: dict[str, int | float], source_days: int
) -> dict[str, Any]:
    sample = float(observed["average_tokens_eliminated_per_transform"])
    daily_tool_results = int(period["tool_results"]) / source_days if source_days else 0
    horizons = {"week": 7, "month": 30, "year": 365}
    scenarios = []

    for label, eligible_fraction in (("low", 0.01), ("base", 0.05), ("high", 0.10)):
        projected = {}
        for horizon, days in horizons.items():
            projected[horizon] = round(
                daily_tool_results * days * eligible_fraction * sample
            )
        scenarios.append(
            {
                "name": label,
                "eligible_tool_result_percent": eligible_fraction * 100,
                "projected_model_visible_tokens_eliminated": projected,
            }
        )

    return {
        "method": (
            "Scenario projection: historical tool-result rate multiplied by an assumed "
            "eligible share and the observed average saving per transformed payload."
        ),
        "source_period_days": source_days,
        "historical_tool_results_per_day": round(daily_tool_results, 2),
        "observed_sample_transforms": int(observed["payloads_transformed"]),
        "observed_tokens_eliminated_per_transform": sample,
        "scenarios": scenarios,
        "rate_limit_note": (
            "Codex plan limits are not published as a token conversion. These are input-token "
            "scenarios, not guaranteed requests, dollars, or rate-limit capacity."
        ),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--sessions",
        type=Path,
        default=Path.home() / ".codex" / "sessions",
    )
    parser.add_argument(
        "--telemetry",
        type=Path,
        default=Path.home() / ".codex" / "codexzero" / "telemetry.jsonl",
    )
    parser.add_argument(
        "--output",
        type=Path,
        default=Path("reports/past-usage-summary.json"),
    )
    args = parser.parse_args()

    now = dt.datetime.now(dt.timezone.utc)
    sessions = [
        summary
        for path in args.sessions.rglob("*.jsonl")
        if (summary := session_summary(path)) is not None
    ]

    periods: dict[str, dict[str, int | float]] = {}
    for days in (7, 30, 90):
        cutoff = now - dt.timedelta(days=days)
        periods[f"{days}_days"] = aggregate(
            [session for session in sessions if session["timestamp"] >= cutoff]
        )
    periods["all_time"] = aggregate(sessions)

    observed = observed_savings(args.telemetry)
    report = {
        "schema": "codex-zero-past-usage-v1",
        "generated_at": now.isoformat(),
        "privacy": (
            "Derived from timestamps, cumulative token counters, event types, and CodexZero "
            "telemetry counters. No prompts, tool output, file paths, or conversation text retained."
        ),
        "measurement_notes": {
            "token_count_events": (
                "Recorded token-count events. They are not labeled inference requests because "
                "the local log schema does not guarantee that equivalence."
            ),
            "session_totals": (
                "Latest cumulative total per session, preventing cumulative events from being "
                "double-counted."
            ),
        },
        "periods": periods,
        "observed_codexzero": observed,
        "future_projection": projection(periods["30_days"], observed, 30),
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "sessions": len(sessions)}))


if __name__ == "__main__":
    main()
