import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { aggregateSavings } from "../src/savings.mjs";
import { TelemetryReader } from "../src/telemetry-reader.mjs";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-zero-benchmark-"));
try {
  const file = path.join(root, "events.jsonl");
  const event = `${JSON.stringify({ schema: "codex-zero-telemetry-v1", event: "usage",
    input_tokens: 2000, cached_input_tokens: 1500, uncached_input_tokens: 500,
    cache_write_tokens: 100, output_tokens: 100, reasoning_tokens: 50, tool_calls: 2 })}\n`;
  const historyEvents = 50000;
  const refreshes = 20;
  await fs.writeFile(file, event.repeat(historyEvents));
  const reader = new TelemetryReader(file);
  let fullReadBytes = 0;
  let fullReadMs = 0;
  let incrementalMs = 0;
  for (let i = 0; i <= refreshes; i++) {
    if (i) await fs.appendFile(file, event);
    let start = performance.now();
    const raw = await fs.readFile(file, "utf8");
    const baseline = aggregateSavings(raw.trimEnd().split("\n").map(JSON.parse));
    fullReadMs += performance.now() - start;
    fullReadBytes += Buffer.byteLength(raw);
    start = performance.now();
    const incremental = await reader.read();
    incrementalMs += performance.now() - start;
    assert.deepEqual(incremental, baseline);
  }
  console.log(JSON.stringify({ schema: "codex-zero-client-benchmark-v1", historyEvents, refreshes,
    identicalAggregates: true, fullReadBytes, incrementalReadBytes: reader.bytesRead,
    ioReductionPercent: Number((100 * (1 - reader.bytesRead / fullReadBytes)).toFixed(2)),
    fullReadMs: Math.round(fullReadMs), incrementalMs: Math.round(incrementalMs),
    recordsParsed: reader.recordsParsed, node: process.version, platform: process.platform
  }, null, 2));
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
