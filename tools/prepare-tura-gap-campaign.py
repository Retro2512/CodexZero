#!/usr/bin/env python3
"""Prepare sharded, resumable Tura Terminal-Bench gap-filling campaigns.

The generated campaign uses the already-sealed Terminal-Bench task checkout,
Tura 0.1.34 distribution, Harbor 0.20.0 environment, and the proven single-arm
controller.  Eight workers run independently so at most eight Harbor/Tura
trials are active at once.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


DEFAULT_BENCH = Path("/home/sudhan/benchmarks")
DEFAULT_REPO = Path("/mnt/c/Users/sudha/Downloads/CodexZero")
VENV = DEFAULT_BENCH / "terminalbench-codexzero/venv"
HARBOR = VENV / "bin/harbor"
PYTHON = VENV / "bin/python"
SEALED_ROOT = DEFAULT_BENCH / "tb21-eight-way-20260730"
FAST_ROOT = DEFAULT_BENCH / "tb21-alltools-fast-20260810"
RUNNER_TEMPLATE = (
    DEFAULT_BENCH
    / "tb21-tura-fast-shard-01-20260812/state/runner.py"
)


@dataclass(frozen=True)
class Profile:
    name: str
    arm_id: str
    import_path: str
    effort: str
    tasks: tuple[str, ...]


def load_json(path: Path) -> dict:
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def hardlink_tree(source: Path, target: Path) -> None:
    shutil.copytree(source, target, copy_function=os.link)


def patched_runner(template: str, profile: Profile) -> str:
    text = re.sub(r'^EFFORT = "[^"]+"$', f'EFFORT = "{profile.effort}"', template, flags=re.M)
    text = re.sub(
        r'^ARM_IDS = \("tura_balanced",\)$',
        f'ARM_IDS = ("{profile.arm_id}",)',
        text,
        flags=re.M,
    )
    text = text.replace('identifier == "tura_balanced"', 'identifier.startswith("tura_")')

    # Surface known Tura runtime startup failures as retryable infrastructure,
    # rather than converting zero-usage runtime failures into benchmark zeros.
    text = text.replace(
        'trial_dir / "agent" / "stderr.txt",\n    )',
        'trial_dir / "agent" / "stderr.txt",\n        trial_dir / "agent" / "tura.jsonl",\n    )',
    )
    needle = "    infrastructure_detail = infrastructure_failure_detail(result)\n"
    replacement = '''    tura_text = ""
    tura_log = trial_dir / "agent" / "tura.jsonl"
    if tura_log.is_file():
        tura_text = tura_log.read_text(encoding="utf-8", errors="replace").lower()
    tura_infrastructure_patterns = (
        "resource temporarily unavailable (os error 11)",
        "session_db service is not running",
        "failed to read router response",
        "provider runtime failed after 3 retries",
    )
    matched_tura_infrastructure = next(
        (pattern for pattern in tura_infrastructure_patterns if pattern in tura_text),
        None,
    )
    if matched_tura_infrastructure:
        return {
            "disposition": "infrastructure",
            "scored": False,
            "retryable": True,
            "detail": f"tura runtime: {matched_tura_infrastructure}",
            "result_sha256": sha256_file(result_path),
            "exception_type": kind or None,
        }

    infrastructure_detail = infrastructure_failure_detail(result)
'''
    if needle not in text:
        raise RuntimeError("runner template classification hook not found")
    return text.replace(needle, replacement, 1)


def manifests() -> tuple[list[str], list[str]]:
    medium_plan = load_json(SEALED_ROOT / "plan.json")
    fast_plan = load_json(FAST_ROOT / "plan.json")
    medium = [row["name"] for row in medium_plan["tasks"][:32]]
    fast = [row["name"] for row in fast_plan["tasks"]]
    if len(medium) != 32 or len(set(medium)) != 32:
        raise RuntimeError("expected 32 unique preregistered medium tasks")
    if len(fast) != 56 or len(set(fast)) != 56:
        raise RuntimeError("expected 56 unique preregistered fast tasks")
    return medium, fast


def make_profiles() -> list[Profile]:
    medium, fast = manifests()
    repair = (
        "break-filter-js-from-html",
        "qemu-alpine-ssh",
        "compile-compcert",
        "llm-inference-batching-scheduler",
        "fix-ocaml-gc",
        "mcmc-sampling-stan",
        "schemelike-metacircular-eval",
        "vulnerable-secret",
        "tune-mjcf",
        "extract-moves-from-video",
    )
    return [
        Profile(
            "balanced-medium",
            "tura_balanced_medium",
            "tools.harbor_tura_profiles:TuraBalancedMedium",
            "medium",
            tuple(medium),
        ),
        Profile(
            "direct-low",
            "tura_direct_low",
            "tools.harbor_tura_profiles:TuraDirectLow",
            "low",
            tuple(fast),
        ),
        Profile(
            "balanced-low-repair",
            "tura_balanced_low_repair",
            "tools.harbor_tura_fast_agent:TuraBalancedFast",
            "low",
            repair,
        ),
    ]


def arm_manifest(profile: Profile, auth: Path) -> dict:
    old = load_json(SEALED_ROOT / "state/arms.json")
    mounts = [
        row
        for row in old["environment"]["mounts"]
        if row["target"].startswith("/opt/bench/tura-dist")
        or row["target"].startswith("/opt/bench/glibc/")
        or row["target"] == "/etc/ssl/certs/ca-certificates.crt"
    ]
    return {
        "schema": "codexzero-terminal-bench-eight-way-arms-v1",
        "model": "gpt-5.6-sol",
        "reasoning_effort": profile.effort,
        "harbor_env": {
            "PYTHONPATH": f"{DEFAULT_REPO}:{DEFAULT_BENCH}/terminalbench-codexzero/harbor/src"
        },
        "environment": {"mounts": mounts},
        "verifier": {"disable": False},
        "dependencies": [
            {"name": "auth", "path": str(auth), "secret": True},
            {
                "name": "tura_dist",
                "path": str(SEALED_ROOT / "sealed/tura-dist"),
                "secret": False,
            },
            {
                "name": "tura_adapter",
                "path": str(DEFAULT_REPO / "tools/harbor_tura_agent.py"),
                "secret": False,
            },
            {
                "name": "tura_profiles",
                "path": str(DEFAULT_REPO / "tools/harbor_tura_profiles.py"),
                "secret": False,
            },
        ],
        "arms": [
            {
                "id": profile.arm_id,
                "agent": {
                    "import_path": profile.import_path,
                    "model_name": "codex/gpt-5.6-sol",
                    "kwargs": {"version": "0.1.34"},
                    "env": {
                        "TURA_BENCHMARK_LABEL": profile.arm_id,
                        "TURA_BINARY_CONTAINER_PATH": "/opt/bench/tura-dist/tura",
                        "TURA_AUTH_JSON_PATH": str(auth),
                        "TURA_REASONING_EFFORT": profile.effort,
                    },
                },
                "activation": {},
            }
        ],
    }


def prepare_shard(campaign: Path, profile: Profile, shard: int, tasks: list[str], auth: Path, runner_template: str) -> Path:
    root = campaign / "runs" / f"{profile.name}-shard-{shard:02d}"
    dataset = root / "dataset/terminal-bench"
    state = root / "state"
    state.mkdir(parents=True, exist_ok=True)
    dataset.mkdir(parents=True, exist_ok=True)
    source_dataset = SEALED_ROOT / "dataset/terminal-bench"
    for task in tasks:
        hardlink_tree(source_dataset / task, dataset / task)

    task_manifest = {
        "schema": "tb21-tura-gap-shard-v1",
        "public_name": f"Tura {profile.name} gap campaign shard {shard}",
        "tasks": [
            {"index": index, "name": task}
            for index, task in enumerate(tasks, 1)
        ],
    }
    write_json(state / "tasks.json", task_manifest)
    write_json(state / "arms.json", arm_manifest(profile, auth))
    (state / "runner.py").write_text(
        patched_runner(runner_template, profile), encoding="utf-8"
    )
    command = [
        str(PYTHON),
        str(state / "runner.py"),
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
        str(len(tasks)),
        "--prepare-only",
    ]
    subprocess.run(command, check=True)
    return root


def write_orchestrator(campaign: Path, profiles: list[Profile], shard_roots: dict[tuple[str, int], Path], shards: int) -> None:
    (campaign / "state").mkdir(parents=True, exist_ok=True)
    (campaign / "logs").mkdir(parents=True, exist_ok=True)
    lines = [
        "#!/usr/bin/env bash",
        "set -euo pipefail",
        f"C={campaign}",
        f"PY={PYTHON}",
        'mkdir -p "$C/logs" "$C/state"',
        "log(){ printf '%s %s\\n' \"$(date -u +%FT%TZ)\" \"$*\" | tee -a \"$C/logs/events.log\"; }",
        "paired(){ \"$PY\" - \"$1/checkpoint.json\" <<'PY'\nimport json,sys\ntry: print(int(json.load(open(sys.argv[1])).get('paired_prefix_tasks',0)))\nexcept Exception: print(0)\nPY\n}",
        "total(){ \"$PY\" - \"$1/checkpoint.json\" <<'PY'\nimport json,sys\nprint(int(json.load(open(sys.argv[1])).get('task_count',0)))\nPY\n}",
        "run_root(){ local root=\"$1\" label=\"$2\" stalls=0 target before after code; mkdir -p \"$root/logs\" \"$root/attempts\"; target=$(total \"$root\"); while true; do before=$(paired \"$root\"); [ \"$before\" -eq \"$target\" ] && { log \"$label complete $before/$target\"; return 0; }; [ -f \"$root/QUOTA_STOP.json\" ] && return 75; set +e; \"$PY\" \"$root/state/runner.py\" --run-root \"$root\" >>\"$root/logs/controller.log\" 2>&1; code=$?; set -e; after=$(paired \"$root\"); log \"$label exit=$code paired=$after/$target\"; [ \"$after\" -eq \"$target\" ] && return 0; [ -f \"$root/QUOTA_STOP.json\" ] && return 75; if [ \"$after\" -le \"$before\" ]; then stalls=$((stalls+1)); else stalls=0; fi; [ \"$stalls\" -ge 3 ] && return 3; sleep 3; done; }",
    ]
    profile_order = [profile.name for profile in profiles]
    for shard in range(1, shards + 1):
        lines.append(f"worker_{shard:02d}() {{")
        for name in profile_order:
            root = shard_roots.get((name, shard))
            if root is not None:
                lines.append(f"  run_root {root} {name}-shard-{shard:02d}")
        lines.append("}")
    lines += [
        'log "Tura gap campaign started"',
        "pids=()",
        *[f"worker_{shard:02d} & pids+=(\"$!\")" for shard in range(1, shards + 1)],
        "failed=0",
        'for pid in "${pids[@]}"; do wait "$pid" || failed=1; done',
        'printf \'{"finished_at":"%s","failed":%s}\\n\' "$(date -u +%FT%TZ)" "$failed" > "$C/result.json"',
        'log "Tura gap campaign finished failed=$failed"',
        'exit "$failed"',
    ]
    script = campaign / "state/run.sh"
    script.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    script.chmod(0o755)
    launcher = campaign / "state/launch.sh"
    launcher.write_text(
        "#!/usr/bin/env bash\n"
        "set -euo pipefail\n"
        f"C={campaign}\n"
        'if [ -f "$C/state/campaign.pid" ] && kill -0 "$(cat "$C/state/campaign.pid")" 2>/dev/null; then\n'
        '  echo "campaign already running: $(cat "$C/state/campaign.pid")"\n'
        "  exit 0\n"
        "fi\n"
        'nohup bash "$C/state/run.sh" >"$C/logs/nohup.log" 2>&1 < /dev/null &\n'
        'pid=$!\n'
        'echo "$pid" > "$C/state/campaign.pid"\n'
        "sleep 3\n"
        'kill -0 "$pid"\n'
        'echo "$pid"\n',
        encoding="utf-8",
        newline="\n",
    )
    launcher.chmod(0o755)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--campaign-root", type=Path, required=True)
    parser.add_argument("--shards", type=int, default=8)
    parser.add_argument(
        "--auth-source", type=Path, default=Path("/mnt/c/Users/sudha/.codex/auth.json")
    )
    args = parser.parse_args()
    if not 1 <= args.shards <= 8:
        raise SystemExit("--shards must be between 1 and 8")
    campaign = args.campaign_root.resolve()
    if campaign.exists() and any(campaign.iterdir()):
        unexpected = {path.name for path in campaign.iterdir()} - {
            "runs", "secrets", "state", "logs", "campaign.json", "result.json"
        }
        if unexpected:
            raise SystemExit(
                f"campaign root contains unexpected entries: {sorted(unexpected)}"
            )
    (campaign / "secrets").mkdir(parents=True, exist_ok=True)
    auth = campaign / "secrets/auth.json"
    shutil.copyfile(args.auth_source, auth)
    auth.chmod(0o600)

    profiles = make_profiles()
    runner_template = RUNNER_TEMPLATE.read_text(encoding="utf-8")
    shard_roots: dict[tuple[str, int], Path] = {}
    for profile in profiles:
        buckets = [[] for _ in range(args.shards)]
        for index, task in enumerate(profile.tasks):
            buckets[index % args.shards].append(task)
        for shard, tasks in enumerate(buckets, 1):
            if tasks:
                existing = campaign / "runs" / f"{profile.name}-shard-{shard:02d}"
                if (existing / "plan.json").is_file():
                    shard_roots[(profile.name, shard)] = existing
                else:
                    shard_roots[(profile.name, shard)] = prepare_shard(
                        campaign, profile, shard, tasks, auth, runner_template
                    )
    write_orchestrator(campaign, profiles, shard_roots, args.shards)
    write_json(
        campaign / "campaign.json",
        {
            "schema": "codexzero-tura-gap-campaign-v1",
            "max_concurrent_trials": args.shards,
            "profiles": [
                {
                    "name": profile.name,
                    "arm_id": profile.arm_id,
                    "effort": profile.effort,
                    "tasks": len(profile.tasks),
                }
                for profile in profiles
            ],
            "run_script": str(campaign / "state/run.sh"),
        },
    )
    print(campaign / "state/run.sh")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
