"""Harbor import-path adapter for the pinned Tura Balanced benchmark arm.

This module intentionally lives outside the Harbor checkout so the benchmark
does not modify the already-patched Harbor source tree.  Harbor can load it
with ``import_path: tools.harbor_tura_agent:TuraBalanced``.
"""

from __future__ import annotations

import json
import shlex
from pathlib import Path
from typing import Any, override

from harbor.agents.installed.base import (
    AgentAuthenticationError,
    ApiConnectionClosedError,
    ApiRateLimitError,
    ApiUsageLimitError,
    BaseInstalledAgent,
    NetworkConnectionError,
    NonZeroAgentExitCodeError,
    with_prompt_template,
)
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext
from harbor.models.trial.paths import EnvironmentPaths


class TuraBalanced(BaseInstalledAgent):
    """Run Tura's balanced agent through its non-interactive shell front."""

    _PINNED_VERSION = "0.1.34"
    _MODEL = "codex/gpt-5.6-sol"
    _REASONING_EFFORT = "medium"
    _AGENT_ID = "balanced"
    _PRIORITY = False
    _PLANNING = "auto"
    _OUTPUT_FILENAME = "tura.jsonl"
    _REMOTE_AUTH_PATH = "/tmp/tura-secrets/auth.json"
    _REMOTE_ENV_PATH = "/tmp/tura-secrets/auth.env"

    @staticmethod
    @override
    def name() -> str:
        return "tura-balanced"

    @override
    def get_version_command(self) -> str | None:
        # Tura 0.1.34 prints its command help instead of a conventional version.
        return None

    @override
    def version(self) -> str:
        # The benchmark manifest verifies the mounted binary's SHA-256. Tura
        # itself has no version-printing command in 0.1.34.
        return self._PINNED_VERSION

    @override
    async def install(self, environment: BaseEnvironment) -> None:
        binary = self._get_env("TURA_BINARY_CONTAINER_PATH")
        if not binary:
            raise ValueError("TURA_BINARY_CONTAINER_PATH is required")
        result = await environment.exec(
            command=f"test -x {shlex.quote(binary)}", user="root"
        )
        if result.return_code != 0:
            raise ValueError(f"Mounted Tura binary is unavailable: {binary}")
        await self.exec_as_root(
            environment,
            command=f"ln -sf {shlex.quote(binary)} /usr/local/bin/tura",
        )
        # The auth bridge below is kept off the command line and needs a JSON
        # parser that is present on most task images. Install it only if absent.
        check = await environment.exec(command="command -v python3 >/dev/null 2>&1")
        if check.return_code != 0:
            await self.ensure_system_dependencies(environment, ("python3",))

    def _auth_json_path(self) -> Path:
        value = self._get_env("TURA_AUTH_JSON_PATH")
        if not value:
            raise ValueError("TURA_AUTH_JSON_PATH is required")
        path = Path(value)
        if not path.is_file():
            raise ValueError(f"TURA_AUTH_JSON_PATH does not exist: {value}")
        return path

    async def _cleanup_runtime(self, environment: BaseEnvironment) -> None:
        try:
            await environment.exec(
                command="rm -rf /tmp/tura-secrets /tmp/tura-home /tmp/tura-db",
                user="root",
            )
        except Exception:
            pass

    @staticmethod
    def _json_events(text: str | None) -> list[dict[str, Any]]:
        events: list[dict[str, Any]] = []
        for raw_line in (text or "").splitlines():
            try:
                value = json.loads(raw_line)
            except json.JSONDecodeError:
                continue
            if isinstance(value, dict):
                events.append(value)
        return events

    @classmethod
    def _last_turn_completed(cls, text: str | None) -> dict[str, Any] | None:
        final: dict[str, Any] | None = None
        for event in cls._json_events(text):
            if event.get("type") == "turn.completed":
                final = event
        return final

    @classmethod
    def _event_error_text(cls, event: dict[str, Any]) -> str:
        """Extract diagnostic fields from a structured Tura failure event."""

        values: list[str] = []

        def visit(value: Any, key: str = "") -> None:
            if isinstance(value, dict):
                for child_key, child in value.items():
                    visit(child, str(child_key).lower())
            elif isinstance(value, list):
                for child in value:
                    visit(child, key)
            elif isinstance(value, (str, int)) and key in {
                "code",
                "detail",
                "error",
                "error_code",
                "error_type",
                "message",
                "reason",
                "status",
                "type",
            }:
                values.append(str(value))

        visit(event)
        return " | ".join(values)

    @staticmethod
    def _classify_tura_error(
        detail: str,
    ) -> type[NonZeroAgentExitCodeError]:
        lowered = detail.lower()
        if any(
            marker in lowered
            for marker in (
                "usage limit",
                "usage_limit",
                "insufficient_quota",
                "quota exceeded",
                "credit balance",
            )
        ):
            return ApiUsageLimitError
        if any(
            marker in lowered
            for marker in ("rate limit", "rate_limit", "too many requests", "429")
        ):
            return ApiRateLimitError
        if any(
            marker in lowered
            for marker in (
                "authentication",
                "invalid api key",
                "invalid token",
                "expired token",
                "unauthorized",
                "401",
                "403",
            )
        ):
            return AgentAuthenticationError
        if any(
            marker in lowered
            for marker in (
                "connection closed",
                "stream closed",
                "unexpected eof",
                "incomplete response",
            )
        ):
            return ApiConnectionClosedError
        if any(
            marker in lowered
            for marker in (
                "certificate",
                "connection timed out",
                "connection refused",
                "dns",
                "name resolution",
                "network",
                "provider retries exhausted",
                "request timed out",
                "resource temporarily unavailable",
                "session_db service is not running",
                "tls",
            )
        ):
            return NetworkConnectionError
        return NonZeroAgentExitCodeError

    @override
    def _classify_exec_error(
        self, command: str, result: Any
    ) -> NonZeroAgentExitCodeError:
        fallback = super()._classify_exec_error(command, result)
        combined = f"{result.stdout or ''}\n{result.stderr or ''}"
        events = self._json_events(combined)
        failure_details: list[str] = []
        for event in events:
            event_type = str(event.get("type") or "").lower()
            status = str(event.get("status") or "").lower()
            if event_type in {"error", "turn.failed"} or (
                event_type == "turn.completed" and status not in {"", "completed"}
            ):
                failure_details.append(self._event_error_text(event))
        raw_details: list[str] = []
        for raw_line in combined.splitlines():
            try:
                json.loads(raw_line)
            except json.JSONDecodeError:
                if raw_line.strip():
                    raw_details.append(raw_line.strip())
        detail = " | ".join(
            part for part in [*failure_details, *raw_details] if part
        )
        if not detail:
            if events and type(fallback) is not NonZeroAgentExitCodeError:
                # Do not classify provider-like text inside prompts, assistant
                # messages, or tool output as an infrastructure failure.
                return NonZeroAgentExitCodeError(str(fallback))
            return fallback
        exception = self._classify_tura_error(detail)
        if exception is NonZeroAgentExitCodeError:
            if events and type(fallback) is not NonZeroAgentExitCodeError:
                return NonZeroAgentExitCodeError(str(fallback))
            return fallback
        return exception(str(fallback))

    @override
    @with_prompt_template
    async def run(
        self,
        instruction: str,
        environment: BaseEnvironment,
        context: AgentContext,
    ) -> None:
        if self.model_name != self._MODEL:
            raise ValueError(
                f"{self.name()} protocol requires model_name={self._MODEL}"
            )

        effort = self._get_env("TURA_REASONING_EFFORT") or self._REASONING_EFFORT
        if effort != self._REASONING_EFFORT:
            raise ValueError(
                f"{self.name()} protocol requires "
                f"{self._REASONING_EFFORT} reasoning"
            )
        if self._PLANNING not in {"auto", "on", "off"}:
            raise ValueError(f"Invalid Tura planning mode: {self._PLANNING}")

        await self.exec_as_agent(
            environment,
            command=(
                "mkdir -p /tmp/tura-secrets /tmp/tura-home /tmp/tura-db "
                f"{EnvironmentPaths.agent_dir.as_posix()}"
            ),
        )
        try:
            await environment.upload_file(
                self._auth_json_path(), self._REMOTE_AUTH_PATH
            )
            if environment.default_user is not None:
                default_user = shlex.quote(str(environment.default_user))
                await self.exec_as_root(
                    environment,
                    command=(
                        f"chown {default_user} "
                        f"{shlex.quote(self._REMOTE_AUTH_PATH)} && "
                        f"chmod 600 {shlex.quote(self._REMOTE_AUTH_PATH)}"
                    ),
                )
            else:
                await self.exec_as_root(
                    environment,
                    command=f"chmod 600 {shlex.quote(self._REMOTE_AUTH_PATH)}",
                )
        except BaseException:
            await self._cleanup_runtime(environment)
            raise

        # Convert Codex's auth JSON to a mode-0600 shell environment file in
        # the container. Secret values never enter the benchmark config or
        # command string.
        auth_bridge = f"""\
import base64, json, shlex
src = json.load(open({self._REMOTE_AUTH_PATH!r}, encoding="utf-8"))
tokens = src.get("tokens") or src
access_token = tokens.get("access_token")

def jwt_exp_ms(token):
    try:
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return int(json.loads(base64.urlsafe_b64decode(payload))["exp"]) * 1000
    except (AttributeError, IndexError, KeyError, TypeError, ValueError):
        return None

expires_ms = jwt_exp_ms(access_token) or jwt_exp_ms(tokens.get("id_token"))
required = {{
    "OPENAI_API_KEY": access_token,
    "OPENAI_REFRESH_TOKEN": tokens.get("refresh_token"),
}}
missing = [key for key, value in required.items() if not value]
if missing:
    raise SystemExit("missing auth fields: " + ", ".join(missing))
env_values = dict(required)
if tokens.get("account_id"):
    env_values["OPENAI_ACCOUNT_ID"] = tokens["account_id"]
if expires_ms is not None:
    env_values["OPENAI_TOKEN_EXPIRES"] = expires_ms
with open({self._REMOTE_ENV_PATH!r}, "w", encoding="utf-8") as handle:
    for key, value in env_values.items():
        handle.write("export " + key + "=" + shlex.quote(str(value)) + "\\n")
"""
        try:
            await self.exec_as_agent(
                environment,
                command=(
                    f"umask 077; python3 - <<'PY'\n{auth_bridge}PY\n"
                    f"chmod 600 {shlex.quote(self._REMOTE_ENV_PATH)}"
                ),
            )
        except BaseException:
            await self._cleanup_runtime(environment)
            raise

        session_id = self.session_id or f"harbor-{self.name()}"
        output_path = EnvironmentPaths.agent_dir / self._OUTPUT_FILENAME
        priority_flag = " -p" if self._PRIORITY else ""
        quoted_output = shlex.quote(output_path.as_posix())
        command = (
            "set -uo pipefail; "
            f"source {shlex.quote(self._REMOTE_ENV_PATH)}; "
            "export OPENAI_LOGIN=oauth; "
            "export TURA_ENV_PATH=/tmp/tura-home/.env; "
            "export TURA_HOME=/tmp/tura-home; "
            "export TURA_DB_ROOT=/tmp/tura-db; "
            "export SESSION_LOG_DB_ROOT=/tmp/tura-db/session_log; "
            "export TURA_DEBUG_RUNTIME=1; "
            "export TURA_RUNTIME_WORKER_STDERR_LOG="
            "/logs/agent/tura-runtime.stderr.log; "
            "setsid tura exec shll --json --skip-git-repo-check "
            f"--session-id {shlex.quote(session_id)} "
            f"--agent-id {shlex.quote(self._AGENT_ID)} "
            f"-m {shlex.quote(self._MODEL)} "
            f"--model-reasoning-effort {shlex.quote(self._REASONING_EFFORT)} "
            f"--planning {shlex.quote(self._PLANNING)}"
            f"{priority_flag} "
            '--cwd "$PWD" '
            f"{shlex.quote(instruction)} "
            f">{quoted_output} 2>&1 </dev/null & "
            "tura_pid=$!; "
            "set +e; wait \"$tura_pid\"; tura_status=$?; set -e; "
            # Tura's failed runtime may leave session workers alive. They must
            # not retain the container or the agent log descriptors until the
            # full Harbor timeout. The parent has already completed here.
            "kill -TERM -- -\"$tura_pid\" 2>/dev/null || true; "
            "sleep 0.2; "
            "kill -KILL -- -\"$tura_pid\" 2>/dev/null || true; "
            f"cat {quoted_output}; exit \"$tura_status\""
        )
        try:
            result = await self.exec_as_agent(environment, command=command)
            final = self._last_turn_completed(result.stdout)
            if final is None:
                raise NonZeroAgentExitCodeError(
                    "Tura exited without a turn.completed protocol event"
                )
            if final.get("status") != "completed":
                detail = self._event_error_text(final) or json.dumps(
                    final, sort_keys=True
                )
                exception = self._classify_tura_error(detail)
                raise exception(f"Tura reported an unsuccessful turn: {detail}")

            expected = {
                "acceleration_enabled": self._PRIORITY,
                "agent": self._AGENT_ID,
                "model": self._MODEL,
                "priority": self._PRIORITY,
                "reasoning_effort": self._REASONING_EFFORT,
                "service_tier": "priority" if self._PRIORITY else "default",
                "session_id": session_id,
            }
            mismatches = {
                key: {"expected": value, "actual": final.get(key)}
                for key, value in expected.items()
                if final.get(key) != value
            }
            if mismatches:
                raise NonZeroAgentExitCodeError(
                    "Tura protocol metadata mismatch: "
                    + json.dumps(mismatches, sort_keys=True)
                )
        finally:
            await self._cleanup_runtime(environment)

    @override
    def populate_context_post_run(self, context: AgentContext) -> None:
        output = self.logs_dir / self._OUTPUT_FILENAME
        if not output.is_file():
            return

        final = self._last_turn_completed(
            output.read_text(encoding="utf-8", errors="replace")
        )
        if final is None:
            return
        usage = final.get("usage")
        if final.get("status") != "completed" or not isinstance(usage, dict):
            raise ValueError("Tura completion event has no completed usage record")
        try:
            prompt = int(usage.get("input_tokens") or 0)
            cached = int(usage.get("cached_input_tokens") or 0)
            output_tokens = int(usage.get("output_tokens") or 0)
        except (TypeError, ValueError) as exc:
            raise ValueError("Tura completion event has invalid token counts") from exc
        if min(prompt, cached, output_tokens) < 0 or cached > prompt:
            raise ValueError("Tura completion event has inconsistent token counts")
        uncached = prompt - cached

        context.n_input_tokens = prompt
        context.n_cache_tokens = cached
        context.n_output_tokens = output_tokens
        context.cost_usd = (
            uncached * 5.0 + cached * 0.5 + output_tokens * 30.0
        ) / 1_000_000
        context.metadata = {
            "acceleration_enabled": final.get("acceleration_enabled"),
            "agent_id": final.get("agent"),
            "priority": final.get("priority"),
            "reasoning_effort": final.get("reasoning_effort"),
            "model": final.get("model"),
            "service_tier": final.get("service_tier"),
            "session_id": final.get("session_id"),
            "status": final.get("status"),
            "cost_basis": "modelled_api_equivalent",
            "usage": usage,
        }
