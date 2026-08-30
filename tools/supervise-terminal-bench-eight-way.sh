#!/usr/bin/env bash
set -euo pipefail

RUN_ROOT="${RUN_ROOT:-/home/sudhan/benchmarks/tb21-eight-way-20260730}"
PYTHON="${PYTHON:-/home/sudhan/benchmarks/terminalbench-codexzero/venv/bin/python}"
RUNNER="${RUNNER:-/mnt/c/Users/sudha/Downloads/CodexZero/tools/run-terminal-bench-eight-way.py}"
POLL_SECONDS="${POLL_SECONDS:-30}"
RESTART_BACKOFF_SECONDS="${RESTART_BACKOFF_SECONDS:-15}"
QUOTA_RETRY_SECONDS="${QUOTA_RETRY_SECONDS:-1800}"

mkdir -p "$RUN_ROOT/logs" "$RUN_ROOT/state"
exec 9>"$RUN_ROOT/state/supervisor.lock"
if ! flock -n 9; then
  echo "A benchmark supervisor already holds the lock." >&2
  exit 0
fi

echo "$$" >"$RUN_ROOT/state/supervisor.pid"
trap 'rm -f "$RUN_ROOT/state/supervisor.pid"' EXIT

log() {
  printf '%s %s\n' "$(date -u +%FT%TZ)" "$*" \
    | tee -a "$RUN_ROOT/logs/supervisor-events.log"
}

is_complete() {
  "$PYTHON" - "$RUN_ROOT/checkpoint.json" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
if not path.is_file():
    raise SystemExit(1)
state = json.loads(path.read_text(encoding="utf-8"))
raise SystemExit(
    0
    if state.get("paired_prefix_tasks") == state.get("task_count") == 89
    else 1
)
PY
}

stop_requested() {
  [[ -f "$RUN_ROOT/STOP.USER" || -f "$RUN_ROOT/STOP" ]]
}

sleep_interruptibly() {
  local remaining="$1"
  while (( remaining > 0 )); do
    stop_requested && return 1
    local step="$POLL_SECONDS"
    (( step > remaining )) && step="$remaining"
    sleep "$step"
    remaining=$((remaining - step))
  done
}

wait_for_existing_controller() {
  local pid=0
  [[ -f "$RUN_ROOT/state/controller.pid" ]] \
    && pid="$(cat "$RUN_ROOT/state/controller.pid" 2>/dev/null || echo 0)"
  if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null; then
    log "adopting active controller pid=$pid"
    while kill -0 "$pid" 2>/dev/null; do
      stop_requested && return 1
      sleep "$POLL_SECONDS"
    done
    log "adopted controller pid=$pid exited"
  fi
}

log "supervisor started"
wait_for_existing_controller || {
  log "operator stop retained; supervisor exiting"
  exit 76
}

while true; do
  if is_complete; then
    log "benchmark complete: 89/89 paired tasks"
    exit 0
  fi
  if stop_requested; then
    log "operator stop found; supervisor exiting"
    exit 76
  fi

  acknowledge=()
  if [[ -f "$RUN_ROOT/QUOTA_STOP.json" ]]; then
    log "quota stop found; retrying after ${QUOTA_RETRY_SECONDS}s"
    sleep_interruptibly "$QUOTA_RETRY_SECONDS" || {
      log "operator stop requested during quota wait"
      exit 76
    }
    acknowledge=(--acknowledge-quota)
  fi

  log "launching controller ${acknowledge[*]:-}"
  "$PYTHON" "$RUNNER" --run-root "$RUN_ROOT" "${acknowledge[@]}" \
    >>"$RUN_ROOT/logs/controller.log" 2>&1 &
  child=$!
  echo "$child" >"$RUN_ROOT/state/controller.pid"
  set +e
  wait "$child"
  code=$?
  set -e
  log "controller pid=$child exited code=$code"

  if is_complete; then
    log "benchmark complete: 89/89 paired tasks"
    exit 0
  fi
  if stop_requested; then
    log "operator stop retained after controller exit"
    exit 76
  fi
  sleep_interruptibly "$RESTART_BACKOFF_SECONDS" || exit 76
done
