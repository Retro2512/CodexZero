import { Worker } from "node:worker_threads";

const METHODS = new Set(["readCacheSnapshot", "saveCacheSettings", "setCacheEnabled", "cacheActivity"]);
const WORKER_URL = new URL("./cache-service-worker.mjs", import.meta.url);

/** Owns one disposable cache worker. No rollout discovery or parsing runs on its caller's thread. */
export function createCacheServiceClient({ home, timeoutMs = 60_000, maxPending = 64 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(maxPending) || maxPending < 1) {
    throw new TypeError("Invalid cache worker limits");
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
    const target = new Worker(WORKER_URL, { workerData: { home } });
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
    target.on("exit", code => discard(target, new Error(`Cache worker exited (${code})`), false));
    return target;
  }

  function call(method, args) {
    if (!METHODS.has(method)) return Promise.reject(new TypeError("Invalid cache operation"));
    if (closed) return Promise.reject(new Error("Cache worker is closed"));
    if (pending.size >= maxPending) return Promise.reject(new Error("Cache worker is busy"));
    return new Promise((resolve, reject) => {
      let target;
      try { target = getWorker(); }
      catch (error) { reject(error); return; }
      const id = ++sequence;
      const timer = setTimeout(() => discard(target, new Error("Cache worker timed out")), timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try { target.postMessage({ id, method, args }); }
      catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  return Object.freeze({
    readCacheSnapshot: id => call("readCacheSnapshot", [id]),
    saveCacheSettings: value => call("saveCacheSettings", [value]),
    setCacheEnabled: (id, enabled) => call("setCacheEnabled", [id, enabled]),
    cacheActivity: id => call("cacheActivity", [id]),
    async close() {
      closed = true;
      if (!worker) return;
      const target = worker;
      discard(target, new Error("Cache worker is closed"), false);
      await target.terminate();
    },
  });
}
