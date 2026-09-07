#!/usr/bin/env python3
"""Prepare the parallel Terminal-Bench campaigns that close the Tura gaps."""

from __future__ import annotations

import json
import os
import random
import shutil
import stat
import subprocess
from pathlib import Path


HOME = Path("/home/sudhan/benchmarks")
REPO = Path("/mnt/c/Users/sudha/Downloads/CodexZero")
BASE = HOME / "tb21-tura-gapfill-20260813"
HARBOR = HOME / "terminalbench-codexzero/venv/bin/harbor"
PYTHON = HOME / "terminalbench-codexzero/venv/bin/python"
RUNNER = REPO / "tools/run-terminal-bench-profile.py"
AUDIT = REPO / "reports/terminal-bench-metrics-audit-2026-08-13.json"
SOURCE_AUTH = Path("/mnt/c/Users/sudha/.codex/auth.json")
AUTH = BASE / "secrets/auth.json"
TURA_DIST = HOME / "tb21-eight-way-20260730/sealed/tura-dist"
MEDIUM_DATASET = HOME / "tb21-eight-way-20260730/dataset/terminal-bench"
LOW_DATASET = HOME / "tb21-alltools-fast-20260810/dataset/terminal-bench"
V050_ARMS = HOME / "tb21-v050-fast-20260810/state/arms.json"
TURA_ARMS = HOME / "tb21-tura-fast-shard-01-20260812/state/arms.json"


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def task_sets() -> tuple[list[str], list[str], list[str]]:
    audit = read_json(AUDIT)
    cells = audit["task_cells"]
    medium = sorted(
        row["task"]
        for row in cells
        if row["profile"] == "stock_codex"
        and row["reasoning_effort"] == "medium"
    )
    low = sorted(
        row["task"]
        for row in cells
        if row["profile"] == "stock_compat_0146"
        and row["reasoning_effort"] == "low"
    )
    if len(medium) != 32 or len(low) != 56:
        raise SystemExit(f"Unexpected task strata: medium={len(medium)} low={len(low)}")
    rng = random.Random(2514)
    repeated = sorted(rng.sample(low, 12))
    return medium, low, repeated


def merged_environment() -> dict:
    rows = []
    seen = set()
    for manifest in (read_json(V050_ARMS), read_json(TURA_ARMS)):
        for mount in manifest.get("environment", {}).get("mounts", []):
            key = (mount.get("source"), mount.get("target"))
            if key not in seen:
                seen.add(key)
                rows.append(mount)
    return {"mounts": rows}


def arm(identifier: str) -> dict:
    if identifier in {"stock_compat_0146", "v050_focused"}:
        source = read_json(V050_ARMS)
        value = next(row for row in source["arms"] if row["id"] == identifier)
        value = json.loads(json.dumps(value))
        value["agent"]["env"]["CODEX_AUTH_JSON_PATH"] = str(AUTH)
        return value
    profiles = {
        "tura_balanced": (
            "tools.harbor_tura_fast_agent:TuraBalancedFast",
            "low",
        ),
        "tura_balanced_medium": (
            "tools.harbor_tura_profiles:TuraBalancedMedium",
            "medium",
        ),
        "tura_direct_low": (
            "tools.harbor_tura_profiles:TuraDirectLow",
            "low",
        ),
        "tura_balanced_default": (
            "tools.harbor_tura_profiles:TuraBalancedProductDefault",
            "high",
        ),
    }
    import_path, effort = profiles[identifier]
    return {
        "id": identifier,
        "agent": {
            "import_path": import_path,
            "model_name": "codex/gpt-5.6-sol",
            "kwargs": {"version": "0.1.34"},
            "env": {
                "TURA_BENCHMARK_LABEL": identifier,
                "TURA_BINARY_CONTAINER_PATH": "/opt/bench/tura-dist/tura",
                "TURA_AUTH_JSON_PATH": str(AUTH),
                "TURA_REASONING_EFFORT": effort,
            },
        },
        "activation": {},
    }


def dependencies(identifiers: list[str]) -> list[dict]:
    rows = [{"name": "auth", "path": str(AUTH), "secret": True}]
    if any(identifier.startswith("tura_") for identifier in identifiers):
        rows.extend(
            [
                {"name": "tura_dist", "path": str(TURA_DIST), "secret": False},
                {
                    "name": "tura_adapter",
                    "path": str(REPO / "tools/harbor_tura_agent.py"),
                    "secret": False,
                },
                {
                    "name": "tura_profiles",
                    "path": str(REPO / "tools/harbor_tura_profiles.py"),
                    "secret": False,
                },
                {
                    "name": "tura_fast_adapter",
                    "path": str(REPO / "tools/harbor_tura_fast_agent.py"),
                    "secret": False,
                },
            ]
        )
    if any(identifier in {"stock_compat_0146", "v050_focused"} for identifier in identifiers):
        source = read_json(V050_ARMS)
        rows.extend(row for row in source["dependencies"] if row["name"] != "auth")
    return rows


def copy_dataset(source: Path, destination: Path, tasks: list[str]) -> None:
    destination.mkdir(parents=True, exist_ok=True)
    for name in tasks:
        target = destination / name
        if target.exists():
            continue
        shutil.copytree(source / name, target, copy_function=shutil.copy2)


def chunks(values: list[str], count: int) -> list[list[str]]:
    return [values[index::count] for index in range(count)]


def prepare_group(
    name: str,
    tasks: list[str],
    *,
    source_dataset: Path,
    identifiers: list[str],
    effort: str,
    shard_count: int,
    seed_offset: int = 0,
) -> list[dict]:
    group = BASE / name
    records = []
    for index, selected in enumerate(chunks(tasks, shard_count), 1):
        root = group / f"shard-{index:02d}"
        state = root / "state"
        dataset = root / "dataset/terminal-bench"
        copy_dataset(source_dataset, dataset, selected)
        manifest = {
            "schema": "codexzero-terminal-bench-eight-way-arms-v1",
            "model": "gpt-5.6-sol",
            "reasoning_effort": effort,
            "harbor_env": {
                "PYTHONPATH": f"{REPO}:{HOME / 'terminalbench-codexzero/harbor/src'}"
            },
            "environment": merged_environment(),
            "verifier": {"disable": False},
            "dependencies": dependencies(identifiers),
            "arms": [arm(identifier) for identifier in identifiers],
        }
        write_json(state / "arms.json", manifest)
        write_json(
            state / "tasks.json",
            {
                "schema": "tb21-tura-gapfill-task-order-v1",
                "public_name": name,
                "tasks": [
                    {"index": task_index, "name": task}
                    for task_index, task in enumerate(selected, 1)
                ],
            },
        )
        env = os.environ.copy()
        env.update(
            {
                "TB_ARM_IDS": ",".join(identifiers),
                "TB_MODEL": "gpt-5.6-sol",
                "TB_REASONING_EFFORT": effort,
            }
        )
        command = [
            str(PYTHON),
            str(RUNNER),
            "--run-root",
            str(root),
            "--harbor",
            str(HARBOR),
            "--jobs-dir",
            str(root / "jobs"),
            "--arms-manifest",
            str(state / "arms.json"),
            "--tasks-dir",
            str(dataset),
            "--dataset-manifest",
            str(state / "tasks.json"),
            "--expected-task-count",
            str(len(selected)),
            "--seed",
            str(2514 + seed_offset + index),
            "--prepare-only",
        ]
        subprocess.run(command, env=env, check=True, stdout=subprocess.DEVNULL)
        records.append(
            {
                "name": f"{name}/shard-{index:02d}",
                "root": str(root),
                "identifiers": identifiers,
                "effort": effort,
                "tasks": len(selected),
            }
        )
    return records


def write_runner(records: list[dict]) -> None:
    script = BASE / "run.sh"
    lines = [
        "#!/usr/bin/env bash",
        "set -uo pipefail",
        f"BASE={BASE}",
        f"PY={PYTHON}",
        f"RUNNER={RUNNER}",
        'mkdir -p "$BASE/logs"',
        'printf "%s campaign-start\\n" "$(date -u +%FT%TZ)" >>"$BASE/logs/events.log"',
        "run_one(){",
        '  local root="$1" ids="$2" effort="$3" name="$4" stalls=0',
        "  while true; do",
        '    local before after total code',
        '    before=$(python3 -c \"import json;print(json.load(open(\'$root/checkpoint.json\'))[\'paired_prefix_tasks\'])\")',
        '    total=$(python3 -c \"import json;print(json.load(open(\'$root/checkpoint.json\'))[\'task_count\'])\")',
        '    [ "$before" -eq "$total" ] && break',
        '    TB_ARM_IDS="$ids" TB_MODEL=gpt-5.6-sol TB_REASONING_EFFORT="$effort" "$PY" "$RUNNER" --run-root "$root" >>"$root/controller.log" 2>&1',
        "    code=$?",
        '    after=$(python3 -c \"import json;print(json.load(open(\'$root/checkpoint.json\'))[\'paired_prefix_tasks\'])\")',
        '    printf "%s %s exit=%s progress=%s/%s\\n" "$(date -u +%FT%TZ)" "$name" "$code" "$after" "$total" >>"$BASE/logs/events.log"',
        '    [ -f "$root/QUOTA_STOP.json" ] && return 75',
        '    if [ "$after" -le "$before" ]; then stalls=$((stalls+1)); else stalls=0; fi',
        '    [ "$stalls" -ge 3 ] && return 3',
        "    sleep 2",
        "  done",
        '  printf "%s %s complete\\n" "$(date -u +%FT%TZ)" "$name" >>"$BASE/logs/events.log"',
        "}",
        "pids=()",
    ]
    for row in records:
        ids = ",".join(row["identifiers"])
        lines.append(
            f"run_one {row['root']!s} {ids!s} {row['effort']!s} {row['name']!s} & pids+=(\"$!\")"
        )
    lines.extend(
        [
            "failed=0",
            'for pid in "${pids[@]}"; do wait "$pid" || failed=1; done',
            'printf "%s campaign-finish failed=%s\\n" "$(date -u +%FT%TZ)" "$failed" >>"$BASE/logs/events.log"',
            'printf \'{"finished_at":"%s","failed":%s}\\n\' "$(date -u +%FT%TZ)" "$failed" >"$BASE/result.json"',
            'exit "$failed"',
        ]
    )
    script.write_text("\n".join(lines) + "\n", encoding="utf-8")
    script.chmod(script.stat().st_mode | stat.S_IXUSR)


def main() -> None:
    if BASE.exists():
        raise SystemExit(f"Campaign already exists: {BASE}")
    (BASE / "secrets").mkdir(parents=True)
    shutil.copy2(SOURCE_AUTH, AUTH)
    AUTH.chmod(stat.S_IRUSR | stat.S_IWUSR)
    medium, low, repeated = task_sets()
    records = []
    records += prepare_group(
        "balanced-medium",
        medium,
        source_dataset=MEDIUM_DATASET,
        identifiers=["tura_balanced_medium"],
        effort="medium",
        shard_count=3,
    )
    records += prepare_group(
        "direct-low",
        low,
        source_dataset=LOW_DATASET,
        identifiers=["tura_direct_low"],
        effort="low",
        shard_count=6,
        seed_offset=100,
    )
    records += prepare_group(
        "product-default",
        repeated,
        source_dataset=LOW_DATASET,
        identifiers=["tura_balanced_default"],
        effort="high",
        shard_count=1,
        seed_offset=200,
    )
    # Two additional paired repetitions. Together with the existing 56-task
    # campaign, these provide three observations for this fixed 12-task panel.
    for repetition in (2, 3):
        order = repeated.copy()
        random.Random(2514 + repetition).shuffle(order)
        records += prepare_group(
            f"repeat-low-r{repetition}",
            order,
            source_dataset=LOW_DATASET,
            identifiers=[
                "stock_compat_0146",
                "v050_focused",
                "tura_balanced",
                "tura_direct_low",
            ],
            effort="low",
            shard_count=1,
            seed_offset=300 + repetition,
        )
    write_json(BASE / "campaign.json", {"schema": "tb21-tura-gapfill-v1", "runs": records})
    write_json(BASE / "repeated-tasks.json", {"seed": 2514, "tasks": repeated})
    write_runner(records)
    print(BASE)


if __name__ == "__main__":
    main()
