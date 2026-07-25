#!/usr/bin/env python3
"""Checkpoint an operator-requested pause without scoring partial trials."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType
from typing import Any


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def load_runner(path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location("deepswe_runner", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Unable to load runner: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", type=Path, required=True)
    parser.add_argument("--runner", type=Path, required=True)
    parser.add_argument("--job-dir", type=Path, required=True)
    parser.add_argument("--job-config", type=Path, required=True)
    parser.add_argument("--task", required=True)
    args = parser.parse_args()

    runner = load_runner(args.runner)
    state = read_json(args.checkpoint)
    job_name = args.job_dir.name
    task_state = state["tasks"].setdefault(
        args.task, {"completed": {}, "attempts": [], "status": "pending"}
    )
    if any(attempt.get("job_name") == job_name for attempt in task_state["attempts"]):
        print(f"{job_name} is already checkpointed")
        return 0

    trials = runner.find_trials(args.job_dir)
    statuses: dict[str, Any] = {}
    for identifier in runner.CONFIG_IDS:
        trial = trials.get(identifier)
        if trial is None:
            status, detail = "interrupted", "trial directory was not created"
        else:
            completed_status, completed_detail = runner.trial_status(
                trial, identifier
            )
            if completed_status == "complete":
                status, detail = completed_status, completed_detail
                task_state["completed"][identifier] = str(trial)
            else:
                status = "interrupted"
                detail = (
                    "operator-requested safe pause; partial trial excluded from scores"
                )
        statuses[identifier] = {
            "status": status,
            "detail": detail,
            "trial": str(trial) if trial else None,
        }

    paused_at = now()
    started_at = datetime.fromtimestamp(
        os.path.getctime(args.job_dir), tz=timezone.utc
    ).isoformat()
    attempt_number = len(task_state["attempts"]) + 1
    task_state["attempts"].append(
        {
            "attempt": attempt_number,
            "job_name": job_name,
            "started_at": started_at,
            "finished_at": paused_at,
            "returncode": 130,
            "operator_requested_pause": True,
            "statuses": statuses,
            "config_sha256": sha256(args.job_config),
        }
    )
    task_state["status"] = (
        "complete"
        if len(task_state["completed"]) == len(runner.CONFIG_IDS)
        else "paused"
    )
    state.setdefault("pauses", []).append(
        {
            "paused_at": paused_at,
            "job_name": job_name,
            "task": args.task,
            "reason": "operator-requested safe pause",
        }
    )
    state["updated_at"] = paused_at
    temporary = args.checkpoint.with_suffix(".pause.tmp")
    temporary.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    temporary.replace(args.checkpoint)
    print(
        f"Saved pause for {args.task}: "
        f"{len(task_state['completed'])}/{len(runner.CONFIG_IDS)} valid trials retained"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
