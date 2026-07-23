"use strict";

const durationMs = Number(process.argv[2] ?? 60_000);

setTimeout(() => {
  process.exitCode = 0;
}, durationMs);
