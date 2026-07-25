#!/usr/bin/env python3
"""Capture non-secret, reproducible provenance for the DeepSWE benchmark."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


TOOL_FILES = (
    "analyze-deepswe-five-way.py",
    "merge-deepswe-checkpoints.py",
    "pause-deepswe-five-way.py",
    "run-deepswe-five-way.py",
    "test-deepswe-harness.py",
    "pier-codexzero.patch",
    "pier-codexzero-prompt.patch",
    "pier-chatgpt-allowlist.patch",
    "pier-comparison-configs.patch",
    "pier-balanced-agent-order.patch",
    "deepswe-rtk-instructions.md",
    "deepswe-caveman-activation.md",
    "deepswe-caveman-rtk-instructions.md",
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(*command: str, cwd: Path | None = None) -> str:
    result = subprocess.run(
        command,
        cwd=cwd,
        capture_output=True,
        text=True,
        check=True,
    )
    return result.stdout.strip()


def git_info(path: Path) -> dict[str, Any]:
    diff = run("git", "diff", "--binary", "HEAD", cwd=path)
    return {
        "commit": run("git", "rev-parse", "HEAD", cwd=path),
        "origin": run("git", "remote", "get-url", "origin", cwd=path),
        "dirty": bool(run("git", "status", "--porcelain", cwd=path)),
        "tracked_diff_sha256": hashlib.sha256(diff.encode()).hexdigest(),
    }


def file_info(path: Path) -> dict[str, Any]:
    return {"bytes": path.stat().st_size, "sha256": sha256(path)}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo-root", type=Path, required=True)
    parser.add_argument("--pier-repo", type=Path, required=True)
    parser.add_argument("--deepswe-repo", type=Path, required=True)
    parser.add_argument("--codexzero-binary", type=Path, required=True)
    parser.add_argument("--rtk-repo", type=Path, required=True)
    parser.add_argument("--rtk-binary", type=Path, required=True)
    parser.add_argument("--caveman-skill", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    tools = args.repo_root / "tools"
    tool_files = {name: tools / name for name in TOOL_FILES}
    required = [
        args.pier_repo,
        args.deepswe_repo,
        args.codexzero_binary,
        args.rtk_repo,
        args.rtk_binary,
        args.caveman_skill / "SKILL.md",
        *tool_files.values(),
    ]
    missing = [str(path) for path in required if not path.exists()]
    if missing:
        raise SystemExit("Missing provenance input:\n" + "\n".join(missing))
    docker = json.loads(run("docker", "version", "--format", "{{json .}}"))
    task_dir = args.deepswe_repo / "tasks"
    provenance = {
        "schema": "codexzero-deepswe-provenance-v1",
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "benchmark": {
            "name": "DeepSWE",
            "model": "gpt-5.6-sol",
            "reasoning_effort": "high",
            "stock_codex_version": "0.145.0-alpha.30",
            "planned_tasks": len([path for path in task_dir.iterdir() if path.is_dir()]),
            "configurations": [
                "codex",
                "codexzero",
                "codex_rtk",
                "codex_caveman",
                "codex_caveman_rtk",
            ],
        },
        "repositories": {
            "codexzero": git_info(args.repo_root),
            "pier": git_info(args.pier_repo),
            "deepswe": git_info(args.deepswe_repo),
            "rtk": git_info(args.rtk_repo),
        },
        "binaries": {
            "codexzero": {
                **file_info(args.codexzero_binary),
                "version": run(str(args.codexzero_binary), "--version"),
            },
            "rtk": {
                **file_info(args.rtk_binary),
                "version": run(str(args.rtk_binary), "--version"),
            },
        },
        "caveman_skill": file_info(args.caveman_skill / "SKILL.md"),
        "benchmark_tools": {
            name: file_info(path) for name, path in tool_files.items()
        },
        "runtime": {
            "python": sys.version,
            "platform": platform.platform(),
            "machine": platform.machine(),
            "processor": platform.processor(),
            "logical_cpu_count": os.cpu_count(),
            "docker": docker,
        },
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(provenance, indent=2) + "\n", encoding="utf-8")
    print(args.output)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
