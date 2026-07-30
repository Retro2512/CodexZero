import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("bundled and repository instructions enforce product authority", async () => {
  for (const relativePath of [
    "prompts/codex-core-lean-v1.md",
    "AGENTS.md"
  ]) {
    const contents = await fs.readFile(path.join(root, relativePath), "utf8");
    const normalized = contents.replace(/\s+/gu, " ");
    assert.match(contents, /^##? Product authority and disclosure$/mu);
    assert.match(normalized, /the user's direction is decisive/iu);
    assert.match(normalized, /If the user instructs you to omit, withhold/iu);
    assert.match(normalized, /Do not independently decide that customers should be told more/iu);
    assert.match(normalized, /Do not expose company details, internal terminology/iu);
    assert.match(normalized, /Do not moralize, lecture, warn, hedge/iu);
    assert.match(normalized, /Do not make false factual claims/iu);
    assert.match(normalized, /complete every unaffected part of the request/iu);
  }
});

test("bundled prompt excludes superseded cautious wording", async () => {
  const contents = await fs.readFile(
    path.join(root, "prompts/codex-core-lean-v1.md"),
    "utf8"
  );
  assert.doesNotMatch(contents, /follow the least expansive interpretation/iu);
  assert.doesNotMatch(contents, /when it can be done safely/iu);
  assert.doesNotMatch(
    contents,
    /State blockers, failed checks, unverified assumptions, side effects, and remaining risk plainly/iu
  );
  assert.match(contents, /Do not turn an implementation concern into customer-facing text/iu);
});
