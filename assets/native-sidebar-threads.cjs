"use strict";

const indexed = new WeakSet();
const FULL_SCAN_INTERVAL = 5 * 60 * 1000;
const POLL_INTERVAL = 30_500;

// Keep the original cwd in every returned record. Only lookup keys are folded.
function pathKey(value) {
  let path = String(value ?? "").replaceAll("\\", "/");
  if (/^\/\/\?\/UNC\//i.test(path)) path = "//" + path.slice(8);
  else if (path.startsWith("//?/")) path = path.slice(4);
  if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
  if (/^[a-z]:($|\/)/i.test(path)) path = "/mnt/" + path[0] + path.slice(2);
  // SQLite lower() folds ASCII only. Keep non ASCII characters identical on
  // both sides so even an unchanged accented folder name remains queryable.
  if (/^\/mnt\/[a-z]($|\/)/i.test(path) || path.startsWith("//")) path = path.replace(/[A-Z]/g, letter => letter.toLowerCase());
  return path === "/" ? path : path.replace(/\/+$/, "");
}

// SQLite expression indexes retain indexed exact and subtree lookups. POSIX
// paths remain case sensitive, including two folders that differ only in case.
function pathSql(column = "cwd") {
  const slash = `replace(coalesce(${column}, ''), char(92), '/')`;
  const plain = `(CASE WHEN lower(substr(${slash}, 1, 8)) = '//?/unc/' THEN '//' || substr(${slash}, 9) WHEN substr(${slash}, 1, 4) = '//?/' THEN substr(${slash}, 5) ELSE ${slash} END)`;
  const drive = `(CASE WHEN ${plain} GLOB '/[a-zA-Z]:/*' THEN substr(${plain}, 2) ELSE ${plain} END)`;
  const folded = `(CASE WHEN ${drive} GLOB '[a-zA-Z]:' OR ${drive} GLOB '[a-zA-Z]:/*' THEN lower('/mnt/' || substr(${drive}, 1, 1) || substr(${drive}, 3)) WHEN ${drive} GLOB '/mnt/[a-zA-Z]' OR ${drive} GLOB '/mnt/[a-zA-Z]/*' OR substr(${drive}, 1, 2) = '//' THEN lower(${drive}) ELSE ${drive} END)`;
  return `(CASE WHEN ${folded} = '/' THEN '/' ELSE rtrim(${folded}, '/') END)`;
}

function ensurePathIndexes(db) {
  if (indexed.has(db)) return;
  for (const [name, order] of [
    ["cz_thread_catalog_path_recent_idx", "source_recency_at DESC, source_created_at DESC"],
    ["cz_thread_catalog_path_created_idx", "source_created_at DESC, source_updated_at DESC"],
  ]) db.prepare(`CREATE INDEX IF NOT EXISTS ${name} ON local_thread_catalog (host_id, ${pathSql()}, ${order}, thread_id) WHERE missing_candidate = 0`).run();
  indexed.add(db);
}

function pathValues(values) { return values.map(pathKey); }
function findPathGroup(groups, key) {
  for (;;) {
    const group = groups.get(key);
    if (group != null) return group;
    if (!key || key === "/") return null;
    const separator = key.lastIndexOf("/");
    if (separator < 0) return null;
    key = separator === 0 ? "/" : key.slice(0, separator);
  }
}
function pathPrefixes(values) {
  if (values.some(value => typeof value !== "string" || !value.length)) throw new Error("Empty thread catalog path prefix");
  const prefixes = [...new Set(values.map(value => pathKey(value).replace(/\/$/, "") + "/"))].sort();
  return prefixes.filter((prefix, index) => !prefixes.slice(0, index).some(parent => prefix.startsWith(parent)));
}

function needsFullScan(state, hostKind, now) {
  return !state.isComplete || state.lastFullReconciliationAt == null ||
    (hostKind !== "chatgpt" && now - state.lastFullReconciliationAt >= FULL_SCAN_INTERVAL);
}

function setPolling(coordinator, enabled) {
  clearInterval(coordinator.czCatalogPoll);
  coordinator.czCatalogPoll = null;
  if (!enabled || coordinator.store.hostKind === "chatgpt") return;
  coordinator.czCatalogPoll = setInterval(() => {
    if (!coordinator.disposed && coordinator.syncEnabled) {
      coordinator.requestSync().catch(error => coordinator.options.onError?.(error));
    }
  }, POLL_INTERVAL);
  coordinator.czCatalogPoll.unref?.();
}

function refreshActivity(coordinator, threadId) {
  if (threadId == null) return;
  if (coordinator.pendingThreadRefreshes.has(threadId)) {
    coordinator.dirtyThreadRefreshes.add(threadId);
    return;
  }
  const refresh = Symbol();
  coordinator.pendingThreadRefreshes.set(threadId, refresh);
  void coordinator.refreshThread(threadId, refresh, "interactive");
}

function applyObservation(conversation, thread) {
  const updatedAt = thread.updatedAt * 1000;
  const recencyAt = (thread.recencyAt ?? thread.updatedAt) * 1000;
  if (Number.isFinite(updatedAt) && updatedAt >= conversation.updatedAt) {
    conversation.cwd = thread.cwd ?? conversation.cwd;
    conversation.updatedAt = updatedAt;
  }
  if (Number.isFinite(recencyAt)) conversation.recencyAt = Math.max(conversation.recencyAt ?? conversation.updatedAt ?? 0, recencyAt);
}

// Title reconciliation can select the cached wire thread even when a fresh
// observation has the same updatedAt. Recency is independently updated by Core.
function observedActivity(selected, observed) {
  const cwd = observed.updatedAt >= selected.updatedAt ? observed.cwd ?? selected.cwd : selected.cwd;
  const updatedAt = Math.max(selected.updatedAt, observed.updatedAt);
  const recencyAt = Math.max(selected.recencyAt ?? selected.updatedAt, observed.recencyAt ?? observed.updatedAt);
  return selected.cwd === cwd && selected.updatedAt === updatedAt && selected.recencyAt === recencyAt
    ? selected : { ...selected, cwd, updatedAt, recencyAt };
}

// Merge independent sorted streams, not pages at a shared cursor.
// Filesystem discovery repairs missing SQLite rows but must never replace or
// truncate the authoritative database history. Local cursors are not persisted.
function createListing(listThreads, hostId, sourceKinds) {
  let sequence = 0;
  const scans = new Map();
  // An empty source filter means interactive sources, not all sources. Keep
  // its custom chat sources and add app-server tasks as a separate stream.
  const kinds = sourceKinds.length ? [sourceKinds] : [sourceKinds, ["appServer"]];
  return async function listPage({ cursor, limit }, options) {
    let scan;
    if (cursor == null) {
      // The host coordinator serializes scans. Failed or cancelled scans need
      // no cursor state after the next attempt starts.
      scans.clear();
      scan = { streams: kinds.flatMap(sourceKinds => (hostId === "local" ? [true, false] : [true]).map(dbOnly => ({ dbOnly, sourceKinds, buffer: [], cursor: null, done: false, cursors: new Set() }))), seen: new Set() };
    } else {
      scan = scans.get(cursor);
      if (!scan) throw new Error("Expired thread catalog cursor");
      scans.delete(cursor);
    }
    async function fill(stream) {
      while (!stream.buffer.length && !stream.done) {
        options?.signal?.throwIfAborted();
        const page = await listThreads({ archived: false, cursor: stream.cursor, limit,
          modelProviders: [], parentThreadId: null, sortKey: "updated_at",
          sortDirection: "desc", sourceKinds: stream.sourceKinds, useStateDbOnly: stream.dbOnly }, options);
        stream.buffer = [...page.data];
        if (page.nextCursor != null && stream.cursors.has(page.nextCursor)) throw new Error("Repeated thread list cursor");
        stream.done = page.nextCursor == null;
        stream.cursor = page.nextCursor;
        if (stream.cursor != null) stream.cursors.add(stream.cursor);
      }
    }
    const data = [];
    while (data.length < limit) {
      await Promise.all(scan.streams.map(fill));
      const candidates = scan.streams.filter(stream => stream.buffer.length);
      if (!candidates.length) break;
      candidates.sort((a, b) => b.buffer[0].updatedAt - a.buffer[0].updatedAt || a.buffer[0].id.localeCompare(b.buffer[0].id));
      const thread = candidates[0].buffer.shift();
      if (scan.seen.has(thread.id)) continue;
      scan.seen.add(thread.id);
      data.push(thread);
    }
    const hasMore = scan.streams.some(stream => stream.buffer.length || !stream.done);
    const nextCursor = hasMore ? `cz_catalog_${++sequence}` : null;
    if (nextCursor != null) scans.set(nextCursor, scan);
    return { data, nextCursor };
  };
}

function mirrorProject(backend, project, localKey) {
  if (localKey !== project.id || backend.cache.getProjects()[localKey] != null ||
      (backend.migrationIdentity != null && backend.pendingDeletions.get(backend.migrationIdentity, localKey) != null)) return;
  const roots = project.roots?.map(root => root.path).filter(path => typeof path === "string" && path.length);
  if (!roots?.length || typeof project.name !== "string") return;
  backend.cache.writeProject("project/create", { id: localKey, name: project.name, rootPaths: roots,
    createdAt: project.createdAt * 1000 || Date.now(), updatedAt: project.updatedAt * 1000 || Date.now() });
  backend.czProjectChanged?.();
}

async function refreshUnknownProject(backend, projectId, signal) {
  if (projectId == null || backend.legacyProjectIdsByServerId.has(projectId)) return;
  backend.czProjectRefresh ??= backend.listProjects(signal).then(projects => {
    signal.throwIfAborted();
    for (const project of projects) backend.storeProject(project);
  }).finally(() => { backend.czProjectRefresh = null; });
  await backend.czProjectRefresh;
  signal.throwIfAborted();
}

module.exports = { pathKey, pathSql, pathValues, pathPrefixes, findPathGroup, ensurePathIndexes,
  needsFullScan, setPolling, refreshActivity, applyObservation, observedActivity, createListing, mirrorProject, refreshUnknownProject };
