#!/usr/bin/env node
// Run ONLY inside a disposable image with a new empty /data volume; never production.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openSettingsDatabase, setSettingsMeta } from '../src/settings-database.mjs';
import { ContinuityHandoffStore } from '../src/continuity-handoff-store.mjs';
import { preparePostgresStartup } from '../src/postgres-startup.mjs';
import { createPostgresPool, postgresConfig } from '../src/postgres-foundation.mjs';

if (process.env.BURROW_POSTGRES_STARTUP_REHEARSAL !== '1' || process.env.BURROW_RUNTIME_ROOT !== '/data') throw new Error('disposable_rehearsal_opt_in_required');
assert.deepEqual(await fs.readdir('/data'), [], 'requires an empty disposable volume');
await fs.mkdir('/data/config');
const key = Buffer.alloc(32, 7).toString('base64');
await fs.writeFile('/data/config/settings.key', key, { mode: 0o600 });
const at = '2026-01-01T00:00:00Z';
const agentIds = Array.from({ length: 16 }, (_, i) => `sample-${String(i + 1).padStart(2, '0')}`);
const expectedHandoffs = new Map();
const sourcePaths = ['/data/config/settings.sqlite', '/data/config/settings.key', '/data/forge.sqlite'];
const expectedForge = [];

// Exercise both a standalone root Forge database and Forge embedded in settings.
function seedForge(db, id, mode) {
  db.exec(`CREATE TABLE IF NOT EXISTS forge_jobs (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, idem TEXT NOT NULL, request TEXT NOT NULL, record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS forge_selections (mode TEXT PRIMARY KEY, connection_id TEXT NOT NULL, model_id TEXT NOT NULL, updated_at TEXT NOT NULL);`);
  const request = { prompt: `Disposable ${id}`, mode };
  const record = { id, status: 'succeeded', artifacts: [], createdAt: at, updatedAt: at };
  db.prepare('INSERT INTO forge_jobs VALUES(?,?,?,?,?)').run(id, '__operator__', id, JSON.stringify(request), JSON.stringify(record));
  db.prepare('INSERT INTO forge_selections VALUES(?,?,?,?)').run(mode, 'rehearsal-connection', `rehearsal-${mode}`, at);
  expectedForge.push({ id, request, record, mode });
}

const db = openSettingsDatabase({ databasePath: '/data/config/settings.sqlite' });
try {
  for (const agentId of agentIds) {
    db.prepare('INSERT INTO agents(id,name,enabled,available_capabilities,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(agentId, agentId, 1, '[]', at, at);
  }
  setSettingsMeta(db, 'model_auth_preview:6c9c7b1a-c485-48d1-ae14-39fa2477ba36', { type: 'oauth', label: 'deleted connection' });
  seedForge(db, 'embedded-forge', 'speech');
} finally { db.close(); }
const forge = new DatabaseSync('/data/forge.sqlite');
try { seedForge(forge, 'root-forge', 'image'); } finally { forge.close(); }

for (const agentId of agentIds) {
  const home = `/data/workspace/${agentId}`;
  const continuity = new ContinuityHandoffStore({ dataRoot: home });
  try {
    // More than the store's five-item read limit: migration must preserve all rows.
    for (let i = 1; i <= 16; i++) {
      const handoff = continuity.upsert({
        id: `continuity:${agentId}:handoff-${i}`, agentId,
        sessionId: `session-${i}`, runId: `run-${i}`,
        source: i % 2 ? 'explicit' : 'runtime',
        title: `${agentId} handoff ${i}`, content: `Preserve ${agentId} handoff ${i}`,
        sourceRefs: [`session:session-${i}`, `run:run-${i}`],
        evidenceSummary: 'Disposable rehearsal continuity fixture', ttlDays: 365,
      });
      expectedHandoffs.set(handoff.id, handoff);
    }
  } finally { continuity.close(); }
  sourcePaths.push(`${home}/continuity-handoffs.sqlite`);
}

const sessionRoot = `/data/workspace/${agentIds[0]}/sessions/default`;
await fs.mkdir(sessionRoot, { recursive: true });
const meta = `${sessionRoot}/session.meta.json`;
await fs.writeFile(meta, JSON.stringify({ createdAt: at }));
const file = `${sessionRoot}/session.jsonl`;
await fs.writeFile(file, JSON.stringify({ id: 'seed', ts: at, role: 'user', content: 'Disposable legacy sample', metadata: { attachments: [{ artifactPath: 'artifacts/sample.png' }] } }) + '\n');
sourcePaths.push(meta, file);
const sources = new Map(await Promise.all(sourcePaths.map(async source => [source, await fs.readFile(source)])));
async function assertSourcesUnchanged() {
  for (const [source, bytes] of sources) assert.deepEqual(await fs.readFile(source), bytes, `source changed: ${source}`);
}
async function assertImported(pool) {
  assert.equal((await pool.query('SELECT count(*) FROM model_auth_previews')).rows[0].count, '0');
  assert.deepEqual((await pool.query("SELECT value_json FROM settings_meta WHERE key='model_auth_preview:6c9c7b1a-c485-48d1-ae14-39fa2477ba36'")).rows[0].value_json, JSON.stringify({ type: 'oauth', label: 'deleted connection' }));
  assert.deepEqual((await pool.query('SELECT id FROM agents ORDER BY id')).rows.map(row => row.id), agentIds);
  const entries = (await pool.query('SELECT entry FROM conversation_entries')).rows;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].entry.content, 'Disposable legacy sample');
  const handoffs = (await pool.query('SELECT * FROM continuity_handoffs')).rows;
  assert.equal(handoffs.length, 16 * 16);
  for (const agentId of agentIds) assert.equal(handoffs.filter(row => row.agent_id === agentId).length, 16, `${agentId}: all 16 handoffs preserved`);
  for (const row of handoffs) {
    const expected = expectedHandoffs.get(row.id);
    assert.ok(expected, `unexpected handoff: ${row.id}`);
    assert.deepEqual({
      agentId: row.agent_id, sessionId: row.session_id, runId: row.run_id,
      source: row.source, title: row.title, content: row.content,
      sourceRefs: row.source_refs, evidenceSummary: row.evidence_summary,
      createdAt: new Date(row.created_at).toISOString(), updatedAt: new Date(row.updated_at).toISOString(),
      expiresAt: new Date(row.expires_at).toISOString(),
    }, {
      agentId: expected.agentId, sessionId: expected.sessionId, runId: expected.runId,
      source: expected.source, title: expected.title, content: expected.content,
      sourceRefs: expected.sourceRefs, evidenceSummary: expected.evidenceSummary,
      createdAt: expected.createdAt, updatedAt: expected.updatedAt, expiresAt: expected.expiresAt,
    });
  }
  const jobs = (await pool.query('SELECT * FROM forge_jobs')).rows;
  const selections = (await pool.query('SELECT * FROM forge_selections')).rows;
  assert.equal(jobs.length, 2);
  assert.equal(selections.length, 2);
  for (const expected of expectedForge) {
    const job = jobs.find(row => row.id === expected.id);
    assert.ok(job, `missing Forge job: ${expected.id}`);
    assert.equal(job.agent_id, '__operator__');
    assert.equal(job.idem, expected.id);
    assert.deepEqual(job.request, expected.request);
    assert.deepEqual(job.record, expected.record);
    const selection = selections.find(row => row.mode === expected.mode);
    assert.ok(selection, `missing Forge selection: ${expected.mode}`);
    assert.equal(selection.connection_id, 'rehearsal-connection');
    assert.equal(selection.model_id, `rehearsal-${expected.mode}`);
    assert.equal(new Date(selection.updated_at).getTime(), Date.parse(at));
  }
}

assert.equal(process.env.BURROW_POSTGRES_LIFECYCLE, 'managed', 'image must default to managed');
const env = { ...process.env };
let handle = await preparePostgresStartup({ env });
let pool = createPostgresPool({ config: postgresConfig(handle.env) });
await assertImported(pool);
await assertSourcesUnchanged();
await pool.end();
await handle.close();
handle = await preparePostgresStartup({ env });
assert.equal(handle.result.repeated, true);
pool = createPostgresPool({ config: postgresConfig(handle.env) });
await assertImported(pool);
await assertSourcesUnchanged();
const pgEnv = { ...process.env, PGHOST: handle.env.BURROW_POSTGRES_HOST, PGUSER: handle.env.BURROW_POSTGRES_USER, PGDATABASE: 'postgres' };
execFileSync('pg_dump', ['-Fc', '-f', '/data/rehearsal.dump'], { env: pgEnv });
execFileSync('createdb', ['rehearsal_restore'], { env: pgEnv });
execFileSync('pg_restore', ['--exit-on-error', '-d', 'rehearsal_restore', '/data/rehearsal.dump'], { env: pgEnv });
const restored = createPostgresPool({ config: { ...postgresConfig(handle.env), database: 'rehearsal_restore' } });
await assertImported(restored);
assert.equal((await restored.query('SELECT count(*) FROM burrow_migration_receipts')).rows[0].count, '1');
await restored.end();
await pool.end();
await handle.close();
await assertSourcesUnchanged();
assert.equal(await fs.readFile('/data/config/settings.key', 'utf8'), key);
// A committed receipt ends legacy authority: drift, unknown directories, and
// removed settings/conversation/auxiliary sources must not affect startup.
async function assertReceiptRestart() {
  const restarted = await preparePostgresStartup({ env });
  const current = createPostgresPool({ config: postgresConfig(restarted.env) });
  try {
    assert.equal(restarted.result.repeated, true);
    await assertImported(current);
  } finally { await current.end(); await restarted.close(); }
}
await fs.appendFile(file, 'invalid legacy drift\n');
await assertReceiptRestart();
await fs.mkdir('/data/workspace/new-unknown-agent/sessions', { recursive: true });
await assertReceiptRestart();
for (const source of sources.keys()) {
  if (!source.endsWith('settings.key')) await fs.rm(source);
}
await assertReceiptRestart();
assert.equal(await fs.readFile('/data/config/settings.key', 'utf8'), key);
console.log('PASS: managed startup, 16 agents with 16 handoffs each, root/embedded Forge, settings/conversation migration, pg_dump/restore, source/key preservation before cutover, receipt authority after drift/unknown agents/removal');
