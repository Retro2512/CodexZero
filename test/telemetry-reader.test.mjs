import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { aggregateSavings, readTelemetry } from "../src/savings.mjs";
import { readSavings, TelemetryReader } from "../src/telemetry-reader.mjs";
import { startSavingsMonitor } from "../src/savings-monitor.mjs";

const event = (count = 1) => ({ schema: "codex-zero-telemetry-v1", event: "model_call_eliminated", count });
const line = (record) => `${JSON.stringify(record)}\n`;
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-telemetry-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return { file: path.join(root, "events.jsonl"), destination: path.join(root, "savings.json") };
}

test("streamed and incremental savings match full aggregation without rereading history", async (t) => {
  const { file } = await fixture(t);
  const records = Array.from({ length: 10000 }, (_, i) => event(i));
  await fs.writeFile(file, records.map(line).join(""));
  const reader = new TelemetryReader(file);
  assert.deepEqual(await reader.read(), aggregateSavings(records));
  const readBefore = reader.bytesRead;
  const added = event(23);
  await fs.appendFile(file, line(added));
  records.push(added);
  const summary = await reader.read();
  assert.deepEqual(summary, aggregateSavings(records));
  assert.equal(reader.bytesRead - readBefore, 128 + Buffer.byteLength(line(added)));
  assert.equal(reader.recordsParsed, records.length);
  summary.measured.modelCallsEliminated = -1;
  assert.deepEqual(await reader.read(), aggregateSavings(records));
  assert.deepEqual(await readSavings(file), aggregateSavings(records));
});

test("partial JSON and split UTF8 survive multiple refreshes and concurrent readers", async (t) => {
  const { file } = await fixture(t);
  const bytes = Buffer.from(line({ ...event(7), label: "🙂" }));
  const split = bytes.indexOf(Buffer.from("🙂")) + 2;
  await fs.writeFile(file, bytes.subarray(0, split));
  const reader = new TelemetryReader(file);
  assert.equal((await reader.read()).measured.modelCallsEliminated, 0);
  assert.deepEqual(await readTelemetry(file), []);
  await fs.appendFile(file, bytes.subarray(split, -1));
  assert.equal((await reader.read()).measured.modelCallsEliminated, 0);
  assert.equal((await readSavings(file)).measured.modelCallsEliminated, 7);
  await fs.appendFile(file, "\n");
  const results = await Promise.all(Array.from({ length: 8 }, () => reader.read()));
  assert.ok(results.every((s) => s.measured.modelCallsEliminated === 7));
  assert.equal(reader.recordsParsed, 1);
});

test("missing files, truncation, regrowth and rotation reset the aggregate", async (t) => {
  const { file } = await fixture(t);
  const reader = new TelemetryReader(file);
  assert.deepEqual(await reader.read(), aggregateSavings([]));
  await fs.writeFile(file, line(event(90)).repeat(10));
  assert.equal((await reader.read()).measured.modelCallsEliminated, 900);
  await fs.writeFile(file, line(event(21)).repeat(12));
  assert.equal((await reader.read()).measured.modelCallsEliminated, 252);
  await fs.writeFile(file, line(event(8)));
  assert.equal((await reader.read()).measured.modelCallsEliminated, 8);
  await fs.rename(file, `${file}.old`);
  await fs.writeFile(file, line(event(3)));
  assert.equal((await reader.read()).measured.modelCallsEliminated, 3);
  await fs.unlink(file);
  assert.deepEqual(await reader.read(), aggregateSavings([]));
});

test("corrupt complete records fail without committing partial counts and recover after repair", async (t) => {
  const { file } = await fixture(t);
  const reader = new TelemetryReader(file);
  await fs.writeFile(file, line(event(5)));
  await reader.read();
  await fs.appendFile(file, `${line(event(6))}invalid\n`);
  await assert.rejects(reader.read(), /line 3/);
  await fs.writeFile(file, line(event(5)) + line(event(6)));
  assert.equal((await reader.read()).measured.modelCallsEliminated, 11);
});

test("blank lines and other schemas are ignored and pending records are bounded", async (t) => {
  const { file } = await fixture(t);
  await fs.writeFile(file, `\r\nnull\r\n{}\n${line(event(2))}`);
  assert.deepEqual(await readTelemetry(file), [event(2)]);
  await fs.writeFile(file, "x".repeat(1024 * 1024 + 1));
  await assert.rejects(readSavings(file), /record too large/);
});

test("monitor serializes refreshes and publishes complete state atomically", async (t) => {
  const options = await fixture(t);
  const errors = [];
  const monitor = await startSavingsMonitor({ ...options, intervalMs: 250, onError: (e) => errors.push(e) });
  try {
    await fs.writeFile(options.file, line(event(1)));
    await Promise.all(Array.from({ length: 20 }, () => monitor.refresh()));
    assert.deepEqual(JSON.parse(await fs.readFile(options.destination)), aggregateSavings([event(1)]));
    await fs.appendFile(options.file, '{"schema":');
    await monitor.refresh();
    assert.equal(JSON.parse(await fs.readFile(options.destination)).measured.modelCallsEliminated, 1);
    assert.deepEqual(errors, []);
  } finally { await monitor.close(); }
});

test("continuous writes do not postpone filesystem driven monitor updates", async (t) => {
  const options = await fixture(t);
  await fs.writeFile(options.file, "");
  const errors = [];
  const monitor = await startSavingsMonitor({ ...options, intervalMs: 250, onError: (e) => errors.push(e) });
  let stop = false;
  const writer = (async () => {
    while (!stop) {
      await fs.appendFile(options.file, line(event(1)));
      await delay(20);
    }
  })();
  try {
    const deadline = Date.now() + 4000;
    let count = 0;
    while (Date.now() < deadline && !count) {
      await delay(30);
      count = JSON.parse(await fs.readFile(options.destination)).measured.modelCallsEliminated;
    }
    assert.ok(count > 0, "monitor must publish while writes are still arriving");
    assert.deepEqual(errors, []);
  } finally {
    stop = true;
    await writer;
    await monitor.close();
  }
});

test("invalid monitor intervals cannot overflow into rapid polling", async (t) => {
  const options = await fixture(t);
  for (const intervalMs of [0, 249, NaN, Infinity, 2147483648]) {
    await assert.rejects(startSavingsMonitor({ ...options, intervalMs }), /Monitor interval/);
  }
});
