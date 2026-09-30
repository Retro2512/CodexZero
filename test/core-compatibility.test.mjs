import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findSqliteFiles, sanitizedChildEnvironment } from "../src/core-compatibility.mjs";

test("compatibility probes do not inherit account or permission overrides", () => {
  const env = sanitizedChildEnvironment({ home: "home", providerHome: "providers", sqliteHome: "sqlite", core: "core" }, {
    PATH: "system path", CODEX_PERMISSION_PROFILE: "inherited profile", CODEX_POOLER_API_KEY: "fixture",
    CODEX_ZERO_TEST_BASELINE: "other core", OPENAI_API_KEY: "fixture", OPENAI_BASE_URL: "https://example.invalid",
  });
  assert.equal(env.PATH, "system path");
  assert.equal(env.CODEX_PERMISSION_PROFILE, undefined);
  assert.equal(env.CODEX_POOLER_API_KEY, undefined);
  assert.equal(env.CODEX_ZERO_TEST_BASELINE, undefined);
  assert.equal(env.OPENAI_BASE_URL, undefined);
  assert.equal(env.OPENAI_API_KEY, "offline-stock-key");
  assert.equal(env.CODEX_HOME, "home");
  assert.equal(env.CODEX_ZERO_PROVIDER_CORE, "core");
  assert.equal(env.CODEX_ZERO_CORE_UPDATES, "0");
});

test("database discovery checks headers rather than trusting file extensions", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cz-schema-discovery-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "nested"));
  const expected = [path.join(root, "nested", "unusual-name"), path.join(root, "state.sqlite")].sort();
  await Promise.all(expected.map(file => fs.writeFile(file, "SQLite format 3\0rest")));
  await Promise.all(Array.from({ length: 100 }, (_, i) =>
    fs.writeFile(path.join(root, "nested", `${i}.sqlite`), i % 2 ? "not a database at all" : "")));
  assert.deepEqual(await findSqliteFiles(root), expected);
});
