import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { codexHome } from "./paths.mjs";
import { verifyAppServer } from "./desktop-startup.mjs";

const revision = "desktop-projects-v1";
const quote = name => `"${name.replaceAll('"', '""')}"`;
const exists = file => fs.access(file).then(() => true, () => false);

function tables(db, schema = "main") {
  return new Set(db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type='table'`).all().map(row => row.name));
}
function columns(db, table, schema = "main") {
  return db.prepare(`PRAGMA ${schema}.table_info(${quote(table)})`).all().map(row => row.name);
}
function complete(db) {
  return tables(db).has("codexzero_data_migrations") && !!db.prepare("SELECT 1 FROM codexzero_data_migrations WHERE id=?").get(revision);
}
function copyRows(db, table, where = "") {
  if (!tables(db).has(table) || !tables(db, "original").has(table)) return;
  const source = new Set(columns(db, table, "original"));
  const shared = columns(db, table).filter(column => source.has(column));
  const names = shared.map(quote).join(",");
  db.exec(`INSERT OR IGNORE INTO ${quote(table)} (${names}) SELECT ${names} FROM original.${quote(table)} ${where}`);
}

/** Import logical records only. Never copy another core's schema migration ledger. */
export async function migrateDesktopDatabase(source, target, { kind = "state", backupDirectory, markComplete = true } = {}) {
  if (path.resolve(source) === path.resolve(target) || !await exists(source) || !await exists(target)) return { skipped: true };
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(target);
  try {
    db.exec("PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON");
    if (complete(db)) return { skipped: true };
    // URI read-only attachment includes committed WAL content without touching the source.
    db.prepare("ATTACH DATABASE ? AS original").run(pathToFileURL(source).href + "?mode=ro");
    const available = tables(db, "original");
    if (!available.has(kind === "state" ? "projects" : "thread_items")) return { skipped: true };
    const directory = backupDirectory ?? path.join(path.dirname(target), "migration-backups");
    await fs.mkdir(directory, { recursive: true });
    const backup = path.join(directory, `${path.basename(target)}.${randomUUID()}.bak`);
    db.prepare("VACUUM main INTO ?").run(backup);
    db.exec("BEGIN IMMEDIATE");
    try {
      if (complete(db)) { db.exec("ROLLBACK"); return { skipped: true }; }
      if (kind === "history") {
        for (const table of ["thread_turns", "thread_items", "thread_realtime_items", "thread_history_projection_state"]) copyRows(db, table);
      } else {
        db.exec("CREATE TEMP TABLE project_import_map (source_id TEXT PRIMARY KEY, target_id TEXT NOT NULL, restore INTEGER NOT NULL)");
        const lookup = db.prepare("SELECT project_id FROM main.project_idempotency_keys WHERE key=?");
        const present = db.prepare("SELECT 1 FROM main.projects WHERE id=?");
        const mapping = db.prepare("INSERT INTO project_import_map VALUES (?,?,?)");
        for (const project of db.prepare("SELECT id FROM original.projects").all()) {
          // Mobile projects subsequently imported by Desktop can already have a new ID.
          const targetId = lookup.get(project.id)?.project_id ?? project.id;
          mapping.run(project.id, targetId, present.get(targetId) ? 0 : 1);
        }
        copyRows(db, "projects", "WHERE id IN (SELECT source_id FROM project_import_map WHERE restore=1)");
        copyRows(db, "project_roots", "WHERE project_id IN (SELECT source_id FROM project_import_map WHERE restore=1)");
        copyRows(db, "project_idempotency_keys", "WHERE project_id IN (SELECT id FROM main.projects)");
        copyRows(db, "thread_sections");
        // Backfill normally discovers the same rollouts. Import missing index rows too,
        // after their history has been merged, retaining all newer destination records.
        const shared = columns(db, "threads").filter(name => columns(db, "threads", "original").includes(name));
        const select = shared.map(name => name === "project_id" ? "COALESCE((SELECT target_id FROM project_import_map WHERE source_id=s.project_id),s.project_id)" : `s.${quote(name)}`).join(",");
        db.exec(`INSERT OR IGNORE INTO threads (${shared.map(quote).join(",")}) SELECT ${select} FROM original.threads s`);
        // Only restore assignments for projects absent before the repair. A null
        // membership in an existing destination project may be an intentional edit.
        db.exec(`UPDATE threads SET project_id=(SELECT m.target_id FROM original.threads s JOIN project_import_map m ON m.source_id=s.project_id WHERE s.id=threads.id AND m.restore=1)
          WHERE project_id IS NULL AND EXISTS (SELECT 1 FROM original.threads s JOIN project_import_map m ON m.source_id=s.project_id WHERE s.id=threads.id AND m.restore=1)`);
        for (const table of ["thread_dynamic_tools", "thread_spawn_edges", "thread_attachments"]) copyRows(db, table);
      }
      if (markComplete) {
        db.exec("CREATE TABLE IF NOT EXISTS codexzero_data_migrations (id TEXT PRIMARY KEY, completed_at INTEGER NOT NULL)");
        db.prepare("INSERT INTO codexzero_data_migrations VALUES (?,?)").run(revision, Date.now());
      }
      db.exec("COMMIT");
      return { migrated: true, backup };
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
}

export async function prepareDesktopState(core, environment) {
  const sourceRoot = codexHome(environment), targetRoot = environment.CODEX_SQLITE_HOME;
  if (!targetRoot || path.resolve(sourceRoot) === path.resolve(targetRoot)) return;
  const source = path.join(sourceRoot, "state_5.sqlite"), target = path.join(targetRoot, "state_5.sqlite");
  if (!await exists(source)) return;
  await fs.mkdir(targetRoot, { recursive: true });
  const { DatabaseSync } = await import("node:sqlite");
  let ready = false;
  if (await exists(target)) {
    const db = new DatabaseSync(target, { readOnly: true });
    try { if (complete(db)) return; ready = tables(db).has("projects"); } finally { db.close(); }
  }
  // Let the selected core create its own schema, never transplant SQLx checksums.
  if (!ready) await verifyAppServer(core, environment, { timeoutMs: 30000 });
  const sourceHistory = path.join(sourceRoot, "thread_history_1.sqlite"), targetHistory = path.join(targetRoot, "thread_history_1.sqlite");
  if (await exists(sourceHistory) && !await exists(targetHistory)) {
    // History storage initializes lazily. Seed the index, then read an existing
    // chat to let this core initialize its own history schema without a new chat.
    await migrateDesktopDatabase(source, target, { markComplete: false });
    const db = new DatabaseSync(target, { readOnly: true });
    let thread;
    try { thread = db.prepare("SELECT id FROM threads WHERE history_mode='paginated' ORDER BY updated_at DESC LIMIT 1").get(); }
    finally { db.close(); }
    if (thread) await verifyAppServer(core, environment, { timeoutMs: 30000,
      request: { method: "thread/turns/list", params: { threadId: thread.id, limit: 1, itemsView: "summary" } } });
    if (!await exists(targetHistory)) throw new Error("Desktop history storage was not initialized");
  }
  await migrateDesktopDatabase(sourceHistory, targetHistory, { kind: "history" });
  await migrateDesktopDatabase(source, target);
}
