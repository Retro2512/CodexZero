import json
import sys
from pathlib import Path

import tiktoken


def count_artifact(root: Path, artifact: dict, encoding) -> int:
    raw = (root / artifact["path"]).read_bytes()
    text = raw.decode("utf-8", errors="replace")
    return len(encoding.encode(text))


def main() -> None:
    manifest_path = Path(sys.argv[1])
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    root = manifest_path.parent
    encoding = tiktoken.get_encoding("o200k_base")

    for run in manifest["runs"]:
      tool_tokens = 0
      if run["session"]:
          for artifact in run["session"]["toolOutputs"]:
              tokens = count_artifact(root, artifact, encoding)
              artifact["o200kTokens"] = tokens
              tool_tokens += tokens
      run["toolOutputTokens"] = tool_tokens

    manifest["tokenizer"] = "o200k_base"
    manifest_path.write_text(
        json.dumps(manifest, indent=2) + "\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
