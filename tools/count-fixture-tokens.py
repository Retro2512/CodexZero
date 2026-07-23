import json
import sys
from pathlib import Path

import tiktoken


def main() -> None:
    manifest_path = Path(sys.argv[1])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    root = manifest_path.parent
    encoding = tiktoken.get_encoding("o200k_base")

    for capture in manifest["captures"]:
        artifact = capture["combined"]
        raw = (root / artifact["path"]).read_bytes()
        text = raw.decode("utf-8", errors="replace")
        capture["combined"]["o200kTokens"] = len(encoding.encode(text))

    manifest["tokenizer"] = "o200k_base"
    manifest_path.write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
