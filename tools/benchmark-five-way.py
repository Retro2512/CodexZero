#!/usr/bin/env python3
"""Five-way, isolated Codex token/cache/quality benchmark."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import math
import os
import platform
import random
import re
import shutil
import sqlite3
import statistics
import subprocess
import sys
import tempfile
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import tiktoken


ROOT = Path(__file__).resolve().parents[1]
TOKENIZER = "o200k_base"
ENCODING = tiktoken.get_encoding(TOKENIZER)
MODEL = "gpt-5.6-sol"
EFFORT = "medium"
STOCK_PACKAGE = "@openai/codex"
STOCK_PACKAGE_VERSION = "0.145.0-alpha.30-win32-x64"
STOCK_PACKAGE_INTEGRITY = (
    "sha512-kFTtlwpuXKD9rQlQXlf4buNxeC346nBI5q+4Jdjd03jagafahF2uqa4z5tKb"
    "1NixMv3Jds9hx0AjX+kWnFtlKQ=="
)
CZ_FEATURES = (
    "codex_zero_compact_exec_output",
    "codex_zero_lossless_terminal_codec",
    "codex_zero_exact_duplicate_results",
    "codex_zero_event_driven_wait",
)
CAVEMAN_ACTIVATION = (
    "\nUse full caveman mode for commentary and the final answer."
)
CONFIGURATIONS = (
    {
        "id": "codex",
        "label": "Codex",
        "binary": "stock",
        "codexzero": False,
        "rtk": False,
        "caveman": False,
    },
    {
        "id": "codexzero",
        "label": "CodexZero",
        "binary": "codexzero",
        "codexzero": True,
        "rtk": False,
        "caveman": False,
    },
    {
        "id": "codex_rtk",
        "label": "Codex + RTK",
        "binary": "stock",
        "codexzero": False,
        "rtk": True,
        "caveman": False,
    },
    {
        "id": "codex_caveman",
        "label": "Codex + Caveman",
        "binary": "stock",
        "codexzero": False,
        "rtk": False,
        "caveman": True,
    },
    {
        "id": "codex_caveman_rtk",
        "label": "Codex + Caveman + RTK",
        "binary": "stock",
        "codexzero": False,
        "rtk": True,
        "caveman": True,
    },
)


def workload(
    identifier: str,
    prompt: str,
    command_patterns: tuple[str, ...],
    outcome: str,
    final_evidence: tuple[str, ...],
    minimum_calls: int = 1,
) -> dict[str, Any]:
    return {
        "id": identifier,
        "prompt": prompt.strip() + "\n",
        "command_patterns": command_patterns,
        "outcome": outcome,
        "final_evidence": final_evidence,
        "minimum_calls": minimum_calls,
    }


WORKLOADS = (
    workload(
        "small_fallback",
        """
Run `node small-output.mjs` once. Do not edit files or run other project
commands. Report its exit code and marker. End with this exact line:
RESULT workload=small_fallback outcome=passed
""",
        ("small-output.mjs",),
        "passed",
        ("SMALL_OK",),
    ),
    workload(
        "repetitive_log",
        """
Run `node repeated-output.mjs 600` once. Preserve and inspect the complete
output. Do not edit files or run other project commands. Report the exit code,
the repetition count, and the final marker. End with this exact line:
RESULT workload=repetitive_log outcome=passed
""",
        ("repeated-output.mjs",),
        "passed",
        ("600", "REPEAT_FINAL"),
    ),
    workload(
        "git_diff",
        """
Inspect the complete diff for `benchmark-data.txt` with the configured
command-line tools. Do not edit files or run other project commands. Report the
number of changed records and the changed-value marker. End with this exact
line:
RESULT workload=git_diff outcome=passed
""",
        ("git", "diff", "benchmark-data.txt"),
        "passed",
        ("20", "benchmark warning"),
    ),
    workload(
        "failing_stack",
        """
Run `node failing-stack.mjs` once and inspect the complete expected failure.
Do not edit files or run other project commands. Report its nonzero exit code,
error marker, and repeated-frame count. End with this exact line:
RESULT workload=failing_stack outcome=expected_failure
""",
        ("failing-stack.mjs",),
        "expected_failure",
        ("BENCHMARK_FAILURE", "120"),
    ),
    workload(
        "code_fix",
        """
Fix the clamp implementation in `lib.mjs`. Make the smallest relevant edit,
then run `npm run test:fix`. Do not change any other tracked file. Report the
test result. End with this exact line:
RESULT workload=code_fix outcome=fixed
""",
        ("lib.mjs", "test:fix"),
        "fixed",
        ("pass",),
        minimum_calls=2,
    ),
    workload(
        "mixed_validation",
        """
Run these as three separate shell tool calls, in order, using configured
command-line tools where applicable:
1. Inspect the diff for `benchmark-data.txt`.
2. Run `npm test`.
3. Run `node repeated-output.mjs 180`.
Do not edit files or run other project commands. Report every exit code, the
test count, changed-record count, and final marker. End with this exact line:
RESULT workload=mixed_validation outcome=passed
""",
        ("git", "diff", "benchmark-data.txt", "npm", "test", "repeated-output.mjs"),
        "passed",
        ("90", "20", "REPEAT_FINAL"),
        minimum_calls=3,
    ),
)


def tokens(text: str) -> int:
    return len(ENCODING.encode(text, disallowed_special=()))


def digest(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def stock_package_provenance(binary: Path) -> dict[str, Any]:
    package_root = binary.parents[3]
    package_json = package_root / "package.json"
    archives = list(package_root.parent.glob("*.tgz"))
    if not package_json.exists() or len(archives) != 1:
        raise SystemExit(
            "Stock binary must come from the retained official npm package"
        )
    metadata = json.loads(package_json.read_text(encoding="utf-8"))
    archive = archives[0]
    raw = archive.read_bytes()
    integrity = (
        "sha512-"
        + base64.b64encode(hashlib.sha512(raw).digest()).decode("ascii")
    )
    verified = (
        metadata.get("name") == STOCK_PACKAGE
        and metadata.get("version") == STOCK_PACKAGE_VERSION
        and integrity == STOCK_PACKAGE_INTEGRITY
    )
    if not verified:
        raise SystemExit("Official stock npm package integrity check failed")
    return {
        "package": metadata["name"],
        "version": metadata["version"],
        "repository": metadata.get("repository"),
        "archive_filename": archive.name,
        "archive_bytes": len(raw),
        "archive_integrity": integrity,
        "registry_integrity_match": True,
    }


def process(
    args: list[str],
    *,
    cwd: Path,
    env: dict[str, str] | None = None,
    timeout: int = 300,
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


def write_template(path: Path) -> dict[str, Any]:
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
    files = {
        "benchmark-data.txt": "\n".join(baseline) + "\n",
        "package.json": json.dumps(
            {
                "name": "codexzero-five-way-benchmark",
                "private": True,
                "type": "module",
                "scripts": {
                    "test": "node test-output.mjs",
                    "test:fix": "node --test code-fix.test.mjs",
                },
            },
            indent=2,
        )
        + "\n",
        "small-output.mjs": (
            'console.log("\\u001b[32mSMALL_OK αβγ\\u001b[0m");\n'
            'console.log("small unique output");\n'
        ),
        "repeated-output.mjs": (
            "const count = Number(process.argv[2] || 600);\n"
            "for (let index = 0; index < count; index += 1) {\n"
            '  console.log("diagnostic: repeated cache-miss warning in benchmark worker");\n'
            "}\n"
            'console.log(`REPEAT_FINAL count=${count}`);\n'
        ),
        "test-output.mjs": (
            "for (let index = 1; index <= 90; index += 1) {\n"
            "  console.log(`PASS suite-${String(index).padStart(3, \"0\")} deterministic assertion`);\n"
            "}\n"
            'console.log("Tests: 90 passed, 90 total");\n'
            'console.log("Suites: 90 passed, 90 total");\n'
        ),
        "failing-stack.mjs": (
            'console.error("BENCHMARK_FAILURE: deterministic fixture");\n'
            "for (let index = 0; index < 120; index += 1) {\n"
            '  console.error("    at repeatedFrame (fixture.mjs:42:17)");\n'
            "}\n"
            'console.error("REPEATED_FRAMES=120");\n'
            "process.exit(1);\n"
        ),
        "lib.mjs": (
            "export function clamp(value, minimum, maximum) {\n"
            "  return Math.max(maximum, Math.min(minimum, value));\n"
            "}\n"
        ),
        "code-fix.test.mjs": (
            'import assert from "node:assert/strict";\n'
            'import test from "node:test";\n'
            'import { clamp } from "./lib.mjs";\n'
            'test("clamp", () => {\n'
            "  assert.equal(clamp(-5, 0, 10), 0);\n"
            "  assert.equal(clamp(5, 0, 10), 5);\n"
            "  assert.equal(clamp(15, 0, 10), 10);\n"
            "});\n"
        ),
        ".gitignore": "AGENTS.md\n",
    }
    for name, content in files.items():
        (path / name).write_text(content, encoding="utf-8")
    for command in (
        ["git", "init", "-q"],
        ["git", "config", "user.email", "benchmark@codexzero.invalid"],
        ["git", "config", "user.name", "CodexZero Benchmark"],
        ["git", "add", "."],
        ["git", "commit", "-qm", "benchmark baseline"],
    ):
        result = process(command, cwd=path)
        if result.returncode:
            raise RuntimeError(result.stderr.decode("utf-8", "replace"))
    (path / "benchmark-data.txt").write_text(
        "\n".join(changed) + "\n", encoding="utf-8"
    )
    manifest = {}
    for file in path.iterdir():
        if file.is_file():
            raw = file.read_bytes()
            manifest[file.name] = {"bytes": len(raw), "sha256": digest(raw)}
    return manifest


def parse_jsonl(raw: bytes) -> list[dict[str, Any]]:
    rows = []
    for line in raw.decode("utf-8", "replace").splitlines():
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return rows


def find_session(home: Path, thread_id: str) -> Path | None:
    for path in (home / "sessions").rglob("*.jsonl"):
        if thread_id in path.name:
            return path
    return None


def store_payload(raw: bytes, root: Path) -> dict[str, Any]:
    sha = digest(raw)
    destination = root / "tool-output" / sha
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not destination.exists():
        destination.write_bytes(raw)
    return {
        "sha256": sha,
        "bytes": len(raw),
        "o200k_tokens": tokens(raw.decode("utf-8", "replace")),
    }


def inspect_session(path: Path, artifact_root: Path) -> dict[str, Any]:
    items = parse_jsonl(path.read_bytes())
    request_usages = []
    assistant_messages = []
    tool_outputs = []
    calls = []
    for item in items:
        payload = item.get("payload", {})
        if item.get("type") == "event_msg" and payload.get("type") == "token_count":
            info = payload.get("info", {})
            last = dict(info.get("last_token_usage") or {})
            if last:
                input_tokens = int(last.get("input_tokens", 0))
                cached = int(last.get("cached_input_tokens", 0))
                last["uncached_input_tokens"] = input_tokens - cached
                last["cache_hit"] = cached > 0
                request_usages.append(last)
        if item.get("type") != "response_item":
            continue
        kind = payload.get("type")
        if kind in ("function_call_output", "custom_tool_call_output"):
            output = payload.get("output", "")
            if not isinstance(output, str):
                output = json.dumps(output, ensure_ascii=False)
            tool_outputs.append(
                store_payload(output.encode("utf-8"), artifact_root)
            )
        elif kind == "function_call":
            arguments = payload.get("arguments", "")
            calls.append(
                {
                    "name": payload.get("name"),
                    "arguments": arguments,
                    "arguments_sha256": digest(str(arguments).encode("utf-8")),
                    "arguments_tokens": tokens(str(arguments)),
                }
            )
        elif kind == "message" and payload.get("role") == "assistant":
            text = "".join(
                part.get("text", "")
                for part in payload.get("content", [])
                if part.get("type") == "output_text"
            )
            assistant_messages.append(
                {
                    "phase": payload.get("phase"),
                    "text": text,
                    "o200k_tokens": tokens(text),
                }
            )
    cumulative = {}
    if request_usages:
        cumulative = {
            key: sum(int(row.get(key, 0)) for row in request_usages)
            for key in (
                "input_tokens",
                "cached_input_tokens",
                "cache_write_input_tokens",
                "uncached_input_tokens",
                "output_tokens",
                "reasoning_output_tokens",
                "total_tokens",
            )
        }
    final_text = "\n".join(
        row["text"]
        for row in assistant_messages
        if row["phase"] == "final_answer"
    )
    command_text = "\n".join(str(row["arguments"]) for row in calls)
    request_count = len(request_usages)
    cache_hits = sum(int(row["cache_hit"]) for row in request_usages)
    return {
        "request_usages": request_usages,
        "usage": cumulative,
        "inference_requests": request_count,
        "cache_hit_requests": cache_hits,
        "cache_miss_requests": request_count - cache_hits,
        "cache_request_hit_rate": cache_hits / request_count if request_count else 0,
        "cache_token_ratio": (
            cumulative.get("cached_input_tokens", 0)
            / cumulative.get("input_tokens", 1)
            if cumulative.get("input_tokens", 0)
            else 0
        ),
        "tool_outputs": tool_outputs,
        "tool_output_tokens": sum(row["o200k_tokens"] for row in tool_outputs),
        "assistant_messages": assistant_messages,
        "assistant_tokens": sum(
            row["o200k_tokens"] for row in assistant_messages
        ),
        "final_answer": final_text,
        "final_answer_tokens": tokens(final_text),
        "calls": calls,
        "call_count": len(calls),
        "call_argument_tokens": sum(row["arguments_tokens"] for row in calls),
        "command_text": command_text,
        "rtk_observed": bool(re.search(r"\brtk(?:\.exe)?\b", command_text)),
    }


def inspect_exec_stdout(raw: bytes) -> dict[str, Any]:
    """Measure the stable public exec stream without exposing command contents."""
    commands = []
    file_changes = []
    for event in parse_jsonl(raw):
        if event.get("type") != "item.completed":
            continue
        item = event.get("item", {})
        kind = item.get("type")
        if kind == "command_execution":
            command = str(item.get("command", ""))
            output = str(item.get("aggregated_output", ""))
            commands.append(
                {
                    "command": command,
                    "command_sha256": digest(command.encode("utf-8")),
                    "command_tokens": tokens(command),
                    "output_sha256": digest(output.encode("utf-8")),
                    "output_bytes": len(output.encode("utf-8")),
                    "output_tokens": tokens(output),
                    "exit_code": item.get("exit_code"),
                    "status": item.get("status"),
                }
            )
        elif kind == "file_change":
            changes = item.get("changes", [])
            serialized = json.dumps(changes, sort_keys=True, ensure_ascii=False)
            file_changes.append(
                {
                    "changes": changes,
                    "changes_sha256": digest(serialized.encode("utf-8")),
                    "change_count": len(changes),
                    "status": item.get("status"),
                }
            )
    command_text = "\n".join(row["command"] for row in commands)
    change_text = "\n".join(
        str(change.get("path", ""))
        for event in file_changes
        for change in event["changes"]
    )
    return {
        "shell_command_executions": len(commands),
        "successful_shell_commands": sum(
            int(row["exit_code"] == 0) for row in commands
        ),
        "failed_shell_commands": sum(
            int(
                isinstance(row["exit_code"], int)
                and row["exit_code"] != 0
            )
            for row in commands
        ),
        "file_change_events": len(file_changes),
        "changed_path_events": sum(
            row["change_count"] for row in file_changes
        ),
        "observed_execution_events": len(commands) + len(file_changes),
        "shell_command_argument_tokens": sum(
            row["command_tokens"] for row in commands
        ),
        "shell_command_output_tokens": sum(
            row["output_tokens"] for row in commands
        ),
        "shell_command_output_bytes": sum(
            row["output_bytes"] for row in commands
        ),
        "command_metadata": [
            {
                key: row[key]
                for key in (
                    "command_sha256",
                    "command_tokens",
                    "output_sha256",
                    "output_bytes",
                    "output_tokens",
                    "exit_code",
                    "status",
                )
            }
            for row in commands
        ],
        "file_change_metadata": [
            {
                key: row[key]
                for key in ("changes_sha256", "change_count", "status")
            }
            for row in file_changes
        ],
        "_command_text": command_text,
        "_change_text": change_text,
        "_rtk_observed": bool(
            re.search(r"\brtk(?:\.exe)?\b", command_text)
        ),
    }


def augment_trials_from_exec_stream(
    trials: list[dict[str, Any]], private_root: Path
) -> None:
    """Rebuild execution metrics and command-coverage gates from raw streams."""
    workloads = {row["id"]: row for row in WORKLOADS}
    for trial in trials:
        raw_path = private_root / "runs" / trial["id"] / "stdout.jsonl"
        if not raw_path.exists():
            continue
        raw_stream = raw_path.read_bytes()
        observed = inspect_exec_stdout(raw_stream)
        trial["raw_exec_stream"] = {
            "sha256": digest(raw_stream),
            "bytes": len(raw_stream),
        }
        stderr_path = private_root / "runs" / trial["id"] / "stderr.txt"
        stderr = stderr_path.read_bytes() if stderr_path.exists() else b""
        trial["raw_stderr"] = {
            "sha256": digest(stderr),
            "bytes": len(stderr),
        }
        trial["rtk"] = read_rtk_db(
            private_root / "runs" / trial["id"] / "rtk.db"
        )
        telemetry = (
            private_root
            / "runs"
            / trial["id"]
            / "codexzero-telemetry.jsonl"
        )
        codexzero_artifacts = (
            private_root
            / "runs"
            / trial["id"]
            / "codexzero-artifacts"
        )
        trial["codexzero"] = read_codexzero_telemetry(
            telemetry, codexzero_artifacts
        )
        command_text = observed.pop("_command_text")
        change_text = observed.pop("_change_text")
        rtk_observed = observed.pop("_rtk_observed")
        trial.update(observed)
        trial["rtk_observed"] = bool(
            trial.get("rtk_observed") or rtk_observed
        )
        workload_row = workloads[trial["workload"]]
        private_path = (
            private_root / "runs" / trial["id"] / "private-trial.json"
        )
        session_command_text = ""
        if private_path.exists():
            try:
                private_trial = json.loads(
                    private_path.read_text(encoding="utf-8")
                )
                session_command_text = str(
                    private_trial.get("command_text", "")
                )
            except (OSError, json.JSONDecodeError):
                pass
        corpus = "\n".join(
            (session_command_text, command_text, change_text)
        ).lower()
        checks = trial.get("quality", {}).get("checks", {})
        checks["minimum_tool_calls"] = max(
            int(trial.get("call_count", 0)),
            int(trial["observed_execution_events"]),
        ) >= int(workload_row["minimum_calls"])
        checks["required_commands_observed"] = all(
            pattern.lower() in corpus
            for pattern in workload_row["command_patterns"]
        )
        trial["quality"] = {
            "passed": bool(checks) and all(checks.values()),
            "checks": checks,
        }


def audit_trials(
    trials: list[dict[str, Any]],
    private_root: Path,
    expected_trials: int,
) -> dict[str, Any]:
    """Fail closed if public counters no longer match retained raw evidence."""
    if len(trials) != expected_trials:
        raise AssertionError(
            f"expected {expected_trials} trials, found {len(trials)}"
        )
    if len({row["id"] for row in trials}) != expected_trials:
        raise AssertionError("trial identifiers are not unique")
    raw_streams = 0
    stderr_streams = 0
    tool_payloads = 0
    cache_identities = 0
    provider_total_identities = 0
    for trial in trials:
        if not trial["quality"]["passed"]:
            raise AssertionError(f"quality failed: {trial['id']}")
        usage = trial["usage"]
        if usage["input_tokens"] != (
            usage["cached_input_tokens"]
            + usage["uncached_input_tokens"]
        ):
            raise AssertionError(f"cache identity failed: {trial['id']}")
        cache_identities += 1
        if usage["total_tokens"] != (
            usage["input_tokens"] + usage["output_tokens"]
        ):
            raise AssertionError(
                f"provider total identity failed: {trial['id']}"
            )
        provider_total_identities += 1
        run_root = private_root / "runs" / trial["id"]
        for filename, key in (
            ("stdout.jsonl", "raw_exec_stream"),
            ("stderr.txt", "raw_stderr"),
        ):
            raw = (run_root / filename).read_bytes()
            metadata = trial[key]
            if (
                digest(raw) != metadata["sha256"]
                or len(raw) != metadata["bytes"]
            ):
                raise AssertionError(
                    f"raw stream hash failed: {trial['id']} {filename}"
                )
            if filename == "stdout.jsonl":
                raw_streams += 1
            else:
                stderr_streams += 1
        if len(trial["command_metadata"]) != trial[
            "shell_command_executions"
        ]:
            raise AssertionError(
                f"command count failed: {trial['id']}"
            )
        for payload in trial["tool_outputs"]:
            raw = (
                private_root
                / "artifacts"
                / "tool-output"
                / payload["sha256"]
            ).read_bytes()
            if (
                digest(raw) != payload["sha256"]
                or len(raw) != payload["bytes"]
                or tokens(raw.decode("utf-8", "replace"))
                != payload["o200k_tokens"]
            ):
                raise AssertionError(
                    f"tool payload hash failed: {trial['id']}"
                )
            tool_payloads += 1
        cz = trial["codexzero"]
        if trial["configuration"] == "codexzero":
            if not (
                cz["events"]
                and cz["monotonic"]
                and cz["artifacts_verified"]
            ):
                raise AssertionError(
                    f"CodexZero evidence failed: {trial['id']}"
                )
        elif cz["events"]:
            raise AssertionError(
                f"unexpected CodexZero event: {trial['id']}"
            )
        if trial["rtk"]["fallback_successes"] > trial["rtk"][
            "parse_failures"
        ]:
            raise AssertionError(
                f"RTK fallback identity failed: {trial['id']}"
            )
    return {
        "status": "passed",
        "unique_trial_ids": expected_trials,
        "quality_passes": expected_trials,
        "cache_input_identities": cache_identities,
        "provider_total_identities": provider_total_identities,
        "raw_exec_streams_rehashed": raw_streams,
        "stderr_streams_rehashed": stderr_streams,
        "tool_payloads_rehashed_and_recounted": tool_payloads,
        "codexzero_artifacts_rehashed": True,
    }


def read_codexzero_telemetry(path: Path, artifact_dir: Path) -> dict[str, Any]:
    totals = {
        "events": 0,
        "transformed_events": 0,
        "original_tokens": 0,
        "selected_tokens": 0,
        "tokens_eliminated": 0,
        "monotonic": True,
        "artifacts_verified": True,
    }
    if not path.exists():
        return totals
    for row in parse_jsonl(path.read_bytes()):
        if row.get("event") != "exec_model_payload":
            continue
        totals["events"] += 1
        totals["transformed_events"] += int(bool(row.get("transformed")))
        original = int(row.get("original_tokens", 0))
        selected = int(row.get("selected_tokens", 0))
        eliminated = int(row.get("tokens_eliminated", 0))
        totals["original_tokens"] += original
        totals["selected_tokens"] += selected
        totals["tokens_eliminated"] += eliminated
        totals["monotonic"] &= selected <= original and eliminated == original - selected
        artifact = artifact_dir / "sha256" / str(row.get("artifact_sha256", ""))
        try:
            raw = artifact.read_bytes()
            totals["artifacts_verified"] &= (
                digest(raw) == row.get("artifact_sha256")
                and len(raw) == int(row.get("raw_byte_count", -1))
            )
        except OSError:
            totals["artifacts_verified"] = False
    return totals


def read_rtk_db(path: Path) -> dict[str, Any]:
    result = {
        "commands": 0,
        "input_tokens": 0,
        "output_tokens": 0,
        "tokens_saved": 0,
        "exec_time_ms": 0,
        "parse_failures": 0,
        "fallback_successes": 0,
        "rows": [],
    }
    if not path.exists():
        return result
    connection = sqlite3.connect(path)
    try:
        columns = (
            "original_cmd,rtk_cmd,input_tokens,output_tokens,saved_tokens,"
            "savings_pct,exec_time_ms"
        )
        for row in connection.execute(f"SELECT {columns} FROM commands ORDER BY id"):
            item = {
                "original_cmd_sha256": digest(str(row[0]).encode("utf-8")),
                "rtk_cmd_sha256": digest(str(row[1]).encode("utf-8")),
                "input_tokens": int(row[2]),
                "output_tokens": int(row[3]),
                "saved_tokens": int(row[4]),
                "savings_pct": float(row[5]),
                "exec_time_ms": int(row[6]),
            }
            result["rows"].append(item)
            result["commands"] += 1
            for source, target in (
                ("input_tokens", "input_tokens"),
                ("output_tokens", "output_tokens"),
                ("saved_tokens", "tokens_saved"),
                ("exec_time_ms", "exec_time_ms"),
            ):
                result[target] += item[source]
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
    return result


def create_home(
    path: Path,
    auth: Path,
    models_cache: Path,
    caveman_source: Path | None,
) -> None:
    path.mkdir(parents=True, exist_ok=True)
    shutil.copy2(auth, path / "auth.json")
    if models_cache.exists():
        shutil.copy2(models_cache, path / "models_cache.json")
    (path / "config.toml").write_text(
        f"""\
model = "{MODEL}"
model_verbosity = "low"
model_reasoning_effort = "{EFFORT}"
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
        destination = path / "skills" / "caveman"
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(caveman_source, destination)


def make_rtk_wrapper(path: Path, rtk_binary: Path, run_root: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    wrapper = path / "rtk.cmd"
    values = {
        "RTK_DB_PATH": run_root / "rtk.db",
        "RTK_AUDIT_DIR": run_root / "rtk-audit",
        "RTK_TEE_DIR": run_root / "rtk-tee",
        "RTK_TELEMETRY_DISABLED": "1",
    }
    lines = ["@echo off"]
    lines.extend(f'set "{key}={value}"' for key, value in values.items())
    lines.append(f'"{rtk_binary}" %*')
    wrapper.write_text("\r\n".join(lines) + "\r\n", encoding="utf-8")
    return wrapper


def validate_trial(
    workload_row: dict[str, Any],
    workspace: Path,
    inspected: dict[str, Any],
    cli_exit: int,
    codexzero: dict[str, Any],
    expects_codexzero: bool,
) -> dict[str, Any]:
    final = inspected["final_answer"]
    command = inspected["command_text"].lower()
    expected_line = (
        f"RESULT workload={workload_row['id']} "
        f"outcome={workload_row['outcome']}"
    )
    checks: dict[str, bool] = {
        "cli_exit_zero": cli_exit == 0,
        "minimum_tool_calls": inspected["call_count"] >= workload_row["minimum_calls"],
        "required_commands_observed": all(
            pattern.lower() in command
            for pattern in workload_row["command_patterns"]
        ),
        "result_line_present": expected_line.lower() in final.lower(),
        "final_evidence_present": all(
            evidence.lower() in final.lower()
            for evidence in workload_row["final_evidence"]
        ),
        "codexzero_monotonic": (
            codexzero["monotonic"] if expects_codexzero else codexzero["events"] == 0
        ),
        "codexzero_artifacts_verified": (
            codexzero["artifacts_verified"]
            if expects_codexzero
            else codexzero["events"] == 0
        ),
    }
    status = process(["git", "status", "--short"], cwd=workspace)
    status_text = status.stdout.decode("utf-8", "replace")
    if workload_row["id"] == "code_fix":
        verification = process(
            ["node", "--test", "code-fix.test.mjs"], cwd=workspace
        )
        checks["external_code_test_passed"] = verification.returncode == 0
        changed = [
            line[3:].strip()
            for line in status_text.splitlines()
            if len(line) >= 4
        ]
        checks["only_expected_files_changed"] = set(changed) == {
            "benchmark-data.txt",
            "lib.mjs",
        }
    else:
        checks["workspace_unchanged"] = status_text.strip() == "M benchmark-data.txt"
    return {"passed": all(checks.values()), "checks": checks}


def run_trial(
    *,
    config: dict[str, Any],
    workload_row: dict[str, Any],
    repetition: int,
    binaries: dict[str, Path],
    homes: dict[str, Path],
    template: Path,
    temporary_root: Path,
    private_root: Path,
    lean_prompt: Path,
    codexzero_mode: str,
    rtk_binary: Path,
    rtk_instructions: str,
) -> dict[str, Any]:
    run_id = f"r{repetition}-{workload_row['id']}-{config['id']}"
    run_root = private_root / "runs" / run_id
    run_root.mkdir(parents=True, exist_ok=True)
    workspace = temporary_root / "workspaces" / run_id
    shutil.copytree(template, workspace)
    if config["rtk"]:
        (workspace / "AGENTS.md").write_text(rtk_instructions, encoding="utf-8")
    wrapper_dir = run_root / "wrapper-bin"
    make_rtk_wrapper(wrapper_dir, rtk_binary, run_root)
    telemetry = run_root / "codexzero-telemetry.jsonl"
    cz_artifacts = run_root / "codexzero-artifacts"
    env = os.environ.copy()
    env.update(
        {
            "CODEX_HOME": str(homes[config["id"]]),
            "PATH": f"{wrapper_dir}{os.pathsep}{env.get('PATH', '')}",
            "NO_COLOR": "1",
            "TERM": "dumb",
            "PAGER": "cat",
            "GIT_PAGER": "cat",
            "GH_PAGER": "cat",
        }
    )
    if config["codexzero"]:
        env.update(
            {
                "CODEX_ZERO_HOME": str(run_root / "codexzero-home"),
                "CODEX_ZERO_ARTIFACT_DIR": str(cz_artifacts),
                "CODEX_ZERO_TELEMETRY_FILE": str(telemetry),
            }
        )
    args = [str(binaries[config["binary"]]), "-c", "features.unified_exec=true"]
    if config["codexzero"]:
        for feature in CZ_FEATURES:
            args.extend(["-c", f"features.{feature}=true"])
    if config["codexzero"] and codexzero_mode == "max-save":
        args.extend(
            [
                "-c",
                f"model_instructions_file={json.dumps(str(lean_prompt))}",
            ]
        )
    prompt = workload_row["prompt"]
    if config["caveman"]:
        prompt += CAVEMAN_ACTIVATION
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
            prompt,
        ]
    )
    started = time.perf_counter()
    result = process(args, cwd=workspace, env=env, timeout=360)
    wall_time_ms = (time.perf_counter() - started) * 1000
    (run_root / "stdout.jsonl").write_bytes(result.stdout)
    (run_root / "stderr.txt").write_bytes(result.stderr)
    events = parse_jsonl(result.stdout)
    exec_observed = inspect_exec_stdout(result.stdout)
    thread_id = next(
        (
            row.get("thread_id")
            for row in events
            if row.get("type") == "thread.started"
        ),
        None,
    )
    session = find_session(homes[config["id"]], thread_id) if thread_id else None
    inspected = (
        inspect_session(session, private_root / "artifacts")
        if session
        else {
            "request_usages": [],
            "usage": {},
            "inference_requests": 0,
            "cache_hit_requests": 0,
            "cache_miss_requests": 0,
            "cache_request_hit_rate": 0,
            "cache_token_ratio": 0,
            "tool_outputs": [],
            "tool_output_tokens": 0,
            "assistant_messages": [],
            "assistant_tokens": 0,
            "final_answer": "",
            "final_answer_tokens": 0,
            "calls": [],
            "call_count": 0,
            "call_argument_tokens": 0,
            "command_text": "",
            "rtk_observed": False,
        }
    )
    exec_command_text = exec_observed.pop("_command_text")
    exec_change_text = exec_observed.pop("_change_text")
    exec_rtk_observed = exec_observed.pop("_rtk_observed")
    inspected["command_text"] = "\n".join(
        (
            inspected["command_text"],
            exec_command_text,
            exec_change_text,
        )
    )
    inspected["rtk_observed"] = bool(
        inspected["rtk_observed"] or exec_rtk_observed
    )
    inspected.update(exec_observed)
    cz = read_codexzero_telemetry(telemetry, cz_artifacts)
    rtk = read_rtk_db(run_root / "rtk.db")
    quality = validate_trial(
        workload_row,
        workspace,
        inspected,
        result.returncode,
        cz,
        bool(config["codexzero"]),
    )
    private = {
        "thread_id": thread_id,
        "assistant_messages": inspected.pop("assistant_messages"),
        "calls": inspected.pop("calls"),
        "command_text": inspected.pop("command_text"),
        "final_answer": inspected.pop("final_answer"),
    }
    call_hashes = [
        {
            key: call[key]
            for key in ("name", "arguments_sha256", "arguments_tokens")
        }
        for call in private["calls"]
    ]
    public = {
        "id": run_id,
        "configuration": config["id"],
        "configuration_label": config["label"],
        "workload": workload_row["id"],
        "repetition": repetition,
        "cli_exit_code": result.returncode,
        "wall_time_ms": round(wall_time_ms, 1),
        "quality": quality,
        **inspected,
        "call_metadata": call_hashes,
        "codexzero": cz,
        "rtk": rtk,
    }
    (run_root / "private-trial.json").write_text(
        json.dumps({**public, **private}, indent=2) + "\n",
        encoding="utf-8",
    )
    return public


def percentile(sorted_values: list[float], probability: float) -> float:
    if not sorted_values:
        return 0
    index = (len(sorted_values) - 1) * probability
    lower = math.floor(index)
    upper = math.ceil(index)
    if lower == upper:
        return sorted_values[lower]
    return (
        sorted_values[lower] * (upper - index)
        + sorted_values[upper] * (index - lower)
    )


def describe(values: list[float], seed: int) -> dict[str, Any]:
    if not values:
        return {
            "n": 0,
            "mean": 0,
            "median": 0,
            "stdev": 0,
            "min": 0,
            "max": 0,
            "p95": 0,
            "bootstrap_95_ci": [0, 0],
        }
    rng = random.Random(seed)
    bootstrap = []
    for _ in range(5000):
        sample = [rng.choice(values) for _ in values]
        bootstrap.append(statistics.fmean(sample))
    bootstrap.sort()
    ordered = sorted(values)
    return {
        "n": len(values),
        "mean": round(statistics.fmean(values), 2),
        "median": round(statistics.median(values), 2),
        "stdev": round(statistics.stdev(values), 2) if len(values) > 1 else 0,
        "min": round(min(values), 2),
        "max": round(max(values), 2),
        "p95": round(percentile(ordered, 0.95), 2),
        "bootstrap_95_ci": [
            round(percentile(bootstrap, 0.025), 2),
            round(percentile(bootstrap, 0.975), 2),
        ],
    }


def describe_stratified(
    values_by_stratum: dict[str, list[float]], seed: int
) -> dict[str, Any]:
    """Bootstrap repetitions while holding the six-workload mix fixed."""
    values = [
        value
        for stratum in values_by_stratum.values()
        for value in stratum
    ]
    result = describe(values, seed)
    if not values:
        return result
    rng = random.Random(seed)
    bootstrap = []
    strata = list(values_by_stratum.values())
    for _ in range(5000):
        sample = [
            rng.choice(stratum)
            for stratum in strata
            for _ in stratum
        ]
        bootstrap.append(statistics.fmean(sample))
    bootstrap.sort()
    result["bootstrap_95_ci"] = [
        round(percentile(bootstrap, 0.025), 2),
        round(percentile(bootstrap, 0.975), 2),
    ]
    result["bootstrap_method"] = "workload-stratified paired resampling"
    return result


def exact_two_sided_sign_test(positive: int, negative: int) -> float:
    """Exact binomial sign test, excluding ties."""
    observations = positive + negative
    if observations == 0:
        return 1.0
    tail = min(positive, negative)
    probability = (
        2
        * sum(math.comb(observations, index) for index in range(tail + 1))
        / (2**observations)
    )
    return round(min(1.0, probability), 8)


METRICS: dict[str, Callable[[dict[str, Any]], float]] = {
    "provider_total_tokens": lambda row: row["usage"].get("total_tokens", 0),
    "provider_input_tokens": lambda row: row["usage"].get("input_tokens", 0),
    "provider_cached_input_tokens": lambda row: row["usage"].get(
        "cached_input_tokens", 0
    ),
    "provider_uncached_input_tokens": lambda row: row["usage"].get(
        "uncached_input_tokens", 0
    ),
    "provider_cache_write_tokens": lambda row: row["usage"].get(
        "cache_write_input_tokens", 0
    ),
    "provider_output_tokens": lambda row: row["usage"].get("output_tokens", 0),
    "provider_reasoning_tokens": lambda row: row["usage"].get(
        "reasoning_output_tokens", 0
    ),
    "inference_requests": lambda row: row["inference_requests"],
    "cache_hit_requests": lambda row: row["cache_hit_requests"],
    "tool_output_tokens": lambda row: row["tool_output_tokens"],
    "assistant_visible_tokens": lambda row: row["assistant_tokens"],
    "final_answer_tokens": lambda row: row["final_answer_tokens"],
    "tool_calls": lambda row: row["call_count"],
    "tool_call_argument_tokens": lambda row: row["call_argument_tokens"],
    "shell_command_executions": lambda row: row.get(
        "shell_command_executions", 0
    ),
    "file_change_events": lambda row: row.get("file_change_events", 0),
    "observed_execution_events": lambda row: row.get(
        "observed_execution_events", 0
    ),
    "shell_command_argument_tokens": lambda row: row.get(
        "shell_command_argument_tokens", 0
    ),
    "shell_command_output_tokens": lambda row: row.get(
        "shell_command_output_tokens", 0
    ),
    "wall_time_ms": lambda row: row["wall_time_ms"],
    "codexzero_tokens_eliminated": lambda row: row["codexzero"][
        "tokens_eliminated"
    ],
    "rtk_tokens_saved": lambda row: row["rtk"]["tokens_saved"],
}


def aggregate(
    trials: list[dict[str, Any]], repetitions: int, seed: int
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    baseline = {
        (row["workload"], row["repetition"]): row
        for row in trials
        if row["configuration"] == "codex"
    }
    grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
    by_workload: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for row in trials:
        grouped[row["configuration"]].append(row)
        by_workload[(row["configuration"], row["workload"])].append(row)

    def summarize(config_id: str, rows: list[dict[str, Any]]) -> dict[str, Any]:
        config = next(item for item in CONFIGURATIONS if item["id"] == config_id)
        metrics = {
            name: describe([float(fn(row)) for row in rows], seed + index)
            for index, (name, fn) in enumerate(METRICS.items())
        }
        paired_rows = []
        for row in rows:
            stock = baseline.get((row["workload"], row["repetition"]))
            if not stock:
                continue
            paired_rows.append((row, stock))
        paired_savings = {}
        for index, (name, fn) in enumerate(METRICS.items()):
            values_by_workload: dict[str, list[float]] = defaultdict(list)
            for row, stock in paired_rows:
                values_by_workload[row["workload"]].append(
                    float(fn(stock) - fn(row))
                )
            paired_savings[name] = describe_stratified(
                values_by_workload, seed + 100 + index
            )
        total_differences = [
            float(
                METRICS["provider_total_tokens"](stock)
                - METRICS["provider_total_tokens"](row)
            )
            for row, stock in paired_rows
        ]
        positive = sum(value > 0 for value in total_differences)
        negative = sum(value < 0 for value in total_differences)
        ties = len(total_differences) - positive - negative
        provider_total = sum(
            METRICS["provider_total_tokens"](row) for row in rows
        )
        paired_baseline_total = sum(
            METRICS["provider_total_tokens"](stock)
            for _, stock in paired_rows
        )
        paired_net_saved = sum(total_differences)
        total_input = sum(row["usage"].get("input_tokens", 0) for row in rows)
        cached_input = sum(
            row["usage"].get("cached_input_tokens", 0) for row in rows
        )
        total_requests = sum(row["inference_requests"] for row in rows)
        hit_requests = sum(row["cache_hit_requests"] for row in rows)
        return {
            "configuration": config_id,
            "label": config["label"],
            "trials": len(rows),
            "expected_trials": len(WORKLOADS) * repetitions,
            "quality_passes": sum(int(row["quality"]["passed"]) for row in rows),
            "metrics": metrics,
            "paired_savings_vs_codex": paired_savings,
            "paired_direction_vs_codex": {
                "lower_token_trials": positive,
                "equal_token_trials": ties,
                "higher_token_trials": negative,
                "exact_two_sided_sign_test_p": exact_two_sided_sign_test(
                    positive, negative
                ),
                "provider_total_tokens": provider_total,
                "paired_codex_total_tokens": paired_baseline_total,
                "net_tokens_saved": paired_net_saved,
                "net_percent_saved": round(
                    paired_net_saved / paired_baseline_total * 100, 4
                )
                if paired_baseline_total
                else 0,
            },
            "cache": {
                "total_requests": total_requests,
                "hit_requests": hit_requests,
                "miss_requests": total_requests - hit_requests,
                "request_hit_rate": round(
                    hit_requests / total_requests, 4
                )
                if total_requests
                else 0,
                "input_tokens": total_input,
                "cached_input_tokens": cached_input,
                "uncached_input_tokens": total_input - cached_input,
                "token_hit_ratio": round(cached_input / total_input, 4)
                if total_input
                else 0,
            },
            "rtk": {
                "eligible_trials": sum(
                    int(
                        row["workload"]
                        in ("git_diff", "code_fix", "mixed_validation")
                    )
                    for row in rows
                ),
                "adopted_trials": sum(int(row["rtk_observed"]) for row in rows),
                "commands": sum(row["rtk"]["commands"] for row in rows),
                "input_tokens": sum(row["rtk"]["input_tokens"] for row in rows),
                "output_tokens": sum(row["rtk"]["output_tokens"] for row in rows),
                "tokens_saved": sum(row["rtk"]["tokens_saved"] for row in rows),
                "parse_failures": sum(
                    row["rtk"]["parse_failures"] for row in rows
                ),
                "fallback_successes": sum(
                    row["rtk"].get("fallback_successes", 0)
                    for row in rows
                ),
            },
            "codexzero": {
                "events": sum(row["codexzero"]["events"] for row in rows),
                "transformed_events": sum(
                    row["codexzero"]["transformed_events"] for row in rows
                ),
                "original_tokens": sum(
                    row["codexzero"]["original_tokens"] for row in rows
                ),
                "selected_tokens": sum(
                    row["codexzero"]["selected_tokens"] for row in rows
                ),
                "tokens_eliminated": sum(
                    row["codexzero"]["tokens_eliminated"] for row in rows
                ),
                "all_monotonic": all(
                    row["codexzero"]["monotonic"] for row in rows
                ),
                "all_artifacts_verified": all(
                    row["codexzero"]["artifacts_verified"] for row in rows
                ),
            },
        }

    overall = [
        summarize(config["id"], grouped[config["id"]])
        for config in CONFIGURATIONS
    ]
    workloads = [
        {
            **summarize(config["id"], by_workload[(config["id"], item["id"])]),
            "workload": item["id"],
        }
        for item in WORKLOADS
        for config in CONFIGURATIONS
    ]
    return overall, workloads


def markdown(report: dict[str, Any]) -> str:
    rows = report["overall"]
    lines = [
        "# Five-way isolated benchmark",
        "",
        f"Model: `{MODEL}` · reasoning: `{EFFORT}` · "
        f"{report['completed_trials']}/{report['expected_trials']} trials completed.",
        "",
        "## End-to-end results",
        "",
        "| Configuration | Quality | Mean total | Saved vs Codex | 95% CI | "
        "Cache token hit | Requests | Tool payload | Visible answer | Mean time |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in rows:
        total = row["metrics"]["provider_total_tokens"]
        saved = row["paired_savings_vs_codex"]["provider_total_tokens"]
        reduction = row["paired_direction_vs_codex"]["net_percent_saved"]
        lines.append(
            f"| {row['label']} "
            f"| {row['quality_passes']}/{row['trials']} "
            f"| {total['mean']:,.0f} "
            f"| {saved['mean']:,.0f} ({reduction:.2f}%) "
            f"| {saved['bootstrap_95_ci'][0]:,.0f} to "
            f"{saved['bootstrap_95_ci'][1]:,.0f} "
            f"| {row['cache']['token_hit_ratio'] * 100:.1f}% "
            f"| {row['metrics']['inference_requests']['mean']:.2f} "
            f"| {row['metrics']['tool_output_tokens']['mean']:,.0f} "
            f"| {row['metrics']['assistant_visible_tokens']['mean']:,.0f} "
            f"| {row['metrics']['wall_time_ms']['mean'] / 1000:.1f}s |"
        )
    lines.extend(
        [
            "",
            "Positive savings mean fewer provider-counted tokens than the paired "
            "Codex trial for the same workload and repetition.",
            "",
            "## Evidence audit",
            "",
            f"Status: **{report['evidence_audit']['status']}**. "
            f"{report['evidence_audit']['raw_exec_streams_rehashed']} raw "
            "exec streams and "
            f"{report['evidence_audit']['tool_payloads_rehashed_and_recounted']} "
            "provider-visible tool payloads were rehashed before this report "
            "was written.",
            "",
            "## Paired direction and exact test",
            "",
            "| Configuration | Lower-token trials | Equal | Higher-token trials | "
            "Net tokens saved | Net saved | Exact sign-test p |",
            "|---|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for row in rows:
        direction = row["paired_direction_vs_codex"]
        lines.append(
            f"| {row['label']} "
            f"| {direction['lower_token_trials']} "
            f"| {direction['equal_token_trials']} "
            f"| {direction['higher_token_trials']} "
            f"| {direction['net_tokens_saved']:,.0f} "
            f"| {direction['net_percent_saved']:.2f}% "
            f"| {direction['exact_two_sided_sign_test_p']:.6g} |"
        )
    lines.extend(
        [
            "",
            "## Provider-token accounting",
            "",
            "| Configuration | Mean input | Mean cached | Mean uncached | "
            "Mean cache write | Mean output | Mean reasoning | Mean total |",
            "|---|---:|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for row in rows:
        metric = row["metrics"]
        lines.append(
            f"| {row['label']} "
            f"| {metric['provider_input_tokens']['mean']:,.0f} "
            f"| {metric['provider_cached_input_tokens']['mean']:,.0f} "
            f"| {metric['provider_uncached_input_tokens']['mean']:,.0f} "
            f"| {metric['provider_cache_write_tokens']['mean']:,.0f} "
            f"| {metric['provider_output_tokens']['mean']:,.0f} "
            f"| {metric['provider_reasoning_tokens']['mean']:,.0f} "
            f"| {metric['provider_total_tokens']['mean']:,.0f} |"
        )
    lines.extend(
        [
            "",
            "## Cache accounting",
            "",
            "| Configuration | Requests | Cache-hit requests | Request hit rate | "
            "Input | Cached input | Uncached input | Token hit ratio |",
            "|---|---:|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for row in rows:
        cache = row["cache"]
        lines.append(
            f"| {row['label']} | {cache['total_requests']} "
            f"| {cache['hit_requests']} | {cache['request_hit_rate'] * 100:.1f}% "
            f"| {cache['input_tokens']:,} | {cache['cached_input_tokens']:,} "
            f"| {cache['uncached_input_tokens']:,} "
            f"| {cache['token_hit_ratio'] * 100:.1f}% |"
        )
    lines.extend(
        [
            "",
            "## Execution accounting",
            "",
            "| Configuration | Inferences | Session calls | Shell executions | "
            "File changes | Shell output | Provider tool payload | "
            "Visible assistant | Final answer | Mean time |",
            "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for row in rows:
        metric = row["metrics"]
        lines.append(
            f"| {row['label']} "
            f"| {metric['inference_requests']['mean']:.2f} "
            f"| {metric['tool_calls']['mean']:.2f} "
            f"| {metric['shell_command_executions']['mean']:.2f} "
            f"| {metric['file_change_events']['mean']:.2f} "
            f"| {metric['shell_command_output_tokens']['mean']:,.0f} "
            f"| {metric['tool_output_tokens']['mean']:,.0f} "
            f"| {metric['assistant_visible_tokens']['mean']:,.0f} "
            f"| {metric['final_answer_tokens']['mean']:,.0f} "
            f"| {metric['wall_time_ms']['mean'] / 1000:.1f}s |"
        )
    lines.extend(
        [
            "",
            "## Optimizer-native measurements",
            "",
            "| Configuration | CZ events | CZ transformed | CZ original | "
            "CZ selected | CZ removed | RTK commands | RTK input | RTK output | "
            "RTK removed | RTK fallbacks |",
            "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for row in rows:
        lines.append(
            f"| {row['label']} | {row['codexzero']['events']} "
            f"| {row['codexzero']['transformed_events']} "
            f"| {row['codexzero']['original_tokens']:,} "
            f"| {row['codexzero']['selected_tokens']:,} "
            f"| {row['codexzero']['tokens_eliminated']:,} "
            f"| {row['rtk']['commands']} | {row['rtk']['input_tokens']:,} "
            f"| {row['rtk']['output_tokens']:,} "
            f"| {row['rtk']['tokens_saved']:,} "
            f"| {row['rtk']['fallback_successes']}/"
            f"{row['rtk']['parse_failures']} |"
        )
    lines.extend(
        [
            "",
            "## Results by workload",
            "",
            "| Workload | Configuration | Quality | Mean total | Saved vs Codex | "
            "95% CI | Cache token hit | Mean time |",
            "|---|---|---:|---:|---:|---:|---:|---:|",
        ]
    )
    for row in report["by_workload"]:
        total = row["metrics"]["provider_total_tokens"]
        saved = row["paired_savings_vs_codex"]["provider_total_tokens"]
        lines.append(
            f"| {row['workload']} | {row['label']} "
            f"| {row['quality_passes']}/{row['trials']} "
            f"| {total['mean']:,.0f} | {saved['mean']:,.0f} "
            f"| {saved['bootstrap_95_ci'][0]:,.0f} to "
            f"{saved['bootstrap_95_ci'][1]:,.0f} "
            f"| {row['cache']['token_hit_ratio'] * 100:.1f}% "
            f"| {row['metrics']['wall_time_ms']['mean'] / 1000:.1f}s |"
        )
    lines.extend(
        [
            "",
            "## Controls and scope",
            "",
            "- Codex uses the untouched official Windows binary from the exact "
            "same `0.145.0-alpha.30` release as CodexZero’s patched core. Its "
            "retained npm archive matches the registry SHA-512 integrity value.",
            "- Every run uses a fresh thread and a disposable workspace. Codex "
            "homes, Caveman files, CodexZero telemetry, and RTK databases are "
            "isolated from the user installation.",
            "- RTK adoption is natural: the exact RTK instruction file is present, "
            "but task prompts do not force an `rtk` prefix.",
            "- Cache reads, cache writes, hits by request, and cached/uncached input "
            "tokens are taken from provider counters for every inference.",
            "- CodexZero’s selected payload must never exceed stock. Every stored "
            "artifact is rehashed and byte-counted. Any violation fails quality.",
            "- Results are paired within workload and repetition. The report shows "
            "5,000-resample workload-stratified paired bootstrap confidence "
            "intervals and exact two-sided sign tests. Mean, median, standard "
            "deviation, minimum, maximum, and p95 remain in JSON.",
            "- Provider caching cannot be forcibly cleared. It is measured rather "
            "than guessed, and randomized interleaving limits order bias.",
            "- RTK's native counters are secondary diagnostics. End-to-end "
            "provider totals remain authoritative. An RTK parse failure is "
            "reported with whether its stock-command fallback succeeded.",
            "- Session function calls and public exec-stream command events are "
            "reported separately; they are overlapping views and are never "
            "added into a fabricated total.",
            "- This fixed corpus is reproducible evidence for these workloads, not "
            "a universal percentage for all Codex usage.",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repetitions", type=int, default=3)
    parser.add_argument("--seed", type=int, default=2512)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--resume", type=Path)
    parser.add_argument("--stock-binary", type=Path)
    parser.add_argument("--codexzero-binary", type=Path)
    parser.add_argument(
        "--codexzero-mode",
        choices=("safe", "max-save"),
        default="safe",
        help="Safe preserves stock model instructions; Max Savings uses the bundled prompt.",
    )
    parser.add_argument(
        "--json-report",
        type=Path,
        default=ROOT / "reports" / "five-way-benchmark.json",
    )
    parser.add_argument(
        "--markdown-report",
        type=Path,
        default=ROOT / "reports" / "five-way-benchmark.md",
    )
    args = parser.parse_args()
    if args.repetitions < 1:
        parser.error("--repetitions must be positive")

    codex_home = Path.home() / ".codex"
    stock_binary = args.stock_binary or (
        ROOT
        / "private-artifacts"
        / "upstream-codex-0.145.0-alpha.30"
        / "package"
        / "vendor"
        / "x86_64-pc-windows-msvc"
        / "bin"
        / "codex.exe"
    )
    codexzero_binary = args.codexzero_binary or (
        codex_home / "codexzero" / "bin" / "codex-zero-core.exe"
    )
    auth = codex_home / "auth.json"
    models_cache = codex_home / "models_cache.json"
    lean_prompt = ROOT / "prompts" / "codex-core-lean-v1.md"
    prompt_manifest = ROOT / "prompts" / "manifest.json"
    rtk_file = codex_home / "RTK.md"
    rtk_binary = Path(shutil.which("rtk") or "")
    caveman_source = (
        codex_home
        / "plugins"
        / "cache"
        / "caveman-local"
        / "caveman"
        / "0.1.0"
        / "skills"
        / "caveman"
    )
    needs_caveman = any(config["caveman"] for config in CONFIGURATIONS)
    required = [
        stock_binary,
        codexzero_binary,
        auth,
        lean_prompt,
        prompt_manifest,
        rtk_file,
        rtk_binary,
    ]
    if needs_caveman:
        required.append(caveman_source / "SKILL.md")
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise SystemExit("Missing benchmark dependency:\n" + "\n".join(missing))
    stock_provenance = stock_package_provenance(stock_binary)

    previous = None
    if args.resume:
        previous = json.loads(args.resume.read_text(encoding="utf-8"))
        if previous.get("codexzero_mode") != args.codexzero_mode:
            raise SystemExit("Resume report was created with a different CodexZero mode")
        private_root = Path(previous["private_artifacts"])
        if not private_root.is_absolute():
            private_root = ROOT / private_root
        trials = list(previous["trials"])
        template = private_root / "template"
        fixture_manifest = previous["fixture_manifest"]
    else:
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        private_root = (
            args.output.resolve()
            if args.output
            else ROOT / "private-artifacts" / f"five-way-benchmark-{stamp}"
        )
        private_root.mkdir(parents=True, exist_ok=True)
        template = private_root / "template"
        fixture_manifest = write_template(template)
        trials = []
    completed = {row["id"] for row in trials}
    binaries = {"stock": stock_binary, "codexzero": codexzero_binary}
    rtk_instructions = rtk_file.read_text(encoding="utf-8")

    with tempfile.TemporaryDirectory(prefix="codexzero-five-way-") as temp_value:
        temporary_root = Path(temp_value)
        homes = {}
        try:
            for config in CONFIGURATIONS:
                home = temporary_root / "homes" / config["id"]
                create_home(
                    home,
                    auth,
                    models_cache,
                    caveman_source if config["caveman"] else None,
                )
                homes[config["id"]] = home
            rng = random.Random(args.seed)
            blocks = [
                (repetition, item)
                for repetition in range(1, args.repetitions + 1)
                for item in WORKLOADS
            ]
            rng.shuffle(blocks)
            for block_index, (repetition, item) in enumerate(blocks, 1):
                order = list(CONFIGURATIONS)
                rng.shuffle(order)
                for config_index, config in enumerate(order, 1):
                    run_id = f"r{repetition}-{item['id']}-{config['id']}"
                    if run_id in completed:
                        continue
                    print(
                        f"[{block_index}/{len(blocks)} "
                        f"{config_index}/{len(order)}] {run_id}",
                        file=sys.stderr,
                        flush=True,
                    )
                    try:
                        row = run_trial(
                            config=config,
                            workload_row=item,
                            repetition=repetition,
                            binaries=binaries,
                            homes=homes,
                            template=template,
                            temporary_root=temporary_root,
                            private_root=private_root,
                            lean_prompt=lean_prompt,
                            codexzero_mode=args.codexzero_mode,
                            rtk_binary=rtk_binary,
                            rtk_instructions=rtk_instructions,
                        )
                    except subprocess.TimeoutExpired as error:
                        row = {
                            "id": run_id,
                            "configuration": config["id"],
                            "configuration_label": config["label"],
                            "workload": item["id"],
                            "repetition": repetition,
                            "quality": {
                                "passed": False,
                                "checks": {"timeout": False},
                            },
                            "error": f"timeout after {error.timeout}s",
                            "usage": {},
                            "inference_requests": 0,
                            "cache_hit_requests": 0,
                            "tool_output_tokens": 0,
                            "assistant_tokens": 0,
                            "final_answer_tokens": 0,
                            "call_count": 0,
                            "call_argument_tokens": 0,
                            "shell_command_executions": 0,
                            "successful_shell_commands": 0,
                            "failed_shell_commands": 0,
                            "file_change_events": 0,
                            "changed_path_events": 0,
                            "observed_execution_events": 0,
                            "shell_command_argument_tokens": 0,
                            "shell_command_output_tokens": 0,
                            "shell_command_output_bytes": 0,
                            "command_metadata": [],
                            "file_change_metadata": [],
                            "wall_time_ms": error.timeout * 1000,
                            "codexzero": {
                                "tokens_eliminated": 0,
                                "events": 0,
                                "transformed_events": 0,
                                "original_tokens": 0,
                                "selected_tokens": 0,
                                "monotonic": False,
                                "artifacts_verified": False,
                            },
                            "rtk": {
                                "tokens_saved": 0,
                                "commands": 0,
                                "input_tokens": 0,
                                "output_tokens": 0,
                            "parse_failures": 0,
                            "fallback_successes": 0,
                        },
                            "rtk_observed": False,
                        }
                    trials.append(row)
                    completed.add(run_id)
                    (private_root / "checkpoint.json").write_text(
                        json.dumps(
                            {
                                "schema": "codexzero-five-way-checkpoint-v1",
                                "private_artifacts": str(private_root),
                                "fixture_manifest": fixture_manifest,
                                "trials": trials,
                            },
                            indent=2,
                        )
                        + "\n",
                        encoding="utf-8",
                    )
        finally:
            for home in homes.values():
                try:
                    (home / "auth.json").unlink(missing_ok=True)
                except OSError:
                    pass

    augment_trials_from_exec_stream(trials, private_root)
    (private_root / "checkpoint.json").write_text(
        json.dumps(
            {
                "schema": "codexzero-five-way-checkpoint-v1",
                "private_artifacts": str(private_root),
                "fixture_manifest": fixture_manifest,
                "trials": trials,
            },
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    overall, by_workload = aggregate(trials, args.repetitions, args.seed)
    manifest = json.loads(prompt_manifest.read_text(encoding="utf-8"))
    reference = manifest["references"][0]
    expected_trials = (
        args.repetitions * len(WORKLOADS) * len(CONFIGURATIONS)
    )
    evidence_audit = audit_trials(trials, private_root, expected_trials)
    binary_info = {}
    for name, path in binaries.items():
        version = process([str(path), "--version"], cwd=ROOT, timeout=30)
        binary_info[name] = {
            "filename": path.name,
            "version": version.stdout.decode("utf-8", "replace").strip(),
            "bytes": path.stat().st_size,
            "sha256": digest(path.read_bytes()),
        }
    try:
        private_locator = private_root.relative_to(ROOT).as_posix()
    except ValueError:
        private_locator = str(private_root)
    report = {
        "schema": "codexzero-five-way-benchmark-v1",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "model": MODEL,
        "reasoning_effort": EFFORT,
        "codexzero_mode": args.codexzero_mode,
        "tokenizer": TOKENIZER,
        "seed": args.seed,
        "repetitions": args.repetitions,
        "workloads": [row["id"] for row in WORKLOADS],
        "configurations": list(CONFIGURATIONS),
        "expected_trials": expected_trials,
        "completed_trials": len(trials),
        "quality_passes": sum(int(row["quality"]["passed"]) for row in trials),
        "evidence_audit": evidence_audit,
        "host": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "cpu_count": os.cpu_count(),
        },
        "binaries": binary_info,
        "stock_package_provenance": stock_provenance,
        "instructions": {
            "baseline_model_prompt_tokens": reference["baseline_tokens"],
            "lean_model_prompt_tokens": reference["lean_tokens"],
            "lean_tokens_removed_per_inference": reference[
                "tokens_removed_per_model_request"
            ],
            "rtk_tokens": tokens(rtk_instructions),
            "rtk_sha256": digest(rtk_instructions.encode("utf-8")),
            "caveman_skill_tokens": (
                tokens((caveman_source / "SKILL.md").read_text(encoding="utf-8"))
                if needs_caveman
                else 0
            ),
            "caveman_skill_sha256": (
                digest((caveman_source / "SKILL.md").read_bytes())
                if needs_caveman
                else None
            ),
            "caveman_activation_tokens": tokens(CAVEMAN_ACTIVATION),
        },
        "fixture_manifest": fixture_manifest,
        "overall": overall,
        "by_workload": by_workload,
        "trials": trials,
        "private_artifacts": private_locator,
        "limitations": [
            "Provider prompt caches cannot be forcibly cleared; every cache counter is recorded.",
            "RTK adoption is measured from natural instruction following, not forced command rewriting.",
            "Bootstrap intervals quantify this fixed corpus and do not make it universal.",
        ],
    }
    args.json_report.parent.mkdir(parents=True, exist_ok=True)
    args.markdown_report.parent.mkdir(parents=True, exist_ok=True)
    args.json_report.write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    args.markdown_report.write_text(markdown(report), encoding="utf-8")
    (private_root / "manifest.json").write_text(
        json.dumps(report, indent=2) + "\n", encoding="utf-8"
    )
    print(args.markdown_report)
    complete = len(trials) == expected_trials
    quality = all(row["quality"]["passed"] for row in trials)
    return 0 if complete and quality else 2


if __name__ == "__main__":
    raise SystemExit(main())
