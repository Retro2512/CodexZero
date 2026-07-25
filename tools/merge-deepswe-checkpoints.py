#!/usr/bin/env python3
"""Merge independently run DeepSWE shards into one validated paired checkpoint."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


COMPATIBILITY_FIELDS = (
    "model",
    "reasoning_effort",
    "seed",
    "configurations",
    "dependencies",
)


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_runner() -> Any:
    path = Path(__file__).with_name("run-deepswe-five-way.py")
    spec = importlib.util.spec_from_file_location("deepswe_five_way_runner", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot import trial validator from {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def attempt_window(checkpoints: list[dict[str, Any]]) -> dict[str, Any]:
    attempts = [
        attempt
        for checkpoint in checkpoints
        for state in checkpoint.get("tasks", {}).values()
        for attempt in state.get("attempts", [])
    ]
    starts = [
        attempt["started_at"] for attempt in attempts if attempt.get("started_at")
    ]
    finishes = [
        attempt["finished_at"] for attempt in attempts if attempt.get("finished_at")
    ]
    if not starts or not finishes:
        return {"started_at": None, "finished_at": None, "wall_seconds": None}
    started_at = min(starts)
    finished_at = max(finishes)
    start = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
    finish = datetime.fromisoformat(finished_at.replace("Z", "+00:00"))
    return {
        "started_at": started_at,
        "finished_at": finished_at,
        "wall_seconds": (finish - start).total_seconds(),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--checkpoint",
        type=Path,
        action="append",
        required=True,
        help="Source checkpoint, in increasing precedence order.",
    )
    parser.add_argument(
        "--task",
        action="append",
        required=True,
        help="Task to include, in final report order.",
    )
    parser.add_argument(
        "--parallel-task-shards",
        type=int,
        default=0,
        help="Number of task shards intentionally launched together.",
    )
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    sources = [(path.resolve(), read_json(path.resolve())) for path in args.checkpoint]
    reference_path, reference = sources[0]
    for path, checkpoint in sources[1:]:
        for field in COMPATIBILITY_FIELDS:
            if checkpoint.get(field) != reference.get(field):
                raise SystemExit(
                    f"Incompatible {field!r}: {path} does not match {reference_path}"
                )

    wanted = list(dict.fromkeys(args.task))
    if len(wanted) != len(args.task):
        raise SystemExit("Duplicate --task values are not allowed")

    task_sources: dict[str, tuple[Path, dict[str, Any]]] = {}
    for path, checkpoint in sources:
        for task, state in checkpoint.get("tasks", {}).items():
            if task in wanted and len(state.get("completed", {})) == len(
                reference["configurations"]
            ):
                task_sources[task] = (path, state)

    missing = [task for task in wanted if task not in task_sources]
    if missing:
        raise SystemExit(f"No complete paired checkpoint state for: {', '.join(missing)}")

    runner = load_runner()
    tasks: dict[str, Any] = {}
    validation: dict[str, Any] = {}
    for task in wanted:
        source, state = task_sources[task]
        completed: dict[str, str] = {}
        for config in reference["configurations"]:
            trial = state["completed"].get(config)
            if not trial:
                raise SystemExit(f"{task}/{config}: missing completed trial")
            status, detail = runner.trial_status(Path(trial), config)
            if status != "complete":
                raise SystemExit(f"{task}/{config}: {status}: {detail}")
            completed[config] = trial
        tasks[task] = {
            "completed": completed,
            "attempts": state.get("attempts", []),
            "status": "complete",
            "source_checkpoint": str(source),
        }
        validation[task] = {
            "source_checkpoint_sha256": sha256(source),
            "validated_configurations": list(reference["configurations"]),
        }

    now = datetime.now(timezone.utc).isoformat()
    merged = {
        "schema": "codexzero-deepswe-five-way-merged-v1",
        "created_at": now,
        "updated_at": now,
        "status": "complete",
        "model": reference["model"],
        "reasoning_effort": reference["reasoning_effort"],
        "seed": reference["seed"],
        "task_order": wanted,
        "configurations": reference["configurations"],
        "dependencies": reference["dependencies"],
        "tasks": tasks,
        "source_checkpoints": [
            {
                "path": str(path),
                "sha256": sha256(path),
                "reconciliation": checkpoint.get("reconciliation"),
            }
            for path, checkpoint in sources
        ],
        "execution": {
            "parallel_task_shards": args.parallel_task_shards,
            "configurations_per_shard": len(reference["configurations"]),
            "maximum_concurrent_trials": (
                args.parallel_task_shards * len(reference["configurations"])
            ),
            "parallel_shard_window": attempt_window(
                [checkpoint for _, checkpoint in sources[1:]]
            ),
            "all_source_attempt_window": attempt_window(
                [checkpoint for _, checkpoint in sources]
            ),
        },
        "validation": validation,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(merged, indent=2) + "\n", encoding="utf-8")
    print(
        f"Wrote {args.output}: {len(wanted)} tasks, "
        f"{len(wanted) * len(reference['configurations'])} validated trials"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
