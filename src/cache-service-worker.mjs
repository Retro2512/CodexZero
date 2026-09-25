import { parentPort, workerData } from "node:worker_threads";
import { readCacheSnapshot, saveCacheSettings, setCacheEnabled, cacheActivity } from "./cache-service.mjs";

if (!parentPort) throw new Error("Cache service requires a worker thread");

const operations = Object.freeze({ readCacheSnapshot, saveCacheSettings, setCacheEnabled, cacheActivity });

parentPort.on("message", async ({ id, method, args }) => {
  if (!Number.isSafeInteger(id) || !Object.hasOwn(operations, method) || !Array.isArray(args)) return;
  try {
    const value = await operations[method](...args, workerData?.home);
    parentPort.postMessage({ id, ok: true, value });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, name: error instanceof TypeError ? "TypeError" : "Error",
      message: error instanceof Error ? error.message : String(error) });
  }
});
