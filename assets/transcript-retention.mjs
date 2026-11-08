// Dormant data only. Callers must unsubscribe before parking and validate a
// fresh authoritative reset before exposing retained data to the UI.
// Walks protocol data and charges an approximate byte cost. The walk can be
// resumed, so large transcripts can be measured in small idle slices.
function createSizeWalker(roots, limit, maxVisited) {
  const seen = new WeakSet();
  const iterator = roots[Symbol.iterator]();
  const stack = [];
  let bytes = 0, visited = 0, scanned = 0, rootsDone = false;
  // Returns a byte count when finished, Infinity when rejected, or null when
  // the deadline passed first.
  return function run(clock, deadline) {
    for (;;) {
      if (!stack.length) {
        if (rootsDone) return bytes;
        const next = iterator.next();
        if (next.done) { rootsDone = true; continue; }
        stack.push(next.value);
      }
      const value = stack.pop();
      if (++visited > maxVisited) return Infinity;
      if ((visited & 7) === 0 && clock() > deadline) { stack.push(value); visited--; return null; }
      if (typeof value === "string") bytes += 32 + value.length * 2;
      else if (value && typeof value === "object") {
        if (seen.has(value)) continue;
        seen.add(value);
        // Reject host objects, accessors and collections. Projection roots are
        // protocol data; retaining anything else must fall back to disposal.
        const prototype = Object.getPrototypeOf(value);
        if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return Infinity;
        bytes += 256;
        for (const key in value) {
          ++scanned;
          if (!Object.hasOwn(value, key)) continue;
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !("value" in descriptor)) return Infinity;
          bytes += 64 + key.length * 2;
          stack.push(descriptor.value);
          if (stack.length + visited > maxVisited) return Infinity;
        }
      } else if (typeof value === "function" || typeof value === "symbol") return Infinity;
      else bytes += 16;
      if (bytes > limit) return Infinity;
    }
  };
}

// Dormant data only. Callers must unsubscribe before parking and validate a
// fresh authoritative reset before exposing retained data to the UI.
export function estimateRetainedBytes(roots, limit = 8 * 1024 * 1024,
  { clock = () => performance.now(), maxTimeMs = 3, maxVisited = 10000 } = {}) {
  if (maxTimeMs <= 0) return Infinity;
  const deadline = clock() + maxTimeMs;
  const result = createSizeWalker(roots, limit, maxVisited)(clock, deadline);
  return result == null || clock() > deadline ? Infinity : result;
}

// Measures in short slices so leaving a long thread never blocks the switch.
export function estimateRetainedBytesLater(roots, limit, done,
  { clock = () => performance.now(), sliceMs = 4, maxVisited = 3_000_000,
    schedule = setTimeout, cancel = clearTimeout } = {}) {
  const run = createSizeWalker(roots, limit, maxVisited);
  let timer = null, stopped = false;
  const step = () => {
    timer = null;
    if (stopped) return;
    const result = run(clock, clock() + sliceMs);
    if (result == null) timer = schedule(step, 0);
    else { stopped = true; done(result); }
  };
  timer = schedule(step, 0);
  return () => { stopped = true; if (timer != null) cancel(timer); timer = null; };
}

export function createTranscriptRetention({ maxEntries = 3, maxBytes = 8 * 1024 * 1024,
  maxEntryBytes = maxBytes, ttl = 30000, now = () => Date.now(), estimateClock = () => performance.now(),
  maxEstimateMs = 3, deferEstimate = false, maxRoots = 200000, schedule = setTimeout, cancel = clearTimeout } = {}) {
  const scopes = new WeakMap();
  const keyFor = key => JSON.stringify([key.hostId, key.threadId]);
  function bucket(scope) {
    let value = scopes.get(scope);
    if (!value) scopes.set(scope, value = { entries: new Map(), bytes: 0 });
    return value;
  }
  function remove(b, key, dispose) {
    const entry = b.entries.get(key);
    if (!entry) return;
    b.entries.delete(key);
    b.bytes -= entry.bytes;
    cancel(entry.timer);
    entry.stopEstimate?.();
    if (dispose) entry.dispose();
    return dispose ? undefined : entry.value;
  }
  function evictOldest(b) { remove(b, b.entries.keys().next().value, true); }
  function insert(b, k, value, bytes, dispose) {
    const entry = { value, bytes, dispose, expires: now() + ttl, timer: null, stopEstimate: null };
    b.entries.set(k, entry);
    b.bytes += bytes;
    try {
      entry.timer = schedule(() => { if (b.entries.get(k) === entry) remove(b, k, true); }, ttl);
    } catch (error) {
      remove(b, k, false);
      throw error;
    }
    entry.timer?.unref?.();
    return entry;
  }
  return {
    take(scope, key) {
      const b = scopes.get(scope), k = keyFor(key), entry = b?.entries.get(k);
      if (!entry) return;
      return remove(b, k, now() >= entry.expires);
    },
    park(scope, key, value, roots, dispose) {
      const b = bucket(scope), k = keyFor(key);
      // Same-key replacement must not let an old disposer clear new atoms.
      if (b.entries.has(k)) throw new Error("Transcript already parked");
      if (maxEntries < 1 || ttl <= 0) return false;
      if (!deferEstimate) {
        const bytes = estimateRetainedBytes(roots, maxEntryBytes, { clock: estimateClock, maxTimeMs: maxEstimateMs });
        if (!Number.isFinite(bytes) || bytes > maxBytes) return false;
        while (b.entries.size >= maxEntries || b.bytes + bytes > maxBytes) evictOldest(b);
        insert(b, k, value, bytes, dispose);
        return true;
      }
      // Collect the roots now, while the projection's atoms are still
      // readable, then measure them later in idle slices.
      const list = [];
      for (const root of roots) if (list.push(root) > maxRoots) return false;
      while (b.entries.size >= maxEntries) evictOldest(b);
      const entry = insert(b, k, value, 0, dispose);
      entry.stopEstimate = estimateRetainedBytesLater(list, maxEntryBytes, bytes => {
        entry.stopEstimate = null;
        if (b.entries.get(k) !== entry) return;
        if (!Number.isFinite(bytes) || bytes > maxEntryBytes) { remove(b, k, true); return; }
        entry.bytes = bytes;
        b.bytes += bytes;
        while (b.bytes > maxBytes && b.entries.size) evictOldest(b);
      }, { clock: estimateClock, schedule, cancel });
      return true;
    },
    stats(scope) {
      const b = scopes.get(scope);
      return { entries: b?.entries.size ?? 0, bytes: b?.bytes ?? 0 };
    },
  };
}

// Keep the last eight threads you left ready for ten minutes. Long threads are
// measured in idle time, so they stay warm too.
export const transcriptRetention = createTranscriptRetention({
  maxEntries: 8, maxBytes: 128 * 1024 * 1024, maxEntryBytes: 48 * 1024 * 1024,
  ttl: 10 * 60 * 1000, deferEstimate: true,
});

// A full reset must not invalidate every materialized turn if its underlying
// immutable protocol values are unchanged. Changed/removed turns still rebuild.
export function reconcileMaterializedTurns(materialized, snapshot, previous, equal) {
  for (const key of materialized.keys()) {
    const next = snapshot.turnsByKey[key], old = previous(key);
    if (!next || !old || !equal(old.details, next.details) || !equal(old.slots, next.itemSlots) ||
      next.itemSlots.entries.some(({ itemId }) => !equal(old.item(itemId), snapshot.itemsByKey[old.itemKey(itemId)]))) {
      materialized.delete(key);
    }
  }
}
