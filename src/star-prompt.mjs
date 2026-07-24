import fs from "node:fs/promises";
import path from "node:path";
import { aggregateSavings, readTelemetry } from "./savings.mjs";
import { codexZeroHome, telemetryPath } from "./paths.mjs";

const REPOSITORY_URL = "https://github.com/Retro2512/CodexZero";
const USES_BEFORE_PROMPT = 3;

export async function maybeSuggestStar({
  home = codexZeroHome(),
  telemetryFile = telemetryPath(),
  stream = process.stdout,
  interactive = Boolean(stream?.isTTY)
} = {}) {
  try {
    const stateFile = path.join(home, "star-prompt.json");
    const state = await readState(stateFile);
    if (state.star_prompt_shown_at) return false;

    state.successful_launches += 1;
    await writeState(stateFile, state);

    if (
      !interactive ||
      state.successful_launches < USES_BEFORE_PROMPT
    ) {
      return false;
    }

    const savings = aggregateSavings(await readTelemetry(telemetryFile));
    const hasMeasuredBenefit =
      savings.measured.modelVisibleTokensEliminated > 0 ||
      savings.measured.modelCallsEliminated > 0;
    if (!hasMeasuredBenefit) return false;

    state.star_prompt_shown_at = new Date().toISOString();
    await writeState(stateFile, state);
    stream.write(`\nFinding CodexZero useful? Star it: ${REPOSITORY_URL}\n`);
    return true;
  } catch {
    return false;
  }
}

async function readState(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    return {
      schema: "codex-zero-star-prompt-v1",
      successful_launches: Number.isSafeInteger(value.successful_launches)
        ? Math.max(0, value.successful_launches)
        : 0,
      star_prompt_shown_at: value.star_prompt_shown_at || null
    };
  } catch {
    return {
      schema: "codex-zero-star-prompt-v1",
      successful_launches: 0,
      star_prompt_shown_at: null
    };
  }
}

async function writeState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await fs.rename(temporary, file);
}
