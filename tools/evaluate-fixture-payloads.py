#!/usr/bin/env python3
"""Apply the production monotonic payload rules to captured fixture bytes."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import tiktoken

ENCODING = tiktoken.get_encoding("o200k_base")
SGR = re.compile(r"\x1b\[[0-?]*[ -/]*m")
OSC8 = re.compile(r"\x1b\]8;;([^\x07\x1b]*)(?:\x07|\x1b\\)(.*?)\x1b\]8;;(?:\x07|\x1b\\)", re.DOTALL)


def tokens(text: str) -> int:
    return len(ENCODING.encode(text, disallowed_special=()))


def encode_terminal(raw: bytes) -> tuple[str, str | None, bool]:
    source = raw.decode("utf-8", errors="replace")
    visible = OSC8.sub(lambda match: f"{match.group(2)} ({match.group(1)})", source)
    visible = SGR.sub("", visible)
    presentation_changed = visible != source
    normalized = visible.replace("\r\n", "\n").replace("\r", "\n")
    if tokens(normalized) >= tokens(visible):
        normalized = visible
    runs: list[dict[str, object]] = []
    for line in normalized.splitlines(keepends=True):
        if runs and runs[-1]["text"] == line:
            runs[-1]["count"] = int(runs[-1]["count"]) + 1
        else:
            runs.append({"count": 1, "text": line})
    rle = json.dumps(
        {"codec": "line-rle-v1", "runs": runs},
        ensure_ascii=False,
        separators=(",", ":"),
    )
    if tokens(rle) < tokens(normalized):
        return rle, "line-rle-v1", presentation_changed
    return normalized, None, presentation_changed


def evaluate(capture: dict[str, object], root: Path) -> dict[str, object]:
    combined = capture["combined"]
    raw = (root / str(combined["path"])).read_bytes()
    original_count = int(combined["o200kTokens"])
    wall_seconds = float(capture["wallTimeMs"]) / 1000
    original_sections = [
        "Chunk ID: fixture",
        f"Wall time: {wall_seconds:.4f} seconds",
        f"Process exited with code {capture['exitCode']}",
        f"Original token count: {original_count}",
        "Output:",
        raw.decode("utf-8", errors="replace"),
    ]
    original = "\n".join(original_sections)
    output, codec, presentation_changed = encode_terminal(raw)
    candidate: dict[str, object] = {
        "chunk_id": "fixture",
        "wall_time_seconds": wall_seconds,
        "exit_code": capture["exitCode"],
        "original_token_count": original_count,
        "artifact": {
            "sha256": combined["sha256"],
            "raw_byte_count": combined["bytes"],
            "original_token_count": original_count,
        },
    }
    if codec:
        candidate["codec"] = codec
    if presentation_changed:
        candidate["presentation_styling_removed"] = True
    if output:
        candidate["output"] = output
    compact = json.dumps(candidate, ensure_ascii=False, separators=(",", ":"))
    before = tokens(original)
    candidate_tokens = tokens(compact)
    transformed = candidate_tokens < before
    after = candidate_tokens if transformed else before
    return {
        "fixture": capture["id"],
        "raw_sha256": combined["sha256"],
        "raw_byte_count": combined["bytes"],
        "original_model_payload_tokens": before,
        "candidate_model_payload_tokens": candidate_tokens,
        "selected_model_payload_tokens": after,
        "tokens_eliminated": before - after,
        "transformed": transformed,
        "codec": codec if transformed else None,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text(encoding="utf-8-sig"))
    rows = [evaluate(capture, args.manifest.parent) for capture in manifest["captures"]]
    before = sum(int(row["original_model_payload_tokens"]) for row in rows)
    after = sum(int(row["selected_model_payload_tokens"]) for row in rows)
    report = {
        "schema": "codex-zero-fixture-payload-report-v1",
        "measurement_type": "deterministic fixture replay",
        "tokenizer": "o200k_base",
        "results": rows,
        "totals": {
            "original_model_payload_tokens": before,
            "selected_model_payload_tokens": after,
            "tokens_eliminated": before - after,
            "reduction_percent": round((before - after) / before * 100, 2) if before else 0,
        },
        "notes": [
            "Every row uses the original payload when the candidate is equal-sized or larger.",
            "These fixture replay results are not observed production savings.",
            "Raw bytes are referenced by SHA-256 and remain in the private artifact store.",
        ],
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
