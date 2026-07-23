#!/usr/bin/env python3
"""Create a content-free hash/token manifest for generated prompt metadata."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
from collections import Counter
from pathlib import Path

import tiktoken

TAGS = {
    "permissions": "permissions instructions",
    "apps": "apps_instructions",
    "plugins": "plugins_instructions",
    "skills": "skills_instructions",
}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("prompt_input", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()

    payload = json.loads(args.prompt_input.read_text(encoding="utf-8-sig"))
    texts = [
        content["text"]
        for item in payload
        for content in item.get("content", [])
        if content.get("type") == "input_text" and isinstance(content.get("text"), str)
    ]
    encoding = tiktoken.get_encoding("o200k_base")
    blocks: list[dict[str, object]] = []
    hashes: list[str] = []
    for label, tag in TAGS.items():
        pattern = re.compile(
            rf"<{re.escape(tag)}>(.*?)</{re.escape(tag)}>",
            flags=re.DOTALL,
        )
        for source_index, text in enumerate(texts):
            for occurrence, match in enumerate(pattern.finditer(text), start=1):
                raw = match.group(0).encode("utf-8")
                sha256 = hashlib.sha256(raw).hexdigest()
                hashes.append(sha256)
                blocks.append(
                    {
                        "tag": label,
                        "source_index": source_index,
                        "occurrence": occurrence,
                        "sha256": sha256,
                        "byte_count": len(raw),
                        "token_count": len(
                            encoding.encode(match.group(0), disallowed_special=())
                        ),
                    }
                )

    counts = Counter(hashes)
    duplicates = [
        {"sha256": digest, "occurrences": count}
        for digest, count in sorted(counts.items())
        if count > 1
    ]
    result = {
        "schema": "codex-zero-metadata-manifest-v1",
        "tokenizer": "o200k_base",
        "blocks": blocks,
        "byte_identical_duplicates": duplicates,
        "tokens_eliminated_if_exact_duplicates_removed": sum(
            next(
                int(block["token_count"])
                for block in blocks
                if block["sha256"] == duplicate["sha256"]
            )
            * (int(duplicate["occurrences"]) - 1)
            for duplicate in duplicates
        ),
        "contains_prompt_text": False,
    }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
