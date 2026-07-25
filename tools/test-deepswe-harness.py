#!/usr/bin/env python3
"""Focused regression tests for DeepSWE trial classification."""

from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path
from typing import Any


def load_runner() -> Any:
    path = Path(__file__).with_name("run-deepswe-five-way.py")
    spec = importlib.util.spec_from_file_location("deepswe_runner", path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Cannot import {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


RUNNER = load_runner()


class TrialStatusTests(unittest.TestCase):
    def valid_trial(self, root: Path, log: str) -> Path:
        (root / "agent").mkdir()
        (root / "verifier").mkdir()
        (root / "agent" / "codex.txt").write_text(log, encoding="utf-8")
        (root / "result.json").write_text(
            json.dumps({"exception_info": None}), encoding="utf-8"
        )
        (root / "verifier" / "reward.json").write_text(
            json.dumps({"reward": 1}), encoding="utf-8"
        )
        (root / "agent" / "trajectory.json").write_text(
            json.dumps({"final_metrics": {"total_prompt_tokens": 1}}),
            encoding="utf-8",
        )
        return root

    def test_application_rate_limit_text_is_not_provider_quota(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            trial = self.valid_trial(
                Path(directory),
                "Application response: 429 Rate limit exceeded.",
            )
            self.assertEqual(RUNNER.trial_status(trial, "codex"), ("complete", None))

    def test_valid_artifacts_take_precedence_over_log_text(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            trial = self.valid_trial(
                Path(directory),
                "Historical note: you've hit your usage limit.",
            )
            self.assertEqual(RUNNER.trial_status(trial, "codex"), ("complete", None))

    def test_provider_specific_quota_without_result_is_quota(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            trial = Path(directory)
            (trial / "agent").mkdir()
            (trial / "agent" / "codex.txt").write_text(
                "You've hit your usage limit.",
                encoding="utf-8",
            )
            self.assertEqual(RUNNER.trial_status(trial, "codex")[0], "quota")


if __name__ == "__main__":
    unittest.main()
