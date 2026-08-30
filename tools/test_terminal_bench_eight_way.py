import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE_PATH = Path(__file__).with_name("run-terminal-bench-eight-way.py")
SPEC = importlib.util.spec_from_file_location("tb8", MODULE_PATH)
assert SPEC and SPEC.loader
tb8 = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(tb8)


class DispositionTests(unittest.TestCase):
    def test_agent_timeout_with_zero_reward_is_scored(self):
        with tempfile.TemporaryDirectory() as raw:
            trial = Path(raw)
            (trial / "result.json").write_text(
                json.dumps(
                    {
                        "exception_info": {"exception_type": "AgentTimeoutError"},
                        "verifier_result": {"rewards": {"reward": 0}},
                    }
                )
            )
            status = tb8.classify_trial(trial)
            self.assertTrue(status["scored"])
            self.assertFalse(status["retryable"])
            self.assertEqual(status["rewards"], {"reward": 0})

    def test_agent_timeout_without_verifier_is_terminal_zero(self):
        with tempfile.TemporaryDirectory() as raw:
            trial = Path(raw)
            (trial / "result.json").write_text(
                json.dumps(
                    {"exception_info": {"exception_type": "AgentTimeoutError"}}
                )
            )
            status = tb8.classify_trial(trial)
            self.assertEqual(status["disposition"], "terminal_agent_failure")
            self.assertTrue(status["scored"])
            self.assertTrue(status["synthetic_zero"])
            self.assertEqual(status["rewards"], {"reward": 0.0})

    def test_terminal_agent_process_failure_is_zero_not_retry(self):
        with tempfile.TemporaryDirectory() as raw:
            trial = Path(raw)
            (trial / "result.json").write_text(
                json.dumps(
                    {
                        "exception_info": {
                            "exception_type": "NonZeroAgentExitCodeError"
                        }
                    }
                )
            )
            status = tb8.classify_trial(trial)
            self.assertEqual(status["disposition"], "terminal_agent_failure")
            self.assertTrue(status["scored"])
            self.assertFalse(status["retryable"])
            self.assertEqual(status["rewards"], {"reward": 0.0})

    def test_quota_words_in_prompt_transcript_are_not_quota_evidence(self):
        with tempfile.TemporaryDirectory() as raw:
            trial = Path(raw)
            (trial / "agent").mkdir()
            (trial / "agent" / "codex.txt").write_text(
                "Task: handle error insufficient_quota in this fixture"
            )
            (trial / "trial.log").write_text(
                "Prompt includes: you've hit your usage limit"
            )
            status = tb8.classify_trial(trial)
            self.assertEqual(status["disposition"], "incomplete")

    def test_structured_turn_failure_is_quota(self):
        with tempfile.TemporaryDirectory() as raw:
            trial = Path(raw)
            (trial / "agent").mkdir()
            (trial / "agent" / "stdout.jsonl").write_text(
                json.dumps(
                    {
                        "type": "turn.failed",
                        "error": {"message": "insufficient_quota"},
                    }
                )
                + "\n"
            )
            status = tb8.classify_trial(trial)
            self.assertEqual(status["disposition"], "quota")
            self.assertTrue(status["retryable"])

    def test_quota_result_is_censored_even_if_reward_is_present(self):
        with tempfile.TemporaryDirectory() as raw:
            trial = Path(raw)
            (trial / "result.json").write_text(
                json.dumps(
                    {
                        "exception_info": {
                            "exception_type": "ProviderError",
                            "exception_message": "usage_limit_reached",
                        },
                        "verifier_result": {"rewards": {"reward": 0}},
                    }
                )
            )
            status = tb8.classify_trial(trial)
            self.assertEqual(status["disposition"], "quota")
            self.assertFalse(status["scored"])


class OrderingAndConfigTests(unittest.TestCase):
    def test_prescribed_order_is_used_exactly(self):
        with tempfile.TemporaryDirectory() as raw:
            root = Path(raw)
            manifest = root / "dataset.json"
            manifest.write_text(
                json.dumps(
                    {
                        "tasks": [
                            {"index": 1, "name": "b"},
                            {"index": 2, "name": "a"},
                        ]
                    }
                )
            )
            order, seal = tb8.prescribed_task_order(
                manifest,
                [{"name": "a"}, {"name": "b"}],
                expected_count=2,
            )
            self.assertEqual(order, ["b", "a"])
            self.assertEqual(seal["sha256"], tb8.sha256_file(manifest))

    def test_tura_label_is_discoverable(self):
        with tempfile.TemporaryDirectory() as raw:
            trial = Path(raw)
            (trial / "config.json").write_text(
                json.dumps(
                    {
                        "agent": {
                            "env": {"TURA_BENCHMARK_LABEL": "tura_balanced"}
                        }
                    }
                )
            )
            self.assertEqual(tb8.trial_arm_id(trial), "tura_balanced")

    def test_task_wave_contains_only_missing_arms(self):
        plan = {
            "jobs_dir": "/tmp/jobs",
            "environment": {"type": "docker"},
            "verifier": {"disable": False},
            "dataset": {"kind": "local", "path": "/tmp/tasks"},
        }
        task = {
            "index": 0,
            "name": "x",
            "arm_order": list(tb8.ARM_IDS),
        }
        arm_configs = {
            identifier: {
                "agent": {
                    "env": {"CODEX_BENCHMARK_LABEL": identifier}
                }
            }
            for identifier in tb8.ARM_IDS
        }
        missing = ["stock_codex", "rtk"]
        _, config = tb8.build_job_config(
            plan=plan,
            task=task,
            attempt=2,
            missing=missing,
            arm_configs=arm_configs,
        )
        self.assertEqual(config["n_concurrent_trials"], 2)
        self.assertEqual(
            [agent["env"]["CODEX_BENCHMARK_LABEL"] for agent in config["agents"]],
            missing,
        )


if __name__ == "__main__":
    unittest.main()
