import fs from "node:fs/promises";
import { aggregateSavings } from "./savings.mjs";
import { telemetryPath } from "./paths.mjs";

const CHUNK_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 1024 * 1024;

// Keep only an aggregate and the unfinished record, never the complete history.
export class TelemetryReader {
  #state;
  #queue = Promise.resolve();
  bytesRead = 0;
  recordsParsed = 0;

  constructor(file = telemetryPath()) {
    this.file = file;
  }

  read(options = {}) {
    const operation = this.#queue.then(() => this.#read(options));
    this.#queue = operation.catch(() => {});
    return operation;
  }

  async #read({ final = false, onRecord } = {}) {
    let handle;
    try {
      handle = await fs.open(this.file, "r");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      this.#state = undefined;
      return aggregateSavings([]);
    }
    try {
      const stat = await handle.stat();
      let previous = this.#state;
      if (previous && (previous.dev !== stat.dev || previous.ino !== stat.ino ||
          stat.size < previous.offset)) previous = undefined;
      if (previous?.anchor.length) {
        const anchor = Buffer.alloc(previous.anchor.length);
        const { bytesRead } = await handle.read(anchor, 0, anchor.length,
          previous.offset - anchor.length);
        this.bytesRead += bytesRead;
        if (bytesRead !== anchor.length || !anchor.equals(previous.anchor)) previous = undefined;
      }
      const state = previous ? {
        ...previous, summary: structuredClone(previous.summary)
      } : {
        dev: stat.dev, ino: stat.ino, offset: 0, line: 0,
        pending: Buffer.alloc(0), anchor: Buffer.alloc(0), summary: aggregateSavings([])
      };
      const buffer = Buffer.alloc(CHUNK_BYTES);
      const accept = (bytes, incomplete = false, target = state.summary) => {
        if (bytes.length > MAX_RECORD_BYTES) throw new Error(`Telemetry record too large at line ${state.line + 1}`);
        const line = bytes.toString("utf8").trim();
        if (!line) return;
        let record;
        try {
          record = JSON.parse(line);
        } catch {
          if (incomplete) return;
          throw new Error(`Invalid telemetry JSON at line ${state.line + 1}`);
        }
        if (record?.schema === "codex-zero-telemetry-v1") {
          aggregateSavings([record], target);
          this.recordsParsed += 1;
          onRecord?.(record);
        }
      };
      // Read a fixed snapshot; appends during this read belong to the next refresh.
      while (state.offset < stat.size) {
        const { bytesRead } = await handle.read(buffer, 0,
          Math.min(buffer.length, stat.size - state.offset), state.offset);
        if (!bytesRead) throw new Error("Telemetry changed while reading. Try again.");
        this.bytesRead += bytesRead;
        const chunk = buffer.subarray(0, bytesRead);
        state.anchor = Buffer.from(Buffer.concat([state.anchor, chunk]).subarray(-128));
        state.offset += bytesRead;
        const data = state.pending.length ? Buffer.concat([state.pending, chunk]) : chunk;
        let start = 0;
        for (let end = data.indexOf(10); end !== -1; end = data.indexOf(10, start)) {
          accept(data.subarray(start, end));
          state.line += 1;
          start = end + 1;
        }
        state.pending = Buffer.from(data.subarray(start));
        if (state.pending.length > MAX_RECORD_BYTES) throw new Error(`Telemetry record too large at line ${state.line + 1}`);
      }
      // Commit only complete records. A writer can be between JSON and its newline.
      this.#state = state;
      const summary = structuredClone(state.summary);
      if (final && state.pending.length) {
        accept(state.pending, true, summary);
      }
      return summary;
    } finally {
      await handle.close();
    }
  }
}

export async function readSavings(file = telemetryPath()) {
  return new TelemetryReader(file).read({ final: true });
}
