#!/usr/bin/env python3
"""Run resumable, paired DeepSWE trials across the five requested configurations."""

from __future__ import annotations

import argparse
import hashlib
import json
import random
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


MODEL = "gpt-5.6-sol"
EFFORT = "high"
CODEX_VERSION = "0.145.0-alpha.30"
SEED = 2512
QUOTA_PATTERNS = (
    "you've hit your usage limit",
    "you have hit your usage limit",
    "your usage limit will reset",
    "you have no weighted tokens left",
    "insufficient_quota",
    "billing_hard_limit_reached",
    "usage_limit_reached",
    "quota_exceeded",
)
CONFIG_IDS = (
    "codex",
    "codexzero",
    "codex_rtk",
    "codex_caveman",
    "codex_caveman_rtk",
)
CZ_SAFE_TOML = """\
suppress_unstable_features_warning = true
[features]
codex_zero_compact_exec_output = true
codex_zero_lossless_terminal_codec = true
codex_zero_exact_duplicate_results = true
codex_zero_event_driven_wait = true
"""
CZ_MAX_SAVE_TOML = (
    'model_instructions_file = "/tmp/codex-model-instructions.md"\n'
    + CZ_SAFE_TOML
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def agent(
    identifier: str,
    *,
    auth: Path,
    codexzero_binary: Path,
    codexzero_mode: str,
    lean_prompt: Path,
    rtk_binary: Path,
    rtk_instructions: Path,
    caveman_skill: Path,
    caveman_activation: Path,
    combined_instructions: Path,
) -> dict[str, Any]:
    env = {
        "CODEX_AUTH_JSON_PATH": str(auth),
        "CODEX_BENCHMARK_LABEL": identifier,
    }
    kwargs: dict[str, Any] = {
        "version": CODEX_VERSION,
        "reasoning_effort": EFFORT,
    }
    if identifier == "codexzero":
        env.update({
            "CODEX_BINARY_PATH": str(codexzero_binary),
            "CODEX_ZERO_ARTIFACT_DIR": "/tmp/codexzero-artifacts",
        })
        if codexzero_mode == "max-save":
            env["CODEX_MODEL_INSTRUCTIONS_PATH"] = str(lean_prompt)
            kwargs["config_toml"] = CZ_MAX_SAVE_TOML
        else:
            kwargs["config_toml"] = CZ_SAFE_TOML
    if identifier in {"codex_rtk", "codex_caveman_rtk"}:
        env["CODEX_RTK_BINARY_PATH"] = str(rtk_binary)
        env["CODEX_ADDITIONAL_INSTRUCTIONS_PATH"] = str(
            combined_instructions
            if identifier == "codex_caveman_rtk"
            else rtk_instructions
        )
    if identifier in {"codex_caveman", "codex_caveman_rtk"}:
        env["CODEX_SKILL_PATH"] = str(caveman_skill)
        if identifier == "codex_caveman":
            env["CODEX_ADDITIONAL_INSTRUCTIONS_PATH"] = str(caveman_activation)
    return {
        "name": "codex",
        "model_name": MODEL,
        "kwargs": kwargs,
        "env": env,
    }


def job_config(
    *,
    job_name: str,
    jobs_dir: Path,
    tasks_dir: Path,
    task_name: str,
    agents: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "job_name": job_name,
        "jobs_dir": str(jobs_dir),
        "n_attempts": 1,
        "timeout_multiplier": 1.0,
        "debug": False,
        "n_concurrent_trials": len(agents),
        "quiet": False,
        "retry": {
            "max_retries": 0,
            "exclude_exceptions": [
                "RewardFileNotFoundError",
                "AgentTimeoutError",
                "RewardFileEmptyError",
                "VerifierOutputParseError",
                "VerifierTimeoutError",
            ],
        },
        "environment": {
            "type": "docker",
            "force_build": False,
            "delete": True,
            "cpu_enforcement_policy": "auto",
            "memory_enforcement_policy": "auto",
            "env": {},
        },
        "verifier": {"env": {}, "disable": False},
        "metrics": [],
        "agents": agents,
        "datasets": [
            {
                "path": str(tasks_dir),
                "task_names": [task_name],
                "n_tasks": 1,
                "sample_seed": SEED,
            }
        ],
        "tasks": [],
        "artifacts": [],
    }


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def find_trials(job_dir: Path) -> dict[str, Path]:
    found: dict[str, Path] = {}
    for config_path in job_dir.glob("*/config.json"):
        config = read_json(config_path)
        identifier = config.get("agent", {}).get("env", {}).get(
            "CODEX_BENCHMARK_LABEL"
        )
        if identifier in CONFIG_IDS:
            found[identifier] = config_path.parent
    return found


def trial_status(path: Path, identifier: str) -> tuple[str, str | None]:
    content = ""
    for candidate in (
        path / "agent" / "codex.txt",
        path / "trial.log",
    ):
        if candidate.is_file():
            content += candidate.read_text(encoding="utf-8", errors="replace").lower()
    result_path = path / "result.json"
    reward_path = path / "verifier" / "reward.json"
    trajectory_path = path / "agent" / "trajectory.json"
    if not result_path.is_file():
        if any(pattern in content for pattern in QUOTA_PATTERNS):
            return "quota", "provider usage limit"
        return "incomplete", "missing result.json"
    result = read_json(result_path)
    exception = result.get("exception_info")
    if exception is not None:
        exception_text = json.dumps(exception, sort_keys=True).lower()
        if any(pattern in exception_text for pattern in QUOTA_PATTERNS):
            return "quota", "provider usage limit"
        return "error", json.dumps(exception, sort_keys=True)
    if not reward_path.is_file():
        return "error", "missing verifier reward"
    if not trajectory_path.is_file():
        return "error", "missing trajectory"
    trajectory = read_json(trajectory_path)
    if not trajectory.get("final_metrics"):
        return "error", "missing provider metrics"
    if identifier in {"codex_rtk", "codex_caveman_rtk"}:
        if "rtk: command not found" in content:
            return "error", "RTK was requested but unavailable inside the agent shell"
        if not (path / "agent" / "rtk.db").is_file():
            return "error", "RTK produced no native metrics database"
    if identifier in {"codex_caveman", "codex_caveman_rtk"}:
        if "skills/caveman/skill.md" not in content:
            return "error", "Caveman skill activation was not observable"
    return "complete", None


def dependency_manifest(args: argparse.Namespace) -> dict[str, Any]:
    paths = {
        "auth": args.auth,
        "codexzero_binary": args.codexzero_binary,
        "lean_prompt": args.lean_prompt,
        "rtk_binary": args.rtk_binary,
        "rtk_instructions": args.rtk_instructions,
        "caveman_skill": args.caveman_skill / "SKILL.md",
        "caveman_activation": args.caveman_activation,
        "combined_instructions": args.combined_instructions,
    }
    missing = [str(path) for path in paths.values() if not path.exists()]
    if missing:
        raise SystemExit("Missing dependency:\n" + "\n".join(missing))
    return {
        name: {"path": str(path), "sha256": sha256(path)}
        for name, path in paths.items()
        if name != "auth"
    }


def save(path: Path, state: dict[str, Any]) -> None:
    state["updated_at"] = now()
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pier", type=Path, required=True)
    parser.add_argument("--jobs-dir", type=Path, required=True)
    parser.add_argument("--tasks-dir", type=Path, required=True)
    parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument("--auth", type=Path, required=True)
    parser.add_argument("--codexzero-binary", type=Path, required=True)
    parser.add_argument(
        "--codexzero-mode",
        choices=("safe", "max-save"),
        default="safe",
        help="Safe preserves stock model instructions; Max Savings uses --lean-prompt.",
    )
    parser.add_argument("--lean-prompt", type=Path, required=True)
    parser.add_argument("--rtk-binary", type=Path, required=True)
    parser.add_argument("--rtk-instructions", type=Path, required=True)
    parser.add_argument("--caveman-skill", type=Path, required=True)
    parser.add_argument("--caveman-activation", type=Path, required=True)
    parser.add_argument("--combined-instructions", type=Path, required=True)
    parser.add_argument("--task", action="append", default=[])
    parser.add_argument("--max-tasks", type=int)
    parser.add_argument("--max-attempts", type=int, default=2)
    parser.add_argument("--seed-checkpoint", type=Path)
    args = parser.parse_args()
    if args.max_attempts < 1:
        parser.error("--max-attempts must be positive")

    manifest = dependency_manifest(args)
    all_tasks = sorted(path.name for path in args.tasks_dir.iterdir() if path.is_dir())
    selected = args.task or all_tasks
    unknown = sorted(set(selected) - set(all_tasks))
    if unknown:
        parser.error("unknown tasks: " + ", ".join(unknown))
    random.Random(SEED).shuffle(selected)
    if args.max_tasks is not None:
        selected = selected[: args.max_tasks]

    args.run_root.mkdir(parents=True, exist_ok=True)
    args.jobs_dir.mkdir(parents=True, exist_ok=True)
    configs_dir = args.run_root / "configs"
    logs_dir = args.run_root / "logs"
    configs_dir.mkdir(exist_ok=True)
    logs_dir.mkdir(exist_ok=True)
    checkpoint = args.run_root / "checkpoint.json"
    if checkpoint.exists():
        state = read_json(checkpoint)
        if (
            state["dependencies"] != manifest
            or state["task_order"] != selected
            or state.get("codexzero_mode") != args.codexzero_mode
        ):
            raise SystemExit("Checkpoint dependencies, task order, or mode changed")
    else:
        state = {
            "schema": "codexzero-deepswe-five-way-run-v2",
            "created_at": now(),
            "model": MODEL,
            "reasoning_effort": EFFORT,
            "codexzero_mode": args.codexzero_mode,
            "seed": SEED,
            "task_order": selected,
            "configurations": list(CONFIG_IDS),
            "dependencies": manifest,
            "tasks": {},
        }
        if args.seed_checkpoint is not None:
            seed_state = read_json(args.seed_checkpoint)
            if seed_state.get("dependencies") != manifest:
                raise SystemExit("Seed checkpoint dependencies changed")
            if (
                seed_state.get("model") != MODEL
                or seed_state.get("reasoning_effort") != EFFORT
                or seed_state.get("codexzero_mode") != args.codexzero_mode
            ):
                raise SystemExit("Seed checkpoint model or mode changed")
            for task_name, seeded_task in seed_state.get("tasks", {}).items():
                if task_name not in selected:
                    continue
                completed: dict[str, str] = {}
                for identifier, trial in seeded_task.get("completed", {}).items():
                    if identifier not in CONFIG_IDS:
                        continue
                    status, _ = trial_status(Path(trial), identifier)
                    if status == "complete":
                        completed[identifier] = trial
                if completed:
                    state["tasks"][task_name] = {
                        "completed": completed,
                        "attempts": seeded_task.get("attempts", []),
                        "status": (
                            "complete"
                            if len(completed) == len(CONFIG_IDS)
                            else "incomplete"
                        ),
                    }
            state["seed_checkpoint"] = {
                "sha256": sha256(args.seed_checkpoint),
                "accepted_complete_trials": sum(
                    len(task["completed"]) for task in state["tasks"].values()
                ),
            }
        save(checkpoint, state)

    all_agents = {
        identifier: agent(
            identifier,
            auth=args.auth,
            codexzero_binary=args.codexzero_binary,
            codexzero_mode=args.codexzero_mode,
            lean_prompt=args.lean_prompt,
            rtk_binary=args.rtk_binary,
            rtk_instructions=args.rtk_instructions,
            caveman_skill=args.caveman_skill,
            caveman_activation=args.caveman_activation,
            combined_instructions=args.combined_instructions,
        )
        for identifier in CONFIG_IDS
    }

    for index, task_name in enumerate(selected):
        task_state = state["tasks"].setdefault(
            task_name, {"completed": {}, "attempts": [], "status": "pending"}
        )
        missing = [
            identifier
            for identifier in CONFIG_IDS
            if identifier not in task_state["completed"]
        ]
        attempt = len(task_state["attempts"]) + 1
        while missing and attempt <= args.max_attempts:
            job_name = (
                f"sol-high-fiveway-{index:03d}-{task_name[:45]}-a{attempt}"
            )
            config_path = configs_dir / f"{job_name}.json"
            config_path.write_text(
                json.dumps(
                    job_config(
                        job_name=job_name,
                        jobs_dir=args.jobs_dir,
                        tasks_dir=args.tasks_dir,
                        task_name=task_name,
                        agents=[all_agents[identifier] for identifier in missing],
                    ),
                    indent=2,
                )
                + "\n",
                encoding="utf-8",
            )
            stdout_path = logs_dir / f"{job_name}.stdout.txt"
            stderr_path = logs_dir / f"{job_name}.stderr.txt"
            started = now()
            with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
                process = subprocess.run(
                    [str(args.pier), "run", "--config", str(config_path)],
                    stdout=stdout,
                    stderr=stderr,
                    check=False,
                )
            job_dir = args.jobs_dir / job_name
            trials = find_trials(job_dir)
            statuses: dict[str, Any] = {}
            quota = False
            for identifier in missing:
                trial_path = trials.get(identifier)
                if trial_path is None:
                    status, detail = "incomplete", "trial directory not found"
                else:
                    status, detail = trial_status(trial_path, identifier)
                statuses[identifier] = {
                    "status": status,
                    "detail": detail,
                    "trial": str(trial_path) if trial_path else None,
                }
                if status == "complete" and trial_path is not None:
                    task_state["completed"][identifier] = str(trial_path)
                quota = quota or status == "quota"
            task_state["attempts"].append(
                {
                    "attempt": attempt,
                    "job_name": job_name,
                    "started_at": started,
                    "finished_at": now(),
                    "returncode": process.returncode,
                    "statuses": statuses,
                    "config_sha256": sha256(config_path),
                }
            )
            missing = [
                identifier
                for identifier in CONFIG_IDS
                if identifier not in task_state["completed"]
            ]
            task_state["status"] = (
                "complete" if not missing else "quota" if quota else "incomplete"
            )
            save(checkpoint, state)
            print(
                f"{task_name}: {len(task_state['completed'])}/"
                f"{len(CONFIG_IDS)} complete"
            )
            if quota:
                print("Provider usage limit reached; checkpoint saved.", file=sys.stderr)
                return 75
            attempt += 1
        if missing:
            print(
                f"{task_name}: incomplete after {args.max_attempts} attempts",
                file=sys.stderr,
            )
            return 2

    state["completed_at"] = now()
    save(checkpoint, state)
    print(f"Completed {len(selected)} tasks across {len(CONFIG_IDS)} configurations")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
