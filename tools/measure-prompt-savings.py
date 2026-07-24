#!/usr/bin/env python3
"""Verify the bundled lean prompt and optionally compare another prompt."""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path

import tiktoken


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "prompts" / "manifest.json"


def measure_bytes(
    raw: bytes, label: str, encoding: tiktoken.Encoding
) -> dict[str, object]:
    text = raw.decode("utf-8")
    return {
        "path": label,
        "tokens": len(encoding.encode(text)),
        "bytes": len(raw),
        "sha256": hashlib.sha256(raw).hexdigest(),
    }


def measure(path: Path, encoding: tiktoken.Encoding) -> dict[str, object]:
    return measure_bytes(path.read_bytes(), str(path), encoding)


def main() -> int:
    parser = argparse.ArgumentParser()
    sources = parser.add_mutually_exclusive_group()
    sources.add_argument("--baseline", type=Path)
    sources.add_argument("--model-cache", type=Path)
    parser.add_argument("--model", default="gpt-5.6-sol")
    args = parser.parse_args()

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    encoding = tiktoken.get_encoding(manifest["tokenizer"])
    bundled_path = MANIFEST.parent / manifest["bundled_prompt"]["path"]
    bundled = measure(bundled_path, encoding)

    expected = manifest["bundled_prompt"]
    for field in ("tokens", "bytes", "sha256"):
        if bundled[field] != expected[field]:
            raise SystemExit(
                f"bundled prompt {field} mismatch: {bundled[field]} != {expected[field]}"
            )

    result: dict[str, object] = {
        "schema": "codex-zero-prompt-measurement-v1",
        "tokenizer": manifest["tokenizer"],
        "bundled": bundled,
        "verified": True,
    }
    baseline = None
    if args.baseline:
        baseline = measure(args.baseline.resolve(), encoding)
    elif args.model_cache:
        cache = json.loads(args.model_cache.read_text(encoding="utf-8"))
        models = cache.get("models", cache)
        model = next((item for item in models if item.get("slug") == args.model), None)
        if not model or not isinstance(model.get("base_instructions"), str):
            raise SystemExit(f"model {args.model!r} has no base_instructions in the cache")
        baseline = measure_bytes(
            model["base_instructions"].encode("utf-8"),
            f"{args.model} base_instructions",
            encoding,
        )

    if baseline:
        difference = int(baseline["tokens"]) - int(bundled["tokens"])
        result["baseline"] = baseline
        result["comparison"] = {
            "tokens_removed_per_model_request": difference,
            "reduction_percent": round(
                difference / int(baseline["tokens"]) * 100, 1
            )
            if baseline["tokens"]
            else 0,
        }

    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
