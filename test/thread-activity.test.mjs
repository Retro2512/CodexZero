import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");

async function loadIdentity(t) {
  // The renderer module imports its schema by its published browser name.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cz-activity-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.copyFile(path.join(root, "src", "sidebar-identity-schema.mjs"), path.join(dir, "codexzero-sidebar-schema.js"));
  await fs.copyFile(path.join(root, "assets", "native-sidebar-identity.mjs"), path.join(dir, "identity.mjs"));
  await fs.writeFile(path.join(dir, "package.json"), '{"type":"module"}');
  return import(pathToFileURL(path.join(dir, "identity.mjs")).href);
}

test("thread activity distinguishes running, waiting, failed and idle threads", async t => {
  const { threadActivity } = await loadIdentity(t);
  const status = threadRuntimeStatus => ({ threadRuntimeStatus });
  assert.equal(threadActivity(status({ type: "active", activeFlags: [] })).state, "running");
  assert.deepEqual(threadActivity(status({ type: "active", activeFlags: ["waitingOnApproval"] })), { state: "waiting", label: "Needs approval" });
  assert.deepEqual(threadActivity(status({ type: "active", activeFlags: ["waitingOnUserInput"] })), { state: "waiting", label: "Needs answer" });
  assert.equal(threadActivity(status({ type: "idle" }), true).label, "Needs approval");
  assert.equal(threadActivity(status({ type: "systemError" })).state, "error");
  for (const value of [{ type: "idle" }, { type: "notLoaded" }, undefined]) assert.equal(threadActivity(status(value)).state, "idle");
  assert.equal(threadActivity(null).state, "idle");
});

test("elapsed time reads naturally at every scale", async t => {
  const { elapsedLabel } = await loadIdentity(t);
  assert.equal(elapsedLabel(-5), "0s");
  assert.equal(elapsedLabel(42_900), "42s");
  assert.equal(elapsedLabel(134_000), "2m 14s");
  assert.equal(elapsedLabel(3_725_000), "1h 02m");
});

test("activity start survives rerenders and resets when the state changes", async t => {
  const { activityStart } = await loadIdentity(t);
  assert.equal(activityStart("a", "running", 1000), 1000);
  assert.equal(activityStart("a", "running", 5000), 1000);
  assert.equal(activityStart("a", "waiting", 7000), 7000);
  assert.equal(activityStart("a", "idle", 8000), null);
  assert.equal(activityStart("a", "running", 9000), 9000);
});
