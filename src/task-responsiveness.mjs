import { replaceOnce } from "./sidebar-performance.mjs";

export const WARM_THREAD_LIMIT_MAIN_TARGET = "Codex app-server restart requested";
export const WARM_THREAD_LIMIT_RENDERER_TARGET = "desktop.thread_prewarm";

// The app keeps threads you recently left loaded so returning skips the slow
// reload. Raise how many stay loaded (the three hour expiry is unchanged).
const warmThreadLimit = /(isEphemeralSideConversation\),[\w$]+=Math\.max\(0,[\w$]+\.length-)10\)/g;
function patchWarmThreadLimit(source, limit) {
  if ((source.match(warmThreadLimit) ?? []).length !== 1) throw new Error("This Codex version needs an updated warm thread patch");
  return replaceOnce(source.replace(warmThreadLimit, (_, head) => `${head}${limit})`), "maxInactiveOwnerThreads:10,", `maxInactiveOwnerThreads:${limit},`);
}

export function patchWarmThreadLimitMain(source, limit = 24) {
  return patchWarmThreadLimit(source, limit);
}

export function patchWarmThreadLimitRenderer(source, limit = 24) {
  return patchWarmThreadLimit(source, limit);
}
