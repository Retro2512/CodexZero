import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { findSqliteFiles } from "../src/core-compatibility.mjs";

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
