import { parentPort } from "node:worker_threads";
import { readBrandHints, invalidateBrandHints } from "./sidebar-brand-hints.mjs";

if (!parentPort) throw new Error("Brand hints require a worker thread");

const operations = Object.freeze({ readBrandHints, invalidateBrandHints });
parentPort.on("message", async ({ id, method, root }) => {
  if (!Number.isSafeInteger(id) || !Object.hasOwn(operations, method)) return;
  try { parentPort.postMessage({ id, ok: true, value: await operations[method](root) }); }
  catch (error) {
    parentPort.postMessage({ id, ok: false, name: error instanceof TypeError ? "TypeError" : "Error",
      message: error instanceof Error ? error.message : String(error) });
  }
});
