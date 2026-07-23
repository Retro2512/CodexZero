"use strict";

Error.stackTraceLimit = 160;

function failAtDepth(depth) {
  if (depth === 0) {
    throw new Error("codexzero fixture: deterministic validation failure");
  }

  return failAtDepth(depth - 1);
}

try {
  failAtDepth(120);
} catch (error) {
  process.stderr.write(`${error.stack}\n`);
  process.exitCode = 17;
}
