import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { migrateDesktopDatabase, prepareDesktopState } from '../src/desktop-state-migration.mjs';
import { verifyAppServer } from '../src/desktop-startup.mjs';

const stateSchema = `
 CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
 CREATE TABLE project_roots (project_id TEXT REFERENCES projects(id), root TEXT, PRIMARY KEY(project_id,root));
 CREATE TABLE project_idempotency_keys (key TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id));
 CREATE TABLE thread_sections (id TEXT PRIMARY KEY, name TEXT);
 CREATE TABLE threads (id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id), title TEXT);
 CREATE TABLE _sqlx_migrations (version INTEGER PRIMARY KEY, checksum TEXT);
 INSERT INTO _sqlx_migrations VALUES (1,'destination-schema');
`;
const historySchema = `
 CREATE TABLE thread_turns (id TEXT PRIMARY KEY, text TEXT);
 CREATE TABLE thread_items (id TEXT PRIMARY KEY, turn_id TEXT REFERENCES thread_turns(id), text TEXT);
 CREATE TABLE thread_realtime_items (id TEXT PRIMARY KEY, text TEXT);
 CREATE TABLE thread_history_projection_state (id TEXT PRIMARY KEY, state TEXT);
 CREATE TABLE _sqlx_migrations (version INTEGER PRIMARY KEY, checksum TEXT);
 INSERT INTO _sqlx_migrations VALUES (1,'destination-schema');
`;
async function fixture(t, schema = stateSchema) {
 const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cz-state-migration-'));
 t.after(() => fs.rm(root, { recursive: true, force: true }));
 const source = path.join(root, 'source.sqlite'), target = path.join(root, 'target.sqlite');
 for (const file of [source,target]) {
   const db = new DatabaseSync(file);
   db.exec(schema);
   db.close();
 }
 return { root, source, target };
}
function sql(file, query) {
 const db = new DatabaseSync(file);
 try { db.exec(query); } finally { db.close(); }
}
function rows(file, query) {
 const db = new DatabaseSync(file, { readOnly:true });
 try { return db.prepare(query).all().map(row => ({...row})); } finally { db.close(); }
}

test('logical repair preserves existing edits, roots and mapped mobile identities and leaves source unchanged', async t => {
 const { source,target } = await fixture(t);
 sql(source, `UPDATE _sqlx_migrations SET checksum='source-schema';
   INSERT INTO projects VALUES ('lost','Lost'),('existing','Old name'),('mobile','Mobile');
   INSERT INTO project_roots VALUES ('lost','C:/lost'),('existing','C:/old'),('mobile','C:/mobile');
   INSERT INTO project_idempotency_keys VALUES ('lost','lost'),('existing','existing');
   INSERT INTO thread_sections VALUES ('section','Work');
   INSERT INTO threads VALUES ('missing','lost','Missing'),('backfilled','lost','Old backfill'),('edited','existing','Old title'),('unassigned','existing','Old unassigned'),('mobile-thread','mobile','Mobile thread');`);
 sql(target, `INSERT INTO projects VALUES ('existing','New name'),('desktop-mobile','Imported mobile');
   INSERT INTO project_roots VALUES ('existing','C:/new'),('desktop-mobile','C:/edited-mobile');
   INSERT INTO project_idempotency_keys VALUES ('mobile','desktop-mobile');
   INSERT INTO threads VALUES ('backfilled',NULL,'New backfill'),('edited','desktop-mobile','New title'),('unassigned',NULL,'New unassigned');`);
 const original = await fs.readFile(source);
 const result = await migrateDesktopDatabase(source,target);
 assert.equal(result.migrated,true);
 assert.deepEqual(await fs.readFile(source),original);
 assert.deepEqual(rows(target,'SELECT * FROM projects ORDER BY id'),[
   {id:'desktop-mobile',name:'Imported mobile'},{id:'existing',name:'New name'},{id:'lost',name:'Lost'}]);
 assert.deepEqual(rows(target,'SELECT * FROM project_roots ORDER BY project_id'),[
   {project_id:'desktop-mobile',root:'C:/edited-mobile'},{project_id:'existing',root:'C:/new'},{project_id:'lost',root:'C:/lost'}]);
 assert.deepEqual(rows(target,'SELECT * FROM threads ORDER BY id'),[
   {id:'backfilled',project_id:'lost',title:'New backfill'},
   {id:'edited',project_id:'desktop-mobile',title:'New title'},
   {id:'missing',project_id:'lost',title:'Missing'},
   {id:'mobile-thread',project_id:'desktop-mobile',title:'Mobile thread'},
   {id:'unassigned',project_id:null,title:'New unassigned'}]);
 assert.deepEqual(rows(target,'SELECT * FROM _sqlx_migrations'),[{version:1,checksum:'destination-schema'}]);
 assert.deepEqual(rows(result.backup,'SELECT id FROM projects ORDER BY id'),[{id:'desktop-mobile'},{id:'existing'}]);
 assert.equal(rows(result.backup,"SELECT name FROM sqlite_master WHERE name='codexzero_data_migrations'").length,0);
 assert.equal((await migrateDesktopDatabase(source,target)).skipped,true);
 assert.equal(rows(target,'SELECT * FROM codexzero_data_migrations').length,1);
});

test('foreign key failure rolls back every imported record and never marks completion', async t => {
 const { source,target,root } = await fixture(t);
 sql(source,"PRAGMA foreign_keys=OFF; INSERT INTO projects VALUES ('lost','Lost'); INSERT INTO threads VALUES ('orphan','absent','Orphan');");
 await assert.rejects(migrateDesktopDatabase(source,target), /FOREIGN KEY/);
 assert.deepEqual(rows(target,'SELECT * FROM projects'),[]);
 assert.deepEqual(rows(target,'SELECT * FROM threads'),[]);
 assert.equal(rows(target,"SELECT name FROM sqlite_master WHERE name='codexzero_data_migrations'").length,0);
 assert.equal((await fs.readdir(path.join(root,'migration-backups'))).length,1);
});

test('read-only source attachment includes committed WAL records without changing database or WAL', async t => {
 const { source,target } = await fixture(t);
 const writer = new DatabaseSync(source);
 writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; INSERT INTO projects VALUES ('wal','WAL project'); INSERT INTO project_roots VALUES ('wal','C:/wal');");
 try {
   const dbBytes=await fs.readFile(source), walBytes=await fs.readFile(`${source}-wal`);
   await migrateDesktopDatabase(source,target);
   assert.deepEqual(rows(target,'SELECT * FROM projects'),[{id:'wal',name:'WAL project'}]);
   assert.deepEqual(await fs.readFile(source),dbBytes);
   assert.deepEqual(await fs.readFile(`${source}-wal`),walBytes);
 } finally { writer.close(); }
});

test('history merges missing rows, retains destination edits and its schema ledger', async t => {
 const { source,target } = await fixture(t,historySchema);
 sql(source,`UPDATE _sqlx_migrations SET checksum='source-schema';
   INSERT INTO thread_turns VALUES ('existing','Old'),('missing','Missing');
   INSERT INTO thread_items VALUES ('existing','existing','Old'),('missing','missing','Missing');
   INSERT INTO thread_realtime_items VALUES ('missing','Realtime');
   INSERT INTO thread_history_projection_state VALUES ('missing','Ready'),('existing','Old checkpoint');`);
 sql(target,"INSERT INTO thread_turns VALUES ('existing','Edited'); INSERT INTO thread_items VALUES ('existing','existing','Edited'); INSERT INTO thread_history_projection_state VALUES ('existing','New checkpoint');");
 const result=await migrateDesktopDatabase(source,target,{kind:'history'});
 assert.equal(result.migrated,true);
 assert.deepEqual(rows(target,'SELECT * FROM thread_items ORDER BY id'),[{id:'existing',turn_id:'existing',text:'Edited'},{id:'missing',turn_id:'missing',text:'Missing'}]);
 assert.equal(rows(target,'SELECT * FROM thread_realtime_items').length,1);
 assert.deepEqual(rows(target,'SELECT * FROM thread_history_projection_state ORDER BY id'),[{id:'existing',state:'New checkpoint'},{id:'missing',state:'Ready'}]);
 assert.deepEqual(rows(target,'SELECT * FROM _sqlx_migrations'),[{version:1,checksum:'destination-schema'}]);
 assert.equal((await migrateDesktopDatabase(source,target,{kind:'history'})).skipped,true);
});

test('concurrent repeat imports commit exactly once', async t => {
 const { source,target } = await fixture(t);
 sql(source,"INSERT INTO projects VALUES ('lost','Lost');");
 const results = await Promise.all([migrateDesktopDatabase(source,target),migrateDesktopDatabase(source,target)]);
 assert.equal(results.filter(result=>result.migrated).length,1);
 assert.equal(results.filter(result=>result.skipped).length,1);
 assert.equal(rows(target,'SELECT * FROM projects').length,1);
 assert.equal(rows(target,'SELECT * FROM codexzero_data_migrations').length,1);
});

test('bootstrap seed remains retryable without a completion marker', async t => {
 const {source,target}=await fixture(t);
 sql(source,"INSERT INTO projects VALUES ('lost','Lost'); INSERT INTO threads VALUES ('missing','lost','Missing');");
 assert.equal((await migrateDesktopDatabase(source,target,{markComplete:false})).migrated,true);
 assert.equal(rows(target,"SELECT name FROM sqlite_master WHERE name='codexzero_data_migrations'").length,0);
 assert.equal((await migrateDesktopDatabase(source,target,{markComplete:false})).migrated,true);
 assert.equal(rows(target,'SELECT * FROM threads').length,1);
 assert.equal((await migrateDesktopDatabase(source,target)).migrated,true);
 assert.equal(rows(target,'SELECT * FROM codexzero_data_migrations').length,1);
});

test('uninitialized source history cannot produce a completed state marker', async t => {
 const {root,source,target}=await fixture(t);
 for(const file of [source,target]) sql(file,"ALTER TABLE threads ADD COLUMN history_mode TEXT DEFAULT 'legacy'; ALTER TABLE threads ADD COLUMN updated_at INTEGER DEFAULT 0;");
 const home=path.join(root,'home'),destination=path.join(root,'destination');
 await fs.mkdir(home);await fs.mkdir(destination);
 await fs.copyFile(source,path.join(home,'state_5.sqlite'));
 await fs.copyFile(target,path.join(destination,'state_5.sqlite'));
 const history=new DatabaseSync(path.join(home,'thread_history_1.sqlite'));
 try{history.exec(historySchema);}finally{history.close();}
 await assert.rejects(prepareDesktopState('unused-core',{CODEX_HOME:home,CODEX_SQLITE_HOME:destination}),/history storage was not initialized/);
 assert.equal(rows(path.join(destination,'state_5.sqlite'),"SELECT name FROM sqlite_master WHERE name='codexzero_data_migrations'").length,0);
});

test('selected core initializes paginated history before completing fresh desktop migration', {
 skip: !process.env.CODEXZERO_TEST_CORE, timeout:90000
}, async t => {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'cz-real-state-migration-'));
 t.after(async()=>{
   assert.equal(path.dirname(root),os.tmpdir());
   assert.ok(path.basename(root).startsWith('cz-real-state-migration-'));
   await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
 });
 const home=path.join(root,'home'),target=path.join(root,'target');
 await fs.mkdir(home);await fs.mkdir(target);
 await fs.writeFile(path.join(home,'config.toml'),'[analytics]\nenabled=false\n[skills.bundled]\nenabled=false\n[features]\nplugins=false\n');
 const id=randomUUID(),timestamp='2025-01-01T10:00:00Z';
 const dir=path.join(home,'sessions','2025','01','01');await fs.mkdir(dir,{recursive:true});
 const rollout=path.join(dir,`rollout-2025-01-01T10-00-00-${id}.jsonl`);
 await fs.writeFile(rollout,[
   {timestamp,type:'session_meta',payload:{id,session_id:id,timestamp,cwd:home,originator:'migration-fixture',cli_version:'0.0.0',source:'cli',model_provider:'openai',history_mode:'paginated'}},
   {timestamp,type:'event_msg',payload:{type:'user_message',message:'Synthetic migration',kind:'plain'}}
 ].map(row=>JSON.stringify(row)).join('\n')+'\n');
 const environment={HOME:root,USERPROFILE:root,APPDATA:path.join(root,'appdata'),LOCALAPPDATA:path.join(root,'localappdata'),TMP:root,TEMP:root,CODEX_HOME:home,CODEX_SQLITE_HOME:home,CODEX_ZERO_SQLITE_HOME:home,CODEX_ZERO_CORE_UPDATES:'0',RUST_LOG:'error'};
 for(const key of ['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','PROCESSOR_ARCHITECTURE']) if(process.env[key]!=null)environment[key]=process.env[key];
 const core=process.env.CODEXZERO_TEST_CORE;
 await verifyAppServer(core,environment,{request:{method:'thread/list',params:{archived:false,limit:100,modelProviders:[],useStateDbOnly:false}}});
 await verifyAppServer(core,environment,{request:{method:'thread/turns/list',params:{threadId:id,limit:1,itemsView:'summary'}}});
 await fs.access(path.join(home,'thread_history_1.sqlite'));
 await prepareDesktopState(core,{...environment,CODEX_SQLITE_HOME:target,CODEX_ZERO_SQLITE_HOME:target});
 await fs.access(path.join(target,'thread_history_1.sqlite'));
 assert.equal(rows(path.join(target,'state_5.sqlite'),'SELECT * FROM codexzero_data_migrations').length,1);
 assert.equal(rows(path.join(target,'thread_history_1.sqlite'),'SELECT * FROM codexzero_data_migrations').length,1);
});
