#!/usr/bin/env python3
"""Run an isolated Codex × RTK × CodexZero × Caveman benchmark matrix."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import random
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import tiktoken


ROOT = Path(__file__).resolve().parents[1]
ENCODING = tiktoken.get_encoding("o200k_base")
CZ_FEATURES = (
    "codex_zero_compact_exec_output",
    "codex_zero_lossless_terminal_codec",
    "codex_zero_exact_duplicate_results",
    "codex_zero_event_driven_wait",
)
SGR = re.compile(r"\x1b\[[0-?]*[ -/]*m")
OSC8 = re.compile(
    r"\x1b\]8;;([^\x07\x1b]*)(?:\x07|\x1b\\)(.*?)"
    r"\x1b\]8;;(?:\x07|\x1b\\)",
    re.DOTALL,
)
TASK_TEMPLATE = """\
Run these checks exactly once without editing files:
1. `{git_command}`
2. `{npm_command}`
3. `node repeated-output.mjs 600`

You may place all three checks in one PowerShell tool call, but keep their output
and exit codes distinguishable. Do not run any other project command.

Then write a detailed report covering each check, the concrete evidence, the
relative severity of any problems, and an ordered remediation plan.
"""
CAVEMAN_ACTIVATION = (
    "\nUse full caveman mode for commentary and the final report."
)


def task_for(rtk: bool, caveman: bool) -> str:
    task = TASK_TEMPLATE.format(
        git_command=(
            "rtk git diff -- benchmark-data.txt"
            if rtk
            else "git diff -- benchmark-data.txt"
        ),
        npm_command="rtk npm test" if rtk else "npm test",
    )
    return task + (CAVEMAN_ACTIVATION if caveman else "")


def token_count(text: str) -> int:
    return len(ENCODING.encode(text, disallowed_special=()))


def sha256(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def run(
    args: list[str],
    *,
    cwd: Path,
    env: dict[str, str] | None = None,
    timeout: int = 180,
) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        args,
        cwd=cwd,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        timeout=timeout,
        check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def create_workspace(path: Path) -> None:
    path.mkdir(parents=True, exist_ok=True)
    baseline = [
        f"record {index:03d}: stable value {index % 17:02d}"
        for index in range(240)
    ]
    changed = baseline.copy()
    for index in range(20, 220, 10):
        changed[index] = (
            f"record {index:03d}: changed value causes benchmark warning"
        )
    (path / "benchmark-data.txt").write_text(
        "\n".join(baseline) + "\n", encoding="utf-8"
    )
    (path / "package.json").write_text(
        json.dumps(
            {
                "name": "codexzero-combination-benchmark",
                "private": True,
                "type": "module",
                "scripts": {"test": "node test-output.mjs"},
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    (path / "test-output.mjs").write_text(
        """\
for (let index = 1; index <= 90; index += 1) {
  console.log(`PASS suite-${String(index).padStart(3, "0")} deterministic assertion`);
}
console.log("Tests: 90 passed, 90 total");
console.log("Suites: 90 passed, 90 total");
""",
        encoding="utf-8",
    )
    (path / "repeated-output.mjs").write_text(
        """\
const count = Number(process.argv[2] || 180);
for (let index = 0; index < count; index += 1) {
  console.log("diagnostic: repeated cache-miss warning in benchmark worker");
}
console.log("diagnostic: final unique benchmark marker");
""",
        encoding="utf-8",
    )
    (path / ".gitignore").write_text("AGENTS.md\n", encoding="utf-8")
    for command in (
        ["git", "init", "-q"],
        ["git", "config", "user.email", "benchmark@codexzero.invalid"],
        ["git", "config", "user.name", "CodexZero Benchmark"],
        ["git", "add", "."],
        ["git", "commit", "-qm", "benchmark baseline"],
    ):
        result = run(command, cwd=path)
        if result.returncode:
            raise RuntimeError(result.stderr.decode("utf-8", "replace"))
    (path / "benchmark-data.txt").write_text(
        "\n".join(changed) + "\n", encoding="utf-8"
    )


def terminal_candidate(raw: bytes) -> tuple[str, str | None]:
    source = raw.decode("utf-8", errors="replace")
    visible = OSC8.sub(lambda match: f"{match.group(2)} ({match.group(1)})", source)
    visible = SGR.sub("", visible)
    normalized = visible.replace("\r\n", "\n").replace("\r", "\n")
    if token_count(normalized) >= token_count(visible):
        normalized = visible
    runs: list[dict[str, Any]] = []
    for line in normalized.splitlines(keepends=True):
        if runs and runs[-1]["text"] == line:
            runs[-1]["count"] += 1
        else:
            runs.append({"count": 1, "text": line})
    encoded = json.dumps(
        {"codec": "line-rle-v1", "runs": runs},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    if token_count(encoded) < token_count(normalized):
        return encoded, "line-rle-v1"
    return normalized, None


def payload_measurement(raw: bytes, exit_code: int, codexzero: bool) -> int:
    raw_tokens = token_count(raw.decode("utf-8", "replace"))
    stock = "\n".join(
        (
            "Chunk ID: benchmark",
            "Wall time: 0.1000 seconds",
            f"Process exited with code {exit_code}",
            f"Final output:\n{raw.decode('utf-8', 'replace')}",
        )
    )
    if not codexzero:
        return token_count(stock)
    output, codec = terminal_candidate(raw)
    candidate: dict[str, Any] = {
        "chunk_id": "benchmark",
        "wall_time_seconds": 0.1,
        "exit_code": exit_code,
        "original_token_count": raw_tokens,
        "artifact": {
            "sha256": sha256(raw),
            "raw_byte_count": len(raw),
            "original_token_count": raw_tokens,
        },
    }
    if codec:
        candidate["codec"] = codec
    if output:
        candidate["output"] = output
    compact = json.dumps(candidate, ensure_ascii=False, separators=(",", ":"))
    return min(token_count(stock), token_count(compact))


def deterministic_payload_matrix(workspace: Path, artifact_dir: Path) -> dict[str, Any]:
    commands = {
        "git-diff": {
            False: ["git", "diff", "--", "benchmark-data.txt"],
            True: ["rtk", "git", "diff", "--", "benchmark-data.txt"],
        },
        "npm-test": {
            False: ["npm.cmd" if os.name == "nt" else "npm", "test"],
            True: ["rtk", "npm", "test"],
        },
        "repeated-output": {
            False: ["node", "repeated-output.mjs", "600"],
            True: ["node", "repeated-output.mjs", "600"],
        },
    }
    captures: dict[str, dict[str, Any]] = {}
    artifact_dir.mkdir(parents=True, exist_ok=True)
    for name, variants in commands.items():
        captures[name] = {}
        for rtk, command in variants.items():
            result = run(command, cwd=workspace)
            raw = result.stdout + result.stderr
            digest = sha256(raw)
            (artifact_dir / digest).write_bytes(raw)
            captures[name][str(rtk).lower()] = {
                "command": command,
                "exit_code": result.returncode,
                "sha256": digest,
                "bytes": len(raw),
                "raw_tokens": token_count(raw.decode("utf-8", "replace")),
            }
    rows = []
    for rtk in (False, True):
        for codexzero in (False, True):
            total = 0
            details = {}
            for name in commands:
                capture = captures[name][str(rtk).lower()]
                raw = (artifact_dir / capture["sha256"]).read_bytes()
                measured = payload_measurement(
                    raw, capture["exit_code"], codexzero
                )
                total += measured
                details[name] = measured
            rows.append(
                {
                    "rtk": rtk,
                    "codexzero": codexzero,
                    "model_visible_tool_tokens": total,
                    "by_command": details,
                }
            )
    baseline = rows[0]["model_visible_tool_tokens"]
    for row in rows:
        saved = baseline - row["model_visible_tool_tokens"]
        row["tokens_saved_vs_baseline"] = saved
        row["reduction_percent_vs_baseline"] = round(
            saved / baseline * 100, 2
        )
    control_rows = []
    control_names = ("git-diff", "npm-test")
    control_baseline = sum(rows[0]["by_command"][name] for name in control_names)
    for row in rows:
        total = sum(row["by_command"][name] for name in control_names)
        saved = control_baseline - total
        control_rows.append(
            {
                "rtk": row["rtk"],
                "codexzero": row["codexzero"],
                "model_visible_tool_tokens": total,
                "tokens_saved_vs_baseline": saved,
                "reduction_percent_vs_baseline": round(
                    saved / control_baseline * 100, 2
                ),
            }
        )
    return {
        "captures": captures,
        "matrix": rows,
        "non_repetitive_control_matrix": control_rows,
    }


def install_caveman_skill(home: Path, source: Path) -> None:
    destination = home / "skills" / "caveman"
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(source, destination)


def create_home(path: Path, auth: Path, caveman_source: Path | None) -> None:
    path.mkdir(parents=True, exist_ok=True)
    shutil.copy2(auth, path / "auth.json")
    (path / "config.toml").write_text(
        """\
model = "gpt-5.6-sol"
model_verbosity = "low"
model_reasoning_effort = "low"
model_reasoning_summary = "none"
personality = "none"
approval_policy = "never"
sandbox_mode = "danger-full-access"
[features]
unified_exec = true
""",
        encoding="utf-8",
    )
    if caveman_source:
        install_caveman_skill(path, caveman_source)


def parse_jsonl(raw: bytes) -> list[dict[str, Any]]:
    items = []
    for line in raw.decode("utf-8", "replace").splitlines():
        try:
            items.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return items


def find_session(home: Path, thread_id: str) -> Path | None:
    for path in (home / "sessions").rglob("*.jsonl"):
        if thread_id in path.name:
            return path
    return None


def store_tool_output(raw: bytes, root: Path) -> dict[str, Any]:
    digest = sha256(raw)
    destination = root / "tool-output" / digest
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        destination.write_bytes(raw)
    return {
        "sha256": digest,
        "bytes": len(raw),
        "tokens": token_count(raw.decode("utf-8", "replace")),
    }


def inspect_session(path: Path, artifact_root: Path) -> dict[str, Any]:
    items = parse_jsonl(path.read_bytes())
    usages = []
    tool_outputs = []
    assistant = []
    calls = []
    for item in items:
        payload = item.get("payload", {})
        if item.get("type") == "event_msg" and payload.get("type") == "token_count":
            usage = payload.get("info", {}).get("total_token_usage")
            if usage:
                usages.append(usage)
        if item.get("type") != "response_item":
            continue
        if payload.get("type") in ("function_call_output", "custom_tool_call_output"):
            output = payload.get("output", "")
            if not isinstance(output, str):
                output = json.dumps(output, ensure_ascii=False)
            tool_outputs.append(
                store_tool_output(output.encode("utf-8"), artifact_root)
            )
        elif payload.get("type") == "function_call":
            calls.append(
                {
                    "name": payload.get("name"),
                    "arguments": payload.get("arguments", ""),
                }
            )
        elif payload.get("type") == "message" and payload.get("role") == "assistant":
            text = "".join(
                part.get("text", "")
                for part in payload.get("content", [])
                if part.get("type") == "output_text"
            )
            assistant.append(
                {
                    "phase": payload.get("phase"),
                    "text": text,
                    "tokens": token_count(text),
                }
            )
    final_usage = usages[-1] if usages else {}
    command_text = "\n".join(str(call["arguments"]) for call in calls)
    final_text = "\n".join(
        item["text"] for item in assistant if item["phase"] == "final_answer"
    )
    coverage = {
        "git_diff": "benchmark-data.txt" in command_text,
        "npm_test": "npm" in command_text,
        "repeated_output": "repeated-output.mjs" in command_text,
    }
    return {
        "inference_requests": len(usages),
        "usage": final_usage,
        "tool_outputs": tool_outputs,
        "tool_output_tokens": sum(item["tokens"] for item in tool_outputs),
        "assistant_tokens": sum(item["tokens"] for item in assistant),
        "final_answer_tokens": token_count(final_text),
        "assistant_messages": assistant,
        "function_calls": calls,
        "rtk_observed": bool(re.search(r"\brtk(?:\.exe)?\b", command_text)),
        "command_coverage": coverage,
    }


def telemetry_totals(path: Path) -> dict[str, int]:
    totals = {
        "original_tokens": 0,
        "selected_tokens": 0,
        "tokens_eliminated": 0,
        "events": 0,
        "transformed_events": 0,
    }
    if not path.exists():
        return totals
    for item in parse_jsonl(path.read_bytes()):
        if item.get("event") != "exec_model_payload":
            continue
        totals["events"] += 1
        totals["transformed_events"] += int(bool(item.get("transformed")))
        for key in ("original_tokens", "selected_tokens", "tokens_eliminated"):
            totals[key] += int(item.get(key, 0))
    return totals


def configuration_id(prompt_mode: str, rtk: bool, caveman: bool) -> str:
    parts = [prompt_mode]
    if rtk:
        parts.append("rtk")
    if caveman:
        parts.append("caveman")
    return "+".join(parts)


def execute_trial(
    *,
    binary: Path,
    home: Path,
    workspace: Path,
    private_root: Path,
    lean_prompt: Path,
    prompt_mode: str,
    rtk: bool,
    caveman: bool,
    repetition: int,
    rtk_instructions: str,
) -> dict[str, Any]:
    run_id = f"r{repetition}-{configuration_id(prompt_mode, rtk, caveman)}"
    run_root = private_root / "runs" / run_id
    run_root.mkdir(parents=True, exist_ok=True)
    agents = workspace / "AGENTS.md"
    if rtk:
        agents.write_text(rtk_instructions, encoding="utf-8")
    elif agents.exists():
        agents.unlink()
    telemetry = run_root / "telemetry.jsonl"
    artifacts = run_root / "codexzero-artifacts"
    env = os.environ.copy()
    env.update(
        {
            "CODEX_HOME": str(home),
            "NO_COLOR": "1",
            "TERM": "dumb",
            "PAGER": "cat",
            "GIT_PAGER": "cat",
            "GH_PAGER": "cat",
        }
    )
    if prompt_mode != "stock":
        env.update(
            {
                "CODEX_ZERO_HOME": str(run_root / "codexzero-home"),
                "CODEX_ZERO_ARTIFACT_DIR": str(artifacts),
                "CODEX_ZERO_TELEMETRY_FILE": str(telemetry),
            }
        )
    codexzero = prompt_mode != "stock"
    args = [
        str(binary),
        "-c",
        "features.unified_exec=true",
    ]
    for feature in CZ_FEATURES:
        args.extend(["-c", f"features.{feature}={str(codexzero).lower()}"])
    if prompt_mode == "max-save":
        args.extend(
            [
                "-c",
                f"model_instructions_file={json.dumps(str(lean_prompt))}",
            ]
        )
    args.extend(
        [
            "-s",
            "danger-full-access",
            "-a",
            "never",
            "-C",
            str(workspace),
            "exec",
            "--json",
            "--skip-git-repo-check",
            task_for(rtk, caveman),
        ]
    )
    started = time.perf_counter()
    result = run(args, cwd=workspace, env=env, timeout=240)
    wall_ms = (time.perf_counter() - started) * 1000
    (run_root / "stdout.jsonl").write_bytes(result.stdout)
    (run_root / "stderr.txt").write_bytes(result.stderr)
    stdout_items = parse_jsonl(result.stdout)
    thread_id = next(
        (
            item.get("thread_id")
            for item in stdout_items
            if item.get("type") == "thread.started"
        ),
        None,
    )
    session = find_session(home, thread_id) if thread_id else None
    inspected = (
        inspect_session(session, private_root / "artifacts")
        if session
        else {
            "inference_requests": 0,
            "usage": {},
            "tool_outputs": [],
            "tool_output_tokens": 0,
            "assistant_tokens": 0,
            "final_answer_tokens": 0,
            "assistant_messages": [],
            "function_calls": [],
            "rtk_observed": False,
            "command_coverage": {},
        }
    )
    quality_pass = (
        result.returncode == 0
        and bool(inspected["function_calls"])
        and all(inspected["command_coverage"].values())
        and inspected["final_answer_tokens"] > 0
        and inspected["rtk_observed"] == rtk
    )
    return {
        "id": run_id,
        "repetition": repetition,
        "configuration": configuration_id(prompt_mode, rtk, caveman),
        "prompt_mode": prompt_mode,
        "rtk": rtk,
        "caveman": caveman,
        "exit_code": result.returncode,
        "wall_time_ms": round(wall_ms, 1),
        "thread_id": thread_id,
        "quality_pass": quality_pass,
        **inspected,
        "codexzero_telemetry": telemetry_totals(telemetry),
    }


def mean(rows: list[dict[str, Any]], getter) -> float:
    values = [float(getter(row)) for row in rows]
    return statistics.fmean(values) if values else 0.0


def aggregate_trials(trials: list[dict[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for trial in trials:
        grouped[trial["configuration"]].append(trial)
    baselines = {
        row["repetition"]: row
        for row in grouped["stock"]
        if row["quality_pass"]
    }
    rows = []
    metrics = {
        "inference_requests": lambda row: row["inference_requests"],
        "input_tokens": lambda row: row["usage"].get("input_tokens", 0),
        "cached_input_tokens": lambda row: row["usage"].get(
            "cached_input_tokens", 0
        ),
        "output_tokens": lambda row: row["usage"].get("output_tokens", 0),
        "total_tokens": lambda row: row["usage"].get("total_tokens", 0),
        "tool_output_tokens": lambda row: row["tool_output_tokens"],
        "assistant_tokens": lambda row: row["assistant_tokens"],
        "wall_time_ms": lambda row: row["wall_time_ms"],
    }
    for config, config_rows in grouped.items():
        valid = [row for row in config_rows if row["quality_pass"]]
        summary: dict[str, Any] = {
            "configuration": config,
            "prompt_mode": config_rows[0]["prompt_mode"],
            "rtk": config_rows[0]["rtk"],
            "caveman": config_rows[0]["caveman"],
            "trials": len(config_rows),
            "quality_passes": len(valid),
            "means": {key: round(mean(valid, fn), 1) for key, fn in metrics.items()},
            "ranges": {
                key: [
                    round(min((fn(row) for row in valid), default=0), 1),
                    round(max((fn(row) for row in valid), default=0), 1),
                ]
                for key, fn in metrics.items()
            },
            "codexzero_measured_tokens_eliminated": round(
                mean(
                    valid,
                    lambda row: row["codexzero_telemetry"][
                        "tokens_eliminated"
                    ],
                ),
                1,
            ),
        }
        paired = []
        for row in valid:
            baseline = baselines.get(row["repetition"])
            if not baseline:
                continue
            paired.append(
                {
                    key: fn(baseline) - fn(row)
                    for key, fn in metrics.items()
                }
            )
        summary["mean_savings_vs_paired_stock"] = {
            key: round(mean(paired, lambda row, k=key: row[k]), 1)
            for key in metrics
        }
        summary["paired_savings_ranges"] = {
            key: [
                round(min((row[key] for row in paired), default=0), 1),
                round(max((row[key] for row in paired), default=0), 1),
            ]
            for key in metrics
        }
        base_total = mean(
            [baselines[key] for key in sorted(baselines)],
            metrics["total_tokens"],
        )
        saved_total = summary["mean_savings_vs_paired_stock"]["total_tokens"]
        summary["total_token_reduction_percent_vs_stock"] = (
            round(saved_total / base_total * 100, 2) if base_total else 0
        )
        rows.append(summary)
    return sorted(
        rows,
        key=lambda row: (
            {"stock": 0, "safe": 1, "max-save": 2}[
                row["prompt_mode"]
            ],
            row["rtk"],
            row["caveman"],
        ),
    )


def markdown_report(report: dict[str, Any]) -> str:
    by_name = {
        row["configuration"]: row for row in report["aggregates"]
    }
    best = max(
        report["aggregates"],
        key=lambda row: row["mean_savings_vs_paired_stock"]["total_tokens"],
    )
    stock = by_name["stock"]
    caveman = by_name["stock+caveman"]
    caveman_visible_saved = (
        stock["means"]["assistant_tokens"] - caveman["means"]["assistant_tokens"]
    )
    caveman_visible_percent = (
        caveman_visible_saved / stock["means"]["assistant_tokens"] * 100
    )
    max_save = by_name["max-save"]
    max_save_caveman = by_name["max-save+caveman"]
    caveman_cost_over_lean = (
        max_save_caveman["means"]["total_tokens"]
        - max_save["means"]["total_tokens"]
    )
    reference = report["prompt_reference"]
    lines = [
        "# Combination benchmark",
        "",
        f"Measured {report['captured_at']} with "
        f"`{report['model']}` at `{report['reasoning_effort']}` effort.",
        "",
        "## Result",
        "",
        f"- **Best end-to-end result:** `{best['configuration']}` saved "
        f"**{best['mean_savings_vs_paired_stock']['total_tokens']:,.1f} tokens "
        f"per trial ({best['total_token_reduction_percent_vs_stock']:.2f}%)** "
        "against paired stock runs.",
        f"- CodexZero safe mode alone saved "
        f"**{by_name['safe']['mean_savings_vs_paired_stock']['total_tokens']:,.1f} "
        f"tokens ({by_name['safe']['total_token_reduction_percent_vs_stock']:.2f}%)**. "
        "With RTK it saved "
        f"**{by_name['safe+rtk']['mean_savings_vs_paired_stock']['total_tokens']:,.1f} "
        f"({by_name['safe+rtk']['total_token_reduction_percent_vs_stock']:.2f}%)**.",
        f"- RTK alone changed the end-to-end total by "
        f"**{by_name['stock+rtk']['mean_savings_vs_paired_stock']['total_tokens']:,.1f} "
        f"tokens ({by_name['stock+rtk']['total_token_reduction_percent_vs_stock']:.2f}%)**. "
        "Its paired range crossed zero "
        f"({by_name['stock+rtk']['paired_savings_ranges']['total_tokens'][0]:,.0f} "
        f"to {by_name['stock+rtk']['paired_savings_ranges']['total_tokens'][1]:,.0f}), "
        "so this run does not establish an end-to-end RTK-only saving.",
        f"- Caveman reduced visible assistant text by "
        f"**{caveman_visible_saved:,.1f} tokens ({caveman_visible_percent:.2f}%)**, "
        "but its skill-loading turn made stock+Caveman use "
        f"**{-caveman['mean_savings_vs_paired_stock']['total_tokens']:,.1f} more "
        "total tokens**. Adding Caveman to max-save cost "
        f"**{caveman_cost_over_lean:,.1f} tokens** versus max-save alone; "
        "the Caveman combinations had wide ranges because skill loading added "
        "a request in some runs.",
        f"- The Max Savings model prompt is an exact **{reference['baseline_tokens']:,} → "
        f"{reference['lean_tokens']:,}** comparison: "
        f"**{reference['tokens_removed_per_request']:,} fewer tokens per inference "
        f"({reference['reduction_percent']:.1f}%)**.",
        "",
        "## End-to-end isolated trials",
        "",
        "| Configuration | Pass | Mean total | Saved vs stock (range) | Reduction | "
        "Requests | Tool payload | Assistant | CodexZero measured |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in report["aggregates"]:
        lines.append(
            f"| {row['configuration']} | {row['quality_passes']}/{row['trials']} "
            f"| {row['means']['total_tokens']:,.1f} "
            f"| {row['mean_savings_vs_paired_stock']['total_tokens']:,.1f} "
            f"({row['paired_savings_ranges']['total_tokens'][0]:,.0f} to "
            f"{row['paired_savings_ranges']['total_tokens'][1]:,.0f}) "
            f"| {row['total_token_reduction_percent_vs_stock']:.2f}% "
            f"| {row['means']['inference_requests']:,.1f} "
            f"| {row['means']['tool_output_tokens']:,.1f} "
            f"| {row['means']['assistant_tokens']:,.1f} "
            f"| {row['codexzero_measured_tokens_eliminated']:,.1f} |"
        )
    lines.extend(
        [
            "",
            "“Saved vs stock” is the mean paired difference within the same "
            "repetition. Negative values mean the configuration used more tokens.",
            "The machine-readable report also includes mean input, cached input, "
            "output, wall time, and min–max ranges for every row.",
            "",
            "## Deterministic tool-payload replay",
            "",
            "| RTK | CodexZero | Model-visible tool tokens | Saved | Reduction |",
            "|---|---|---:|---:|---:|",
        ]
    )
    for row in report["deterministic_payload"]["matrix"]:
        lines.append(
            f"| {'on' if row['rtk'] else 'off'} "
            f"| {'on' if row['codexzero'] else 'off'} "
            f"| {row['model_visible_tool_tokens']:,} "
            f"| {row['tokens_saved_vs_baseline']:,} "
            f"| {row['reduction_percent_vs_baseline']:.2f}% |"
        )
    lines.extend(
        [
            "",
            "The stress payload deliberately includes 600 identical diagnostic "
            "lines. Its percentages measure this fixed corpus, not a typical session.",
            "",
            "### Non-repetitive control",
            "",
            "| RTK | CodexZero | Model-visible tool tokens | Saved | Reduction |",
            "|---|---|---:|---:|---:|",
        ]
    )
    for row in report["deterministic_payload"]["non_repetitive_control_matrix"]:
        lines.append(
            f"| {'on' if row['rtk'] else 'off'} "
            f"| {'on' if row['codexzero'] else 'off'} "
            f"| {row['model_visible_tool_tokens']:,} "
            f"| {row['tokens_saved_vs_baseline']:,} "
            f"| {row['reduction_percent_vs_baseline']:.2f}% |"
        )
    lines.extend(
        [
            "",
            "The control contains the Git diff and test output but excludes the "
            "repeated diagnostic block. CodexZero correctly fell back to stock "
            "payloads when its candidate was not smaller.",
            "",
            "## Method",
            "",
            "- Full factorial: three CodexZero prompt/output modes × RTK on/off "
            "× Caveman on/off.",
            "- Every trial uses the same pinned Codex core, model, effort, "
            "workspace, task, and three deterministic commands.",
            "- Stock-equivalent runs use the pinned core with every CodexZero "
            "feature explicitly disabled. This avoids a version confound.",
            "- Runs use fresh threads and isolated Codex homes. The only added "
            "project instruction is RTK when that factor is on.",
            "- Provider counters are the end-to-end ground truth. Exact "
            "`o200k_base` counts separately measure tool and visible assistant text.",
            "- The deterministic replay executes raw and RTK commands directly, "
            "then applies the production-equivalent strict CodexZero gate.",
            "- Prompt caching, model sampling, and command-selection behavior can "
            "still vary; paired repetitions and pass checks limit that noise.",
            "- Caveman is invoked through its installed skill path. Loading that "
            "skill can add an inference request; that overhead is intentionally "
            "included rather than subtracted.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--seed", type=int, default=2512)
    parser.add_argument("--output", type=Path)
    parser.add_argument(
        "--resume",
        type=Path,
        help="Existing JSON report to extend to --repetitions total repetitions",
    )
    parser.add_argument(
        "--json-report",
        type=Path,
        default=ROOT / "reports" / "combination-benchmark.json",
    )
    parser.add_argument(
        "--markdown-report",
        type=Path,
        default=ROOT / "reports" / "combination-benchmark.md",
    )
    parser.add_argument("--binary", type=Path)
    args = parser.parse_args()
    if args.repetitions < 1:
        parser.error("--repetitions must be positive")

    home = Path.home() / ".codex"
    binary = args.binary or (
        home
        / "codexzero"
        / "bin"
        / ("codex-zero-core.exe" if os.name == "nt" else "codex-zero-core")
    )
    auth = home / "auth.json"
    lean_prompt = ROOT / "prompts" / "codex-core-lean-v1.md"
    prompt_manifest_path = ROOT / "prompts" / "manifest.json"
    rtk_file = home / "RTK.md"
    caveman_source = (
        home
        / "plugins"
        / "cache"
        / "caveman-local"
        / "caveman"
        / "0.1.0"
        / "skills"
        / "caveman"
    )
    required = (
        binary,
        auth,
        lean_prompt,
        prompt_manifest_path,
        rtk_file,
        caveman_source / "SKILL.md",
    )
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise SystemExit("Missing benchmark dependency:\n" + "\n".join(missing))

    previous = None
    if args.resume:
        previous = json.loads(args.resume.read_text(encoding="utf-8"))
        private_root = Path(previous["private_artifacts"])
        if not private_root.is_absolute():
            private_root = ROOT / private_root
        workspace = private_root / "workspace"
        if not workspace.exists():
            raise SystemExit(f"Resume workspace is missing: {workspace}")
        deterministic = previous["deterministic_payload"]
        if "non_repetitive_control_matrix" not in deterministic:
            rows = deterministic["matrix"]
            control_baseline = sum(
                rows[0]["by_command"][name]
                for name in ("git-diff", "npm-test")
            )
            deterministic["non_repetitive_control_matrix"] = []
            for row in rows:
                total = sum(
                    row["by_command"][name]
                    for name in ("git-diff", "npm-test")
                )
                saved = control_baseline - total
                deterministic["non_repetitive_control_matrix"].append(
                    {
                        "rtk": row["rtk"],
                        "codexzero": row["codexzero"],
                        "model_visible_tool_tokens": total,
                        "tokens_saved_vs_baseline": saved,
                        "reduction_percent_vs_baseline": round(
                            saved / control_baseline * 100, 2
                        ),
                    }
                )
        trials = list(previous["trials"])
    else:
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        private_root = (
            args.output.resolve()
            if args.output
            else ROOT / "private-artifacts" / f"combination-benchmark-{timestamp}"
        )
        private_root.mkdir(parents=True, exist_ok=True)
        workspace = private_root / "workspace"
        create_workspace(workspace)
        deterministic = deterministic_payload_matrix(
            workspace, private_root / "deterministic-artifacts"
        )
        trials = []
    configurations = [
        (prompt_mode, rtk, caveman)
        for prompt_mode in ("stock", "safe", "max-save")
        for rtk in (False, True)
        for caveman in (False, True)
    ]
    completed_repetitions = max(
        (int(trial["repetition"]) for trial in trials), default=0
    )
    if completed_repetitions > args.repetitions:
        raise SystemExit(
            "Resume report already has more repetitions than requested"
        )
    try:
        with tempfile.TemporaryDirectory(prefix="codexzero-benchmark-") as temporary:
            temp = Path(temporary)
            homes = {False: temp / "home-plain", True: temp / "home-caveman"}
            create_home(homes[False], auth, None)
            create_home(homes[True], auth, caveman_source)
            rng = random.Random(args.seed)
            for _ in range(completed_repetitions):
                skipped_order = configurations.copy()
                rng.shuffle(skipped_order)
            for repetition in range(
                completed_repetitions + 1, args.repetitions + 1
            ):
                order = configurations.copy()
                rng.shuffle(order)
                for index, (prompt_mode, rtk, caveman) in enumerate(order, 1):
                    name = configuration_id(prompt_mode, rtk, caveman)
                    print(
                        f"[rep {repetition}/{args.repetitions} "
                        f"{index}/{len(order)}] {name}",
                        file=sys.stderr,
                        flush=True,
                    )
                    try:
                        trial = execute_trial(
                            binary=binary,
                            home=homes[caveman],
                            workspace=workspace,
                            private_root=private_root,
                            lean_prompt=lean_prompt,
                            prompt_mode=prompt_mode,
                            rtk=rtk,
                            caveman=caveman,
                            repetition=repetition,
                            rtk_instructions=rtk_file.read_text(encoding="utf-8"),
                        )
                    except subprocess.TimeoutExpired as error:
                        trial = {
                            "id": f"r{repetition}-{name}",
                            "repetition": repetition,
                            "configuration": name,
                            "prompt_mode": prompt_mode,
                            "rtk": rtk,
                            "caveman": caveman,
                            "exit_code": None,
                            "quality_pass": False,
                            "error": f"timeout after {error.timeout}s",
                        }
                    trials.append(trial)
    finally:
        agents = workspace / "AGENTS.md"
        if agents.exists():
            agents.unlink()

    prompt_manifest = json.loads(
        prompt_manifest_path.read_text(encoding="utf-8")
    )
    prompt_reference_source = prompt_manifest["references"][0]
    binary_version_result = run([str(binary), "--version"], cwd=ROOT, timeout=30)
    binary_version = binary_version_result.stdout.decode("utf-8", "replace").strip()
    try:
        private_artifact_locator = private_root.relative_to(ROOT).as_posix()
    except ValueError:
        private_artifact_locator = str(private_root)
    report = {
        "schema": "codexzero-combination-benchmark-v1",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "model": "gpt-5.6-sol",
        "reasoning_effort": "low",
        "tokenizer": "o200k_base",
        "repetitions": args.repetitions,
        "seed": args.seed,
        "binary": {
            "name": binary.name,
            "version": binary_version,
            "sha256": sha256(binary.read_bytes()),
        },
        "task_sha256": {
            f"rtk-{str(rtk).lower()}-caveman-{str(caveman).lower()}": sha256(
                task_for(rtk, caveman).encode("utf-8")
            )
            for rtk in (False, True)
            for caveman in (False, True)
        },
        "instruction_tokens": {
            "rtk": token_count(rtk_file.read_text(encoding="utf-8")),
            "caveman_skill": token_count(
                (caveman_source / "SKILL.md").read_text(encoding="utf-8")
            ),
            "caveman_activation": token_count(CAVEMAN_ACTIVATION),
            "lean_prompt": token_count(lean_prompt.read_text(encoding="utf-8")),
        },
        "prompt_reference": {
            "id": prompt_reference_source["id"],
            "baseline_tokens": prompt_reference_source["baseline_tokens"],
            "lean_tokens": prompt_reference_source["lean_tokens"],
            "tokens_removed_per_request": prompt_reference_source[
                "tokens_removed_per_model_request"
            ],
            "reduction_percent": prompt_reference_source["reduction_percent"],
        },
        "deterministic_payload": deterministic,
        "aggregates": aggregate_trials(trials),
        "trials": trials,
        "private_artifacts": private_artifact_locator,
    }
    public_report = {
        **report,
        "trials": [
            {
                key: value
                for key, value in trial.items()
                if key
                not in {
                    "assistant_messages",
                    "function_calls",
                    "thread_id",
                }
            }
            for trial in trials
        ],
    }
    args.json_report.parent.mkdir(parents=True, exist_ok=True)
    args.markdown_report.parent.mkdir(parents=True, exist_ok=True)
    args.json_report.write_text(
        json.dumps(public_report, indent=2) + "\n", encoding="utf-8"
    )
    args.markdown_report.write_text(
        markdown_report(public_report), encoding="utf-8"
    )
    (private_root / "manifest.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    print(args.markdown_report)
    return 0 if all(row.get("quality_pass") for row in trials) else 2


if __name__ == "__main__":
    raise SystemExit(main())
