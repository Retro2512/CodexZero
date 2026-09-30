import test from "node:test";
import assert from "node:assert/strict";
import { createProviderKeyCache } from "../src/provider-secrets.mjs";

test("saved key requests share one decryption and changes invalidate it", async () => {
  const calls = [];
  const key = createProviderKeyCache(async value => { calls.push(value); return `plain:${value}`; });
  assert.deepEqual(await Promise.all([key("home/id", "a"), key("home/id", "a")]), ["plain:a", "plain:a"]);
  assert.equal(await key("home/id", "a"), "plain:a");
  assert.deepEqual(calls, ["a"]);
  assert.equal(await key("home/id", "b"), "plain:b");
  assert.equal(await key("home/id", undefined), "");
  assert.equal(await key("home/id", "b"), "plain:b");
  assert.deepEqual(calls, ["a", "b", "b"]);
});

test("key cache isolates identities, bounds entries and expires reuse", async () => {
  let clock = 0;
  const calls = [];
  const key = createProviderKeyCache(async value => { calls.push(value); return value; }, {
    now: () => clock, ttlMs: 10, maxEntries: 2,
  });
  await key("first", "a");
  await key("second", "a");
  await key("third", "c");
  await key("first", "a");
  assert.deepEqual(calls, ["a", "a", "c", "a"]);
  clock = 10;
  await key("first", "a");
  assert.equal(calls.length, 5);
});

test("failed decryption is retried without evicting a newer key", async () => {
  let fail;
  const key = createProviderKeyCache(value => value === "old"
    ? new Promise((_, reject) => { fail = reject; }) : "new secret");
  const old = key("id", "old");
  const rejected = assert.rejects(old, /failed/);
  assert.equal(await key("id", "new"), "new secret");
  fail(new Error("failed"));
  await rejected;
  assert.equal(await key("id", "new"), "new secret");
  let calls = 0;
  const retry = createProviderKeyCache(() => { if (++calls === 1) throw new Error("failed"); return "ok"; });
  await assert.rejects(retry("id", "encrypted"), /failed/);
  assert.equal(await retry("id", "encrypted"), "ok");
});
