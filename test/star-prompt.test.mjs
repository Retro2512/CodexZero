import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { maybeSuggestStar } from "../src/star-prompt.mjs";

test("suggests starring once after three useful launches", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-star-"));
  const telemetryFile = path.join(home, "telemetry.jsonl");
  await fs.writeFile(
    telemetryFile,
    `${JSON.stringify({
      schema: "codex-zero-telemetry-v1",
      event: "exec_model_payload",
      original_tokens: 100,
      selected_tokens: 40,
      tokens_eliminated: 60,
      transformed: true
    })}\n`
  );
  const output = [];
  const stream = {
    isTTY: true,
    write(value) {
      output.push(value);
    }
  };

  assert.equal(await maybeSuggestStar({ home, telemetryFile, stream }), false);
  assert.equal(await maybeSuggestStar({ home, telemetryFile, stream }), false);
  assert.equal(await maybeSuggestStar({ home, telemetryFile, stream }), true);
  assert.equal(await maybeSuggestStar({ home, telemetryFile, stream }), false);

  assert.equal(output.length, 1);
  assert.match(output[0], /github\.com\/Retro2512\/CodexZero/u);
  const state = JSON.parse(await fs.readFile(path.join(home, "star-prompt.json"), "utf8"));
  assert.equal(state.successful_launches, 3);
  assert.ok(state.star_prompt_shown_at);
});

test("waits for measured benefit before suggesting a star", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-star-benefit-"));
  const telemetryFile = path.join(home, "telemetry.jsonl");
  const output = [];
  const stream = {
    isTTY: true,
    write(value) {
      output.push(value);
    }
  };

  for (let count = 0; count < 3; count += 1) {
    assert.equal(await maybeSuggestStar({ home, telemetryFile, stream }), false);
  }
  await fs.writeFile(
    telemetryFile,
    `${JSON.stringify({
      schema: "codex-zero-telemetry-v1",
      event: "model_call_eliminated",
      count: 1
    })}\n`
  );

  assert.equal(await maybeSuggestStar({ home, telemetryFile, stream }), true);
  assert.equal(output.length, 1);
});
