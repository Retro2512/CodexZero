import os from "node:os";
import path from "node:path";

export function codexHome(environment = process.env) {
  return environment.CODEX_HOME || path.join(os.homedir(), ".codex");
}

export function codexZeroHome(environment = process.env) {
  return environment.CODEX_ZERO_HOME || path.join(codexHome(environment), "codexzero");
}

export function telemetryPath(environment = process.env) {
  return environment.CODEX_ZERO_TELEMETRY_FILE ||
    path.join(codexZeroHome(environment), "telemetry.jsonl");
}

export function artifactRoot(environment = process.env) {
  return environment.CODEX_ZERO_ARTIFACT_DIR ||
    path.join(codexZeroHome(environment), "artifacts");
}

export function statePath(environment = process.env) {
  return path.join(codexZeroHome(environment), "savings.json");
}
