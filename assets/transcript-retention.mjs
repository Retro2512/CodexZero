// Dormant data only. Callers must unsubscribe before parking and validate a
// fresh authoritative reset before exposing retained data to the UI.
export function estimateRetainedBytes(roots, limit = 8 * 1024 * 1024,
  { clock = () => performance.now(), maxTimeMs = 3 } = {}) {
  if (maxTimeMs <= 0) return Infinity;
  const deadline = clock() + maxTimeMs;
  const seen = new WeakSet();
  let bytes = 0, visited = 0, scanned = 0;
  const stack = [];
  for (const root of roots) {
    stack.push(root);
    while (stack.length) {
      const value = stack.pop();
      if (++visited > 10000) return Infinity;
      if ((visited & 7) === 0 && clock() > deadline) return Infinity;
      if (typeof value === "string") bytes += 32 + value.length * 2;
      else if (value && typeof value === "object") {
        if (seen.has(value)) continue;
        seen.add(value);
        // Reject host objects, accessors and collections. Projection roots are
        // protocol data; retaining anything else must fall back to disposal.
        const prototype = Object.getPrototypeOf(value);
        if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return Infinity;
        bytes += 256;
        // Enumerate incrementally so a wide object can stop at the deadline.
        for (const key in value) {
          if ((++scanned & 7) === 0 && clock() > deadline) return Infinity;
          if (!Object.hasOwn(value, key)) continue;
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (!descriptor || !("value" in descriptor)) return Infinity;
          bytes += 64 + key.length * 2;
          stack.push(descriptor.value);
          if (stack.length + visited > 10000) return Infinity;
        }
      } else if (typeof value === "function" || typeof value === "symbol") return Infinity;
      else bytes += 16;
      if (bytes > limit) return Infinity;
    }
  }
  return clock() > deadline ? Infinity : bytes;
}

export function createTranscriptRetention({ maxEntries = 3, maxBytes = 8 * 1024 * 1024,
  ttl = 30000, now = () => Date.now(), estimateClock = () => performance.now(),
  maxEstimateMs = 3, schedule = setTimeout, cancel = clearTimeout } = {}) {
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
    if (dispose) entry.dispose();
    return dispose ? undefined : entry.value;
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
       const bytes = estimateRetainedBytes(roots, maxBytes, { clock: estimateClock, maxTimeMs: maxEstimateMs });
      if (!Number.isFinite(bytes) || bytes > maxBytes || maxEntries < 1 || ttl <= 0) return false;
      while (b.entries.size >= maxEntries || b.bytes + bytes > maxBytes) {
        remove(b, b.entries.keys().next().value, true);
      }
      const entry = { value, bytes, dispose, expires: now() + ttl, timer: null };
      b.entries.set(k, entry);
      b.bytes += bytes;
      try {
        entry.timer = schedule(() => { if (b.entries.get(k) === entry) remove(b, k, true); }, ttl);
      } catch (error) {
        remove(b, k, false);
        throw error;
      }
      entry.timer?.unref?.();
      return true;
    },
    stats(scope) {
      const b = scopes.get(scope);
      return { entries: b?.entries.size ?? 0, bytes: b?.bytes ?? 0 };
    },
  };
}

export const transcriptRetention = createTranscriptRetention();

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
