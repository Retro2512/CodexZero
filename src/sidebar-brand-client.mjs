import { Worker } from "node:worker_threads";

const WORKER_URL = new URL("./sidebar-brand-worker.mjs", import.meta.url);
const METHODS = new Set(["readBrandHints", "invalidateBrandHints"]);

/** Keeps filesystem discovery and image decoding outside the main process thread. */
export function createBrandHintsClient({ timeoutMs = 15_000, maxPending = 64 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxPending) || maxPending < 1) {
    throw new TypeError("Invalid brand worker limits");
  }
  let worker;
  let sequence = 0;
  let closed = false;
  const pending = new Map();

  function discard(target, error, terminate = true) {
    if (worker !== target) return;
    worker = undefined;
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
    if (terminate) void target.terminate();
  }

  function getWorker() {
    if (worker) return worker;
    const target = new Worker(WORKER_URL);
    worker = target;
    target.on("message", reply => {
      if (worker !== target || !reply || !Number.isSafeInteger(reply.id)) return;
      const request = pending.get(reply.id);
      if (!request) return;
      pending.delete(reply.id);
      clearTimeout(request.timer);
      if (reply.ok) request.resolve(reply.value);
      else request.reject(reply.name === "TypeError" ? new TypeError(reply.message) : new Error(reply.message));
    });
    target.on("error", error => discard(target, error));
    target.on("exit", code => discard(target, new Error(`Brand worker exited (${code})`), false));
    return target;
  }

  function call(method, root) {
    if (!METHODS.has(method)) return Promise.reject(new TypeError("Invalid brand operation"));
    if (closed) return Promise.reject(new Error("Brand worker is closed"));
    if (pending.size >= maxPending) return Promise.reject(new Error("Brand worker is busy"));
    return new Promise((resolve, reject) => {
      let target;
      try { target = getWorker(); }
      catch (error) { reject(error); return; }
      const id = ++sequence;
      const timer = setTimeout(() => discard(target, new Error("Brand worker timed out")), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { target.postMessage({ id, method, root }); }
      catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
    });
  }

  return Object.freeze({
    readBrandHints: root => call("readBrandHints", root),
    invalidateBrandHints: root => call("invalidateBrandHints", root),
    async close() {
      closed = true;
      if (!worker) return;
      const target = worker;
      discard(target, new Error("Brand worker is closed"), false);
      await target.terminate();
    },
  });
}
