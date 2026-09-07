#!/usr/bin/env python3
"""Prepare and run a resumable Terminal-Bench profile matrix.

The controller intentionally treats one benchmark task as the safe pause unit:
all still-missing arms for that task are submitted together, and no later task
is scheduled until the current task has a scored result for every arm.

Harbor's result files remain the source of truth.  This controller records a
separate disposition for each attempt and never turns an infrastructure error
into a synthetic benchmark score.
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import os
import random
import re
import signal
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


SCHEMA = "codexzero-terminal-bench-eight-way-run-v1"
PLAN_SCHEMA = "codexzero-terminal-bench-eight-way-plan-v1"
ARMS_SCHEMA = "codexzero-terminal-bench-eight-way-arms-v1"
MODEL = os.environ.get("TB_MODEL", "gpt-5.6-sol")
EFFORT = os.environ.get("TB_REASONING_EFFORT", "medium")
DEFAULT_SEED = 2514
DEFAULT_TASK_COUNT = 89
DEFAULT_AGENT_TIMEOUT_SEC = 900

ARM_IDS = tuple(
    identifier.strip()
    for identifier in os.environ.get("TB_ARM_IDS", "tura_balanced").split(",")
    if identifier.strip()
)
if not ARM_IDS:
    raise SystemExit("TB_ARM_IDS must contain at least one benchmark profile")

QUOTA_PATTERNS = (
    "you've hit your usage limit",
    "you have hit your usage limit",
    "your usage limit will reset",
    "you have no weighted tokens left",
    "insufficient_quota",
    "billing_hard_limit_reached",
    "usage_limit_reached",
    "quota_exceeded",
    "usage cap",
)

CANCELLED_EXCEPTION_TYPES = {
    "cancellederror",
    "keyboardinterrupt",
    "operatorinterruptederror",
}

# These are objective infrastructure classes.  They are deliberately narrow:
# an unknown exception is not silently retried when Harbor produced a reward.
INFRASTRUCTURE_EXCEPTION_TYPES = {
    "agentauthenticationerror",
    "apiconnectionclosederror",
    "apiratelimiterror",
    "apiusagelimiterror",
    "dockercomposeerror",
    "environmentbuilderror",
    "environmentstarterror",
    "agentsetuperror",
    "authenticationerror",
    "transporterror",
    "connectionerror",
    "networkconnectionerror",
    "rewardfilenotfounderror",
    "rewardfileemptyerror",
    "verifieroutputparseerror",
    "verifiertimeouterror",
}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def sha256_file(path: Path) -> str:
    return sha256_bytes(path.read_bytes())


def tree_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    for item in sorted(candidate for candidate in path.rglob("*") if candidate.is_file()):
        digest.update(item.relative_to(path).as_posix().encode("utf-8"))
        digest.update(b"\0")
        digest.update(item.read_bytes())
        digest.update(b"\0")
    return digest.hexdigest()


def canonical_json(value: Any) -> bytes:
    return (
        json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        .encode("utf-8")
    )


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def atomic_write_bytes(path: Path, raw: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    try:
        with temporary.open("wb") as handle:
            handle.write(raw)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary.exists():
            temporary.unlink()


def atomic_write_json(path: Path, value: Any) -> None:
    atomic_write_bytes(
        path,
        json.dumps(value, indent=2, ensure_ascii=False).encode("utf-8") + b"\n",
    )


def write_once_json(path: Path, value: Any) -> None:
    if path.exists():
        if canonical_json(read_json(path)) != canonical_json(value):
            raise SystemExit(f"Refusing to overwrite drifted sealed file: {path}")
        return
    atomic_write_json(path, value)


def contains_quota(value: Any) -> bool:
    text = (
        value
        if isinstance(value, str)
        else json.dumps(value, sort_keys=True, ensure_ascii=False)
    ).lower()
    return any(pattern in text for pattern in QUOTA_PATTERNS)


def exception_type(result: dict[str, Any]) -> str:
    exception = result.get("exception_info") or {}
    return str(exception.get("exception_type") or "").lower()


def reward_payload(result: dict[str, Any]) -> dict[str, Any] | None:
    verifier = result.get("verifier_result")
    if not isinstance(verifier, dict):
        return None
    rewards = verifier.get("rewards")
    return rewards if isinstance(rewards, dict) and rewards else None


def trial_arm_id(trial_dir: Path) -> str | None:
    for candidate in (trial_dir / "result.json", trial_dir / "config.json"):
        if not candidate.is_file():
            continue
        try:
            payload = read_json(candidate)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        config = payload.get("config", payload)
        agent = config.get("agent") or {}
        env = agent.get("env") or {}
        identifier = env.get("CODEX_BENCHMARK_LABEL") or env.get(
            "TURA_BENCHMARK_LABEL"
        )
        if identifier in ARM_IDS:
            return str(identifier)
    return None


def trial_text(trial_dir: Path) -> str:
    chunks: list[str] = []
    candidates = (
        trial_dir / "exception.txt",
        trial_dir / "trial.log",
        trial_dir / "agent" / "codex.txt",
        trial_dir / "agent" / "stdout.jsonl",
        trial_dir / "agent" / "stderr.txt",
    )
    for candidate in candidates:
        if candidate.is_file():
            chunks.append(
                candidate.read_text(encoding="utf-8", errors="replace").lower()
            )
    return "\n".join(chunks)


def quota_evidence_text(trial_dir: Path) -> str:
    """Read only error-bearing evidence, never prompt-bearing transcript text."""
    chunks: list[str] = []
    for candidate in (
        trial_dir / "exception.txt",
        trial_dir / "agent" / "stderr.txt",
    ):
        if candidate.is_file():
            chunks.append(candidate.read_text(encoding="utf-8", errors="replace"))
    stream = trial_dir / "agent" / "stdout.jsonl"
    if stream.is_file():
        for line in stream.read_text(
            encoding="utf-8", errors="replace"
        ).splitlines():
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            event_type = str(event.get("type") or "").lower()
            if event_type in {"turn.failed", "error"}:
                chunks.append(json.dumps(event, ensure_ascii=False, sort_keys=True))
    return "\n".join(chunks)


def activation_status(
    trial_dir: Path,
    activation: dict[str, Any] | None,
) -> tuple[bool, str | None]:
    if not activation:
        return True, None
    for relative in activation.get("required_files", []):
        if not (trial_dir / relative).is_file():
            return False, f"missing activation artifact: {relative}"
    text = trial_text(trial_dir)
    for pattern in activation.get("required_log_patterns", []):
        if re.search(str(pattern), text, flags=re.IGNORECASE) is None:
            return False, f"activation pattern not observed: {pattern}"
    for pattern in activation.get("forbidden_log_patterns", []):
        if re.search(str(pattern), text, flags=re.IGNORECASE) is not None:
            return False, f"forbidden activation pattern observed: {pattern}"
    return True, None


def classify_trial(
    trial_dir: Path,
    *,
    activation: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Classify controller disposition without rewriting Harbor's result."""
    result_path = trial_dir / "result.json"
    if not result_path.is_file():
        text = quota_evidence_text(trial_dir)
        if contains_quota(text):
            return {
                "disposition": "quota",
                "scored": False,
                "retryable": True,
                "detail": "provider usage limit",
            }
        return {
            "disposition": "incomplete",
            "scored": False,
            "retryable": True,
            "detail": "missing result.json",
        }

    try:
        result = read_json(result_path)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as error:
        return {
            "disposition": "infrastructure",
            "scored": False,
            "retryable": True,
            "detail": f"unreadable result.json: {error}",
        }

    exception = result.get("exception_info") or {}
    kind = exception_type(result)
    if contains_quota(exception):
        disposition = "quota"
        detail = "provider usage limit"
    elif kind in CANCELLED_EXCEPTION_TYPES or "cancelled" in kind:
        disposition = "operator_interrupted"
        detail = kind or "cancelled"
    else:
        disposition = ""
        detail = None

    if disposition:
        return {
            "disposition": disposition,
            "scored": False,
            "retryable": True,
            "detail": detail,
            "result_sha256": sha256_file(result_path),
            "exception_type": kind or None,
        }

    rewards = reward_payload(result)
    if rewards is not None:
        active, activation_detail = activation_status(trial_dir, activation)
        return {
            "disposition": "scored" if active else "activation_invalid",
            "scored": active,
            "retryable": not active,
            "detail": activation_detail,
            "result_sha256": sha256_file(result_path),
            "exception_type": kind or None,
            "rewards": rewards,
        }

    # A timeout is a terminal quality outcome. If Harbor could not run the
    # verifier afterward, retain that fact and count the attempt as zero.
    if kind == "agenttimeouterror":
        return {
            "disposition": "terminal_agent_failure",
            "scored": True,
            "retryable": False,
            "detail": (
                "AgentTimeoutError counted as zero; Harbor verifier reward missing"
            ),
            "result_sha256": sha256_file(result_path),
            "exception_type": kind,
            "rewards": {"reward": 0.0},
            "synthetic_zero": True,
        }

    if kind in INFRASTRUCTURE_EXCEPTION_TYPES:
        return {
            "disposition": "infrastructure",
            "scored": False,
            "retryable": True,
            "detail": kind,
            "result_sha256": sha256_file(result_path),
            "exception_type": kind,
        }

    # A terminal agent-process failure is an unsuccessful benchmark attempt,
    # not missing data. Count it as zero while retaining the untouched Harbor
    # result and the fact that no verifier reward was produced. Known setup,
    # quota, cancellation, and infrastructure failures were handled above.
    return {
        "disposition": "terminal_agent_failure",
        "scored": True,
        "retryable": False,
        "detail": (
            "terminal agent failure counted as zero; "
            f"exception={kind or 'none'}; Harbor verifier reward missing"
        ),
        "result_sha256": sha256_file(result_path),
        "exception_type": kind or None,
        "rewards": {"reward": 0.0},
        "synthetic_zero": True,
    }


def discover_local_dataset(
    tasks_dir: Path,
    *,
    expected_count: int,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    tasks_dir = tasks_dir.resolve()
    tasks = sorted(
        item
        for item in tasks_dir.iterdir()
        if item.is_dir() and (item / "task.toml").is_file()
    )
    if len(tasks) != expected_count:
        raise SystemExit(
            f"Expected {expected_count} tasks under {tasks_dir}, found {len(tasks)}"
        )
    entries = [
        {
            "name": item.name,
            "path": str(item),
            "tree_sha256": tree_sha256(item),
        }
        for item in tasks
    ]
    return (
        {
            "kind": "local",
            "path": str(tasks_dir),
            "task_count": len(entries),
            "tree_sha256": sha256_bytes(canonical_json(entries)),
        },
        entries,
    )


def discover_registry_dataset(
    registry_path: Path,
    *,
    name: str,
    version: str,
    expected_count: int,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    registry_path = registry_path.resolve()
    registry = read_json(registry_path)
    matches = [
        row
        for row in registry
        if row.get("name") == name and str(row.get("version")) == version
    ]
    if len(matches) != 1:
        raise SystemExit(
            f"Registry must contain exactly one {name}@{version}; found {len(matches)}"
        )
    dataset = matches[0]
    raw_tasks = dataset.get("tasks") or []
    names = [str(task.get("name") or "") for task in raw_tasks]
    if len(raw_tasks) != expected_count:
        raise SystemExit(
            f"Expected {expected_count} registry tasks, found {len(raw_tasks)}"
        )
    if len(names) != len(set(names)) or any(not name for name in names):
        raise SystemExit("Registry task names must be non-empty and unique")
    entries = [
        {
            "name": str(task["name"]),
            "git_url": task.get("git_url"),
            "git_commit_id": task.get("git_commit_id"),
            "path": task.get("path"),
        }
        for task in raw_tasks
    ]
    commits = sorted(
        {str(task["git_commit_id"]) for task in entries if task.get("git_commit_id")}
    )
    return (
        {
            "kind": "registry",
            "name": name,
            "version": version,
            "registry_path": str(registry_path),
            "registry_sha256": sha256_file(registry_path),
            "task_count": len(entries),
            "git_commits": commits,
            "tasks_sha256": sha256_bytes(canonical_json(entries)),
        },
        entries,
    )


def dependency_seal(manifest: dict[str, Any]) -> list[dict[str, Any]]:
    sealed: list[dict[str, Any]] = []
    for row in manifest.get("dependencies", []):
        name = str(row.get("name") or "")
        path = Path(str(row.get("path") or "")).expanduser().resolve()
        if not name or not path.exists():
            raise SystemExit(f"Missing dependency {name or '<unnamed>'}: {path}")
        secret = bool(row.get("secret"))
        if path.is_dir():
            digest = None if secret else tree_sha256(path)
            kind = "directory"
        else:
            digest = None if secret else sha256_file(path)
            kind = "file"
        expected = row.get("sha256")
        if expected and digest and str(expected).lower() != digest.lower():
            raise SystemExit(f"Dependency hash changed for {name}")
        sealed.append(
            {
                "name": name,
                "kind": kind,
                "path": str(path),
                "secret": secret,
                "sha256": digest,
            }
        )
    return sealed


def validate_arms_manifest(path: Path) -> tuple[dict[str, Any], dict[str, Any]]:
    manifest = read_json(path)
    if manifest.get("schema") != ARMS_SCHEMA:
        raise SystemExit(f"Unsupported arms manifest schema: {manifest.get('schema')}")
    if manifest.get("model") != MODEL or manifest.get("reasoning_effort") != EFFORT:
        raise SystemExit(f"Every arm must use {MODEL} with {EFFORT} effort")
    rows = manifest.get("arms")
    if not isinstance(rows, list):
        raise SystemExit("Arms manifest must contain an arms list")
    identifiers = [row.get("id") for row in rows]
    if len(identifiers) != len(set(identifiers)):
        raise SystemExit("Arm identifiers must be unique")
    if set(identifiers) != set(ARM_IDS):
        missing = sorted(set(ARM_IDS) - set(identifiers))
        extra = sorted(set(identifiers) - set(ARM_IDS))
        raise SystemExit(f"Arms mismatch; missing={missing}, extra={extra}")

    by_id: dict[str, Any] = {}
    for row in rows:
        identifier = str(row["id"])
        agent = copy.deepcopy(row.get("agent"))
        if not isinstance(agent, dict):
            raise SystemExit(f"{identifier} has no Harbor agent config")
        is_tura = identifier.startswith("tura_")
        expected_agent_model = f"codex/{MODEL}" if is_tura else MODEL
        if agent.get("model_name") != expected_agent_model:
            raise SystemExit(
                f"{identifier} Harbor model must be {expected_agent_model}"
            )
        kwargs = agent.setdefault("kwargs", {})
        env = agent.setdefault("env", {})
        configured_effort = (
            env.get("TURA_REASONING_EFFORT")
            if is_tura
            else kwargs.get("reasoning_effort")
        )
        if configured_effort != EFFORT:
            raise SystemExit(f"{identifier} reasoning_effort must be {EFFORT}")
        label_key = (
            "TURA_BENCHMARK_LABEL"
            if is_tura
            else "CODEX_BENCHMARK_LABEL"
        )
        if env.get(label_key) != identifier:
            raise SystemExit(
                f"{identifier} must persist {label_key}={identifier}"
            )
        agent["override_timeout_sec"] = DEFAULT_AGENT_TIMEOUT_SEC
        agent["max_timeout_sec"] = DEFAULT_AGENT_TIMEOUT_SEC
        by_id[identifier] = {
            "agent": agent,
            "activation": copy.deepcopy(row.get("activation") or {}),
        }
    return manifest, by_id


def prescribed_task_order(
    manifest_path: Path,
    task_entries: list[dict[str, Any]],
    *,
    expected_count: int,
) -> tuple[list[str], dict[str, Any]]:
    """Load and seal the preregistered task order without re-randomizing it."""
    payload = read_json(manifest_path)
    rows = payload.get("tasks")
    if not isinstance(rows, list) or len(rows) != expected_count:
        raise SystemExit(
            f"Dataset manifest must contain {expected_count} task rows"
        )
    ordered = [str(row.get("name") or "") for row in rows]
    if any(not name for name in ordered) or len(ordered) != len(set(ordered)):
        raise SystemExit("Dataset manifest task names must be non-empty and unique")
    discovered = {str(row["name"]) for row in task_entries}
    if set(ordered) != discovered:
        raise SystemExit(
            "Dataset manifest names do not exactly match the discovered dataset"
        )
    indexes = [row.get("index") for row in rows]
    valid_indexes = list(range(1, expected_count + 1))
    if indexes != valid_indexes:
        raise SystemExit("Dataset manifest indexes must be contiguous and one-based")
    return ordered, {
        "path": str(manifest_path.resolve()),
        "sha256": sha256_file(manifest_path),
        "schema": payload.get("schema"),
        "ordering_method": payload.get("ordering_method"),
        "ordering_seed": payload.get("ordering_seed"),
        "git_commit": payload.get("git_commit"),
        "public_name": payload.get("public_name"),
    }


def stable_arm_order(task_name: str, *, seed: int) -> list[str]:
    identifiers = list(ARM_IDS)
    material = hashlib.sha256(f"{seed}:{task_name}".encode("utf-8")).digest()
    random.Random(int.from_bytes(material[:8], "big")).shuffle(identifiers)
    return identifiers


def build_plan(
    *,
    arms_manifest_path: Path,
    arms_manifest: dict[str, Any],
    dataset: dict[str, Any],
    task_entries: list[dict[str, Any]],
    dependencies: list[dict[str, Any]],
    harbor: Path,
    jobs_dir: Path,
    run_root: Path,
    seed: int,
    task_order: list[str] | None = None,
    dataset_manifest: dict[str, Any] | None = None,
) -> dict[str, Any]:
    task_names = [row["name"] for row in task_entries]
    if len(task_names) != len(set(task_names)):
        raise SystemExit("Dataset task names are not unique")
    if task_order is None:
        random.Random(seed).shuffle(task_names)
    else:
        if len(task_order) != len(task_names) or set(task_order) != set(task_names):
            raise SystemExit("Prescribed task order does not match dataset tasks")
        task_names = list(task_order)
    entry_lookup = {row["name"]: row for row in task_entries}
    tasks = [
        {
            "index": index,
            **entry_lookup[name],
            "arm_order": stable_arm_order(name, seed=seed),
        }
        for index, name in enumerate(task_names)
    ]
    policy = {
        "task_major": True,
        "initial_concurrency": len(ARM_IDS),
        "quality_retries": 0,
        "scored": (
            "Any parseable Harbor verifier reward, including zero and agent "
            "timeouts; terminal agent-process failures count as zero with the "
            "raw exception retained and synthetic_zero=true."
        ),
        "unscored_retryable": [
            "provider quota",
            "operator interruption",
            "sealed infrastructure failure",
            "objective activation failure",
        ],
        "unscored_not_retryable": [],
        "pause_boundary": "Between task jobs. Mid-job results are reconciled by arm.",
        "paired_reporting": "Largest ordered prefix with all eight arms scored.",
    }
    return {
        "schema": PLAN_SCHEMA,
        "created_at": utc_now(),
        "model": MODEL,
        "reasoning_effort": EFFORT,
        "seed": seed,
        "controller": {
            "path": str(Path(__file__).resolve()),
            "sha256": sha256_file(Path(__file__).resolve()),
        },
        "harbor": {
            "path": str(harbor.resolve()),
            "sha256": sha256_file(harbor.resolve()),
        },
        "harbor_env": copy.deepcopy(arms_manifest.get("harbor_env") or {}),
        "jobs_dir": str(jobs_dir.resolve()),
        "run_root": str(run_root.resolve()),
        "arms_manifest": {
            "path": str(arms_manifest_path.resolve()),
            "sha256": sha256_file(arms_manifest_path),
            "schema": arms_manifest.get("schema"),
        },
        "configurations": list(ARM_IDS),
        "environment": copy.deepcopy(arms_manifest.get("environment") or {}),
        "verifier": copy.deepcopy(
            arms_manifest.get("verifier") or {"disable": False}
        ),
        "dependencies": dependencies,
        "dataset": dataset,
        "dataset_manifest": dataset_manifest,
        "tasks": tasks,
        "disposition_policy": policy,
    }


def dataset_config(plan: dict[str, Any], task_name: str) -> dict[str, Any]:
    dataset = plan["dataset"]
    if dataset["kind"] == "local":
        return {
            "path": dataset["path"],
            "task_names": [task_name],
        }
    return {
        "name": dataset["name"],
        "version": dataset["version"],
        "registry_path": dataset["registry_path"],
        "task_names": [task_name],
    }


def safe_slug(value: str, limit: int = 36) -> str:
    slug = re.sub(r"[^a-zA-Z0-9_.-]+", "-", value).strip("-").lower()
    suffix = hashlib.sha256(value.encode("utf-8")).hexdigest()[:8]
    return f"{slug[:limit]}-{suffix}" if slug else suffix


def build_job_config(
    *,
    plan: dict[str, Any],
    task: dict[str, Any],
    attempt: int,
    missing: list[str],
    arm_configs: dict[str, Any],
) -> tuple[str, dict[str, Any]]:
    ordered_missing = [
        identifier for identifier in task["arm_order"] if identifier in missing
    ]
    job_name = (
        f"tb21-8way-t{task['index']:03d}-a{attempt:03d}-"
        f"{safe_slug(task['name'])}"
    )
    environment = {
        "type": "docker",
        "force_build": False,
        "delete": True,
        **copy.deepcopy(plan.get("environment") or {}),
    }
    config = {
        "job_name": job_name,
        "jobs_dir": plan["jobs_dir"],
        "n_attempts": 1,
        "install_only": False,
        "timeout_multiplier": 1.0,
        "n_concurrent_trials": len(ordered_missing),
        "quiet": False,
        "retry": {"max_retries": 0},
        "environment": environment,
        "verifier": copy.deepcopy(plan.get("verifier") or {"disable": False}),
        "agents": [
            copy.deepcopy(arm_configs[identifier]["agent"])
            for identifier in ordered_missing
        ],
        "datasets": [dataset_config(plan, task["name"])],
    }
    return job_name, config


def config_task_name(config: dict[str, Any]) -> str | None:
    datasets = config.get("datasets") or []
    if len(datasets) != 1:
        return None
    names = datasets[0].get("task_names") or []
    return str(names[0]) if len(names) == 1 else None


def find_trials(job_dir: Path) -> dict[str, list[Path]]:
    found: dict[str, list[Path]] = {identifier: [] for identifier in ARM_IDS}
    if not job_dir.is_dir():
        return found
    for child in sorted(job_dir.iterdir()):
        if not child.is_dir():
            continue
        identifier = trial_arm_id(child)
        if identifier:
            found[identifier].append(child)
    return found


def attempt_configs_for_task(
    configs_dir: Path,
    *,
    task_index: int,
    task_name: str,
) -> list[tuple[int, Path, dict[str, Any]]]:
    prefix = f"tb21-8way-t{task_index:03d}-a"
    rows: list[tuple[int, Path, dict[str, Any]]] = []
    for path in sorted(configs_dir.glob(f"{prefix}*.json")):
        match = re.match(rf"^{re.escape(prefix)}(\d+)-", path.stem)
        if not match:
            continue
        try:
            config = read_json(path)
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
        if config_task_name(config) != task_name:
            raise SystemExit(f"Config/task collision detected: {path}")
        rows.append((int(match.group(1)), path, config))
    return sorted(rows)


def reconcile(
    *,
    plan: dict[str, Any],
    arm_configs: dict[str, Any],
) -> dict[str, Any]:
    run_root = Path(plan["run_root"])
    configs_dir = run_root / "configs"
    jobs_dir = Path(plan["jobs_dir"])
    task_states: dict[str, Any] = {}
    for task in plan["tasks"]:
        accepted: dict[str, Any] = {}
        attempts: list[dict[str, Any]] = []
        for attempt, config_path, config in attempt_configs_for_task(
            configs_dir,
            task_index=int(task["index"]),
            task_name=str(task["name"]),
        ):
            job_name = str(config.get("job_name") or "")
            job_dir = jobs_dir / job_name
            found = find_trials(job_dir)
            statuses: dict[str, Any] = {}
            configured_ids = [
                str(
                    (agent.get("env") or {}).get("CODEX_BENCHMARK_LABEL")
                    or (agent.get("env") or {}).get("TURA_BENCHMARK_LABEL")
                    or ""
                )
                for agent in config.get("agents", [])
            ]
            for identifier in configured_ids:
                candidates = found.get(identifier, [])
                if len(candidates) > 1:
                    status = {
                        "disposition": "infrastructure",
                        "scored": False,
                        "retryable": False,
                        "detail": "multiple trial directories for one arm in one attempt",
                    }
                    trial = None
                elif candidates:
                    trial = candidates[0]
                    status = classify_trial(
                        trial,
                        activation=arm_configs[identifier]["activation"],
                    )
                else:
                    trial = None
                    status = {
                        "disposition": "incomplete",
                        "scored": False,
                        "retryable": True,
                        "detail": "trial directory not found",
                    }
                statuses[identifier] = {
                    **status,
                    "trial": str(trial) if trial else None,
                }
                if status["scored"] and identifier not in accepted and trial:
                    accepted[identifier] = {
                        "attempt": attempt,
                        "job_name": job_name,
                        "trial": str(trial),
                        "result_sha256": status.get("result_sha256"),
                        "rewards": status.get("rewards"),
                        "exception_type": status.get("exception_type"),
                    }
            meta_path = run_root / "attempts" / f"{job_name}.json"
            attempts.append(
                {
                    "attempt": attempt,
                    "job_name": job_name,
                    "config": str(config_path),
                    "config_sha256": sha256_file(config_path),
                    "job_dir": str(job_dir),
                    "meta": read_json(meta_path) if meta_path.is_file() else None,
                    "statuses": statuses,
                }
            )
        missing = [
            identifier for identifier in task["arm_order"] if identifier not in accepted
        ]
        blockers = [
            {
                "arm": identifier,
                **status,
            }
            for attempt in attempts
            for identifier, status in attempt["statuses"].items()
            if not status["scored"] and not status["retryable"]
        ]
        dispositions = {
            status["disposition"]
            for attempt in attempts
            for status in attempt["statuses"].values()
        }
        task_states[task["name"]] = {
            "index": task["index"],
            "status": (
                "complete"
                if not missing
                else "blocked"
                if blockers
                else "quota"
                if "quota" in dispositions
                else "incomplete"
            ),
            "accepted": accepted,
            "missing": missing,
            "blockers": blockers,
            "attempts": attempts,
        }

    paired_prefix = 0
    for task in plan["tasks"]:
        if task_states[task["name"]]["status"] != "complete":
            break
        paired_prefix += 1
    completed_tasks = sum(
        state["status"] == "complete" for state in task_states.values()
    )
    scored_cells = sum(len(state["accepted"]) for state in task_states.values())
    return {
        "schema": SCHEMA,
        "updated_at": utc_now(),
        "plan_sha256": sha256_bytes(canonical_json(plan)),
        "model": MODEL,
        "reasoning_effort": EFFORT,
        "task_count": len(plan["tasks"]),
        "configuration_count": len(ARM_IDS),
        "completed_tasks": completed_tasks,
        "scored_cells": scored_cells,
        "expected_cells": len(plan["tasks"]) * len(ARM_IDS),
        "paired_prefix_tasks": paired_prefix,
        "paired_prefix_cells": paired_prefix * len(ARM_IDS),
        "next_task": (
            plan["tasks"][paired_prefix]["name"]
            if paired_prefix < len(plan["tasks"])
            else None
        ),
        "tasks": task_states,
    }


def save_checkpoint(run_root: Path, state: dict[str, Any]) -> None:
    atomic_write_json(run_root / "checkpoint.json", state)


def status_summary(state: dict[str, Any]) -> dict[str, Any]:
    dispositions: dict[str, int] = {}
    for task in state["tasks"].values():
        for attempt in task["attempts"]:
            for status in attempt["statuses"].values():
                key = status["disposition"]
                dispositions[key] = dispositions.get(key, 0) + 1
    return {
        key: state[key]
        for key in (
            "model",
            "reasoning_effort",
            "task_count",
            "configuration_count",
            "completed_tasks",
            "scored_cells",
            "expected_cells",
            "paired_prefix_tasks",
            "paired_prefix_cells",
            "next_task",
        )
    } | {"attempt_dispositions": dict(sorted(dispositions.items()))}


def emit_status(state: dict[str, Any], *, json_output: bool) -> None:
    summary = status_summary(state)
    if json_output:
        print(json.dumps(summary, indent=2))
        return
    print(
        f"Paired prefix: {summary['paired_prefix_tasks']}/{summary['task_count']} "
        f"tasks ({summary['paired_prefix_cells']}/{summary['expected_cells']} cells)"
    )
    print(
        f"All scored cells: {summary['scored_cells']}/{summary['expected_cells']}; "
        f"next task: {summary['next_task'] or 'none'}"
    )
    if summary["attempt_dispositions"]:
        print(
            "Attempt dispositions: "
            + ", ".join(
                f"{key}={value}"
                for key, value in summary["attempt_dispositions"].items()
            )
        )


def process_is_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


class ControllerLock:
    def __init__(self, path: Path):
        self.path = path
        self.owned = False

    def __enter__(self) -> "ControllerLock":
        self.path.parent.mkdir(parents=True, exist_ok=True)
        payload = {"pid": os.getpid(), "created_at": utc_now()}
        try:
            descriptor = os.open(
                self.path,
                os.O_CREAT | os.O_EXCL | os.O_WRONLY,
                0o600,
            )
        except FileExistsError:
            try:
                existing = read_json(self.path)
                pid = int(existing.get("pid") or 0)
            except Exception:
                pid = 0
            if process_is_alive(pid):
                raise SystemExit(f"Another controller is active (PID {pid})")
            stale = self.path.with_name(f"{self.path.name}.stale-{uuid.uuid4().hex}")
            os.replace(self.path, stale)
            return self.__enter__()
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(payload, handle)
            handle.flush()
            os.fsync(handle.fileno())
        self.owned = True
        return self

    def __exit__(self, *_: Any) -> None:
        if self.owned:
            self.path.unlink(missing_ok=True)


def next_attempt_number(
    configs_dir: Path,
    *,
    task_index: int,
    task_name: str,
) -> int:
    rows = attempt_configs_for_task(
        configs_dir,
        task_index=task_index,
        task_name=task_name,
    )
    return max((row[0] for row in rows), default=0) + 1


def run_job(
    *,
    harbor: Path,
    harbor_env: dict[str, str],
    config_path: Path,
    job_name: str,
    run_root: Path,
) -> int:
    logs_dir = run_root / "logs"
    attempts_dir = run_root / "attempts"
    logs_dir.mkdir(parents=True, exist_ok=True)
    attempts_dir.mkdir(parents=True, exist_ok=True)
    stdout_path = logs_dir / f"{job_name}.stdout.txt"
    stderr_path = logs_dir / f"{job_name}.stderr.txt"
    meta_path = attempts_dir / f"{job_name}.json"
    command = [str(harbor), "run", "--config", str(config_path), "--yes"]
    started = utc_now()
    process_env = os.environ.copy()
    process_env.update({str(key): str(value) for key, value in harbor_env.items()})
    popen_kwargs: dict[str, Any] = {}
    if os.name == "nt":
        popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP
    else:
        # Keep a controller Ctrl-C from also cancelling Harbor. Harbor persists
        # cancellation results as completed, so the first interrupt must only
        # create STOP and wait for the current task wave.
        popen_kwargs["start_new_session"] = True
    with stdout_path.open("wb") as stdout, stderr_path.open("wb") as stderr:
        process = subprocess.Popen(
            command,
            stdout=stdout,
            stderr=stderr,
            env=process_env,
            **popen_kwargs,
        )
        atomic_write_json(
            meta_path,
            {
                "job_name": job_name,
                "config": str(config_path),
                "config_sha256": sha256_file(config_path),
                "command": command,
                "harbor_env_keys": sorted(harbor_env),
                "pid": process.pid,
                "started_at": started,
                "status": "running",
            },
        )
        interrupted = False
        try:
            returncode = process.wait()
        except KeyboardInterrupt:
            # A single interrupt requests a graceful stop.  Do not terminate
            # Harbor mid-task, because Harbor persists cancellations as results.
            interrupted = True
            atomic_write_bytes(run_root / "STOP", b"operator requested stop\n")
            print(
                "\nStop requested; waiting for the current task wave to finish. "
                "A second interrupt will terminate Harbor and censor unfinished arms.",
                file=sys.stderr,
            )
            try:
                returncode = process.wait()
            except KeyboardInterrupt:
                if os.name == "nt":
                    process.terminate()
                else:
                    process.send_signal(signal.SIGINT)
                try:
                    returncode = process.wait(timeout=90)
                except subprocess.TimeoutExpired:
                    process.kill()
                    returncode = process.wait()
        atomic_write_json(
            meta_path,
            {
                "job_name": job_name,
                "config": str(config_path),
                "config_sha256": sha256_file(config_path),
                "command": command,
                "harbor_env_keys": sorted(harbor_env),
                "pid": process.pid,
                "started_at": started,
                "finished_at": utc_now(),
                "returncode": returncode,
                "operator_stop_requested": interrupted,
                "status": "finished",
                "stdout": str(stdout_path),
                "stderr": str(stderr_path),
            },
        )
        return returncode


def load_prepared_run(
    run_root: Path,
    arms_manifest_path: Path | None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    plan_path = run_root / "plan.json"
    if not plan_path.is_file():
        raise SystemExit(f"No prepared plan at {plan_path}")
    plan = read_json(plan_path)
    controller = plan.get("controller") or {}
    if sha256_file(Path(controller["path"])) != controller.get("sha256"):
        raise SystemExit("Benchmark controller changed since the plan was sealed")
    harbor = plan.get("harbor") or {}
    if sha256_file(Path(harbor["path"])) != harbor.get("sha256"):
        raise SystemExit("Harbor executable changed since the plan was sealed")
    manifest_path = (
        arms_manifest_path
        if arms_manifest_path is not None
        else Path(plan["arms_manifest"]["path"])
    )
    manifest, arm_configs = validate_arms_manifest(manifest_path)
    if sha256_file(manifest_path) != plan["arms_manifest"]["sha256"]:
        raise SystemExit("Arms manifest changed since the plan was sealed")
    if manifest.get("environment", {}) != plan.get("environment", {}):
        raise SystemExit("Environment config changed since the plan was sealed")
    if manifest.get("verifier", {"disable": False}) != plan.get("verifier"):
        raise SystemExit("Verifier config changed since the plan was sealed")
    if dependency_seal(manifest) != plan.get("dependencies"):
        raise SystemExit("A sealed benchmark dependency changed")
    dataset_manifest = plan.get("dataset_manifest")
    if dataset_manifest:
        manifest_path = Path(dataset_manifest["path"])
        if sha256_file(manifest_path) != dataset_manifest["sha256"]:
            raise SystemExit("Dataset manifest changed since the plan was sealed")
    return plan, arm_configs


def prepare(args: argparse.Namespace) -> tuple[dict[str, Any], dict[str, Any]]:
    if args.arms_manifest is None or args.harbor is None or args.jobs_dir is None:
        raise SystemExit(
            "--arms-manifest, --harbor, and --jobs-dir are required to prepare"
        )
    if not args.harbor.is_file():
        raise SystemExit(f"Harbor executable not found: {args.harbor}")
    manifest, arm_configs = validate_arms_manifest(args.arms_manifest)
    dependencies = dependency_seal(manifest)
    if args.tasks_dir is not None:
        dataset, tasks = discover_local_dataset(
            args.tasks_dir,
            expected_count=args.expected_task_count,
        )
    else:
        if args.registry_path is None:
            raise SystemExit("--tasks-dir or --registry-path is required")
        dataset, tasks = discover_registry_dataset(
            args.registry_path,
            name=args.dataset_name,
            version=args.dataset_version,
            expected_count=args.expected_task_count,
        )
    task_order = None
    dataset_manifest = None
    if args.dataset_manifest is not None:
        task_order, dataset_manifest = prescribed_task_order(
            args.dataset_manifest,
            tasks,
            expected_count=args.expected_task_count,
        )
    plan = build_plan(
        arms_manifest_path=args.arms_manifest,
        arms_manifest=manifest,
        dataset=dataset,
        task_entries=tasks,
        dependencies=dependencies,
        harbor=args.harbor,
        jobs_dir=args.jobs_dir,
        run_root=args.run_root,
        seed=args.seed,
        task_order=task_order,
        dataset_manifest=dataset_manifest,
    )
    args.run_root.mkdir(parents=True, exist_ok=True)
    args.jobs_dir.mkdir(parents=True, exist_ok=True)
    (args.run_root / "configs").mkdir(exist_ok=True)
    write_once_json(args.run_root / "plan.json", plan)
    plan_hash = sha256_file(args.run_root / "plan.json")
    seal_path = args.run_root / "PLAN.sha256"
    seal = f"{plan_hash}  plan.json\n".encode("utf-8")
    if seal_path.exists() and seal_path.read_bytes() != seal:
        raise SystemExit(f"Plan seal changed: {seal_path}")
    if not seal_path.exists():
        atomic_write_bytes(seal_path, seal)
    state = reconcile(plan=plan, arm_configs=arm_configs)
    save_checkpoint(args.run_root, state)
    return plan, arm_configs


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-root", type=Path, required=True)
    parser.add_argument("--harbor", type=Path)
    parser.add_argument("--jobs-dir", type=Path)
    parser.add_argument("--arms-manifest", type=Path)
    source = parser.add_mutually_exclusive_group()
    source.add_argument("--tasks-dir", type=Path)
    source.add_argument("--registry-path", type=Path)
    parser.add_argument("--dataset-name", default="terminal-bench")
    parser.add_argument("--dataset-version", default="2.0")
    parser.add_argument(
        "--dataset-manifest",
        type=Path,
        help="Preregistered JSON task order to use exactly.",
    )
    parser.add_argument("--expected-task-count", type=int, default=DEFAULT_TASK_COUNT)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--status", action="store_true")
    parser.add_argument("--json", action="store_true", dest="json_output")
    parser.add_argument(
        "--max-waves",
        type=int,
        help="Maximum task waves to launch in this invocation.",
    )
    parser.add_argument(
        "--acknowledge-quota",
        action="store_true",
        help="Remove the quota stop sentinel before resuming.",
    )
    args = parser.parse_args()
    args.run_root = args.run_root.resolve()

    plan_path = args.run_root / "plan.json"
    if plan_path.exists():
        plan, arm_configs = load_prepared_run(args.run_root, args.arms_manifest)
    elif args.status:
        raise SystemExit(f"No prepared plan at {plan_path}")
    else:
        plan, arm_configs = prepare(args)

    state = reconcile(plan=plan, arm_configs=arm_configs)
    if args.status:
        emit_status(state, json_output=args.json_output)
        return 0
    save_checkpoint(args.run_root, state)
    if args.prepare_only:
        emit_status(state, json_output=args.json_output)
        return 0

    harbor = Path(plan["harbor"]["path"])
    configs_dir = args.run_root / "configs"
    stop_path = args.run_root / "STOP"
    quota_path = args.run_root / "QUOTA_STOP.json"
    if args.acknowledge_quota:
        quota_path.unlink(missing_ok=True)
    if quota_path.exists():
        raise SystemExit(
            f"Quota stop is active: {quota_path}. "
            "Resume with --acknowledge-quota after quota is available."
        )
    launched = 0
    with ControllerLock(args.run_root / "controller.lock"):
        while True:
            state = reconcile(plan=plan, arm_configs=arm_configs)
            save_checkpoint(args.run_root, state)
            if state["paired_prefix_tasks"] == len(plan["tasks"]):
                state["completed_at"] = utc_now()
                save_checkpoint(args.run_root, state)
                emit_status(state, json_output=args.json_output)
                return 0
            if stop_path.exists():
                print(f"Operator stop sentinel found: {stop_path}", file=sys.stderr)
                emit_status(state, json_output=args.json_output)
                return 76
            if args.max_waves is not None and launched >= args.max_waves:
                emit_status(state, json_output=args.json_output)
                return 0

            task = plan["tasks"][state["paired_prefix_tasks"]]
            task_state = state["tasks"][task["name"]]
            if task_state["blockers"]:
                print(
                    f"{task['name']} has non-retryable unscored attempts; "
                    "manual adjudication is required.",
                    file=sys.stderr,
                )
                emit_status(state, json_output=args.json_output)
                return 2
            missing = list(task_state["missing"])
            attempt = next_attempt_number(
                configs_dir,
                task_index=int(task["index"]),
                task_name=str(task["name"]),
            )
            job_name, config = build_job_config(
                plan=plan,
                task=task,
                attempt=attempt,
                missing=missing,
                arm_configs=arm_configs,
            )
            config_path = configs_dir / f"{job_name}.json"
            write_once_json(config_path, config)
            print(
                f"{task['index'] + 1}/{len(plan['tasks'])} {task['name']}: "
                f"launching {len(missing)} missing arm(s)"
            )
            run_job(
                harbor=harbor,
                harbor_env=plan.get("harbor_env") or {},
                config_path=config_path,
                job_name=job_name,
                run_root=args.run_root,
            )
            launched += 1
            state = reconcile(plan=plan, arm_configs=arm_configs)
            save_checkpoint(args.run_root, state)
            current = state["tasks"][task["name"]]
            dispositions = {
                status["disposition"]
                for attempt_row in current["attempts"]
                if attempt_row["job_name"] == job_name
                for status in attempt_row["statuses"].values()
            }
            if "quota" in dispositions:
                atomic_write_json(
                    quota_path,
                    {
                        "created_at": utc_now(),
                        "task": task["name"],
                        "job_name": job_name,
                        "message": "Provider quota detected; no later task was scheduled.",
                    },
                )
                emit_status(state, json_output=args.json_output)
                return 75
            if current["blockers"]:
                emit_status(state, json_output=args.json_output)
                return 2
            if current["status"] != "complete":
                print(
                    f"{task['name']} remains incomplete. Checkpoint saved; "
                    "resume to retry only objectively retryable arms.",
                    file=sys.stderr,
                )
                emit_status(state, json_output=args.json_output)
                return 3


if __name__ == "__main__":
    raise SystemExit(main())
