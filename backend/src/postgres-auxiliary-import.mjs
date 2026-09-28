import { DatabaseSync } from 'node:sqlite';
import { isDeepStrictEqual } from 'node:util';
import { withPostgresTransaction } from './postgres-foundation.mjs';

const FORGE_JOB_COLUMNS = ['id', 'agent_id', 'idem', 'owner_id', 'owner_token', 'request', 'record', 'created_at', 'updated_at'];
const FORGE_SOURCE_COLUMNS = ['id', 'agent_id', 'idem', 'request', 'record'];
const FORGE_SELECTION_COLUMNS = ['mode', 'connection_id', 'model_id', 'updated_at'];
const HANDOFF_COLUMNS = ['id', 'agent_id', 'session_id', 'run_id', 'source', 'title', 'content', 'source_refs', 'evidence_summary', 'created_at', 'updated_at', 'expires_at'];
const SOURCE_TABLES = new Map([
  ['forge_jobs', FORGE_SOURCE_COLUMNS],
  ['forge_selections', FORGE_SELECTION_COLUMNS],
  ['continuity_handoffs', HANDOFF_COLUMNS],
]);
const quote = value => `"${String(value).replaceAll('"', '""')}"`;
const placeholders = count => Array.from({ length: count }, (_, i) => `$${i + 1}`).join(',');

function readTable(db, name, columns) {
  const actual = db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(row => row.name);
  if (actual.length !== columns.length || actual.some((column, i) => column !== columns[i])) {
    throw new Error(`unsupported_source_columns:${name}`);
  }
  return db.prepare(`SELECT rowid AS __import_rowid, ${columns.map(quote).join(',')} FROM ${quote(name)} ORDER BY rowid`).all();
}

function readSource(databasePath, selectedTables = null) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
    if (selectedTables && selectedTables.some(name => !SOURCE_TABLES.has(name))) throw new Error('unsupported_selected_auxiliary_table');
    const unknown = selectedTables ? [] : names.filter(name => !SOURCE_TABLES.has(name));
    if (unknown.length) throw new Error(`unsupported_source_tables:${unknown.join(',')}`);
    const required = selectedTables || (names.includes('forge_jobs') || names.includes('forge_selections') ? ['forge_jobs','forge_selections'] : ['continuity_handoffs']);
    const missing = required.filter(name => !names.includes(name));
    if (missing.length) throw new Error(`missing_source_tables:${missing.join(',')}`);
    return Object.fromEntries([...SOURCE_TABLES].filter(([name])=>names.includes(name) && (!selectedTables || selectedTables.includes(name))).map(([name, columns]) => [name, readTable(db, name, columns)]));
  } finally {
    db.close();
  }
}

function json(value, table, column) {
  if (value !== null && typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { throw new Error(`invalid_source_json:${table}:${column}`); }
}
function timestamptzEqual(a, b) {
  return a === null && b === null || (a !== null && b !== null && new Date(a).getTime() === new Date(b).getTime());
}
function equal(column, source, target) {
  if (['created_at', 'updated_at', 'expires_at'].includes(column)) return timestamptzEqual(source, target);
  if (column === 'request' || column === 'record' || column === 'source_refs') return isDeepStrictEqual(json(source, 'source', column), target);
  return source === target;
}
function publicRecord(source) {
  const record = json(source, 'forge_jobs', 'record');
  // SQLite records are public job records. Never carry lease credentials into Postgres.
  delete record.ownerToken;
  delete record.owner_token;
  delete record.ownerId;
  delete record.owner_id;
  return record;
}
function forgeJob(row) {
  const record = publicRecord(row.record);
  if (row.agent_id !== '__operator__' && !record.legacySourceAgentId) record.legacySourceAgentId = row.agent_id;
  delete record.agentId;
  delete record.legacyAgentId;
  if (['queued', 'running'].includes(record.status)) {
    record.status = 'interrupted';
    record.error = 'generation_interrupted';
  }
  const createdAt = record.createdAt || record.created_at;
  const updatedAt = record.updatedAt || record.updated_at || createdAt;
  if (!createdAt) throw new Error(`missing_source_timestamp:forge_jobs:${row.id}`);
  return [row.id, '__operator__', row.idem, null, null, json(row.request, 'forge_jobs', 'request'), record, createdAt, updatedAt];
}

async function targetLayout(client, table, expected) {
  const result = await client.query(`SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY ordinal_position`, [table]);
  if (!result.rowCount) throw new Error(`unsupported_target_table:${table}`);
  const actual = result.rows.map(row => row.column_name);
  const missing = expected.filter(column => !actual.includes(column));
  const unknown = actual.filter(column => !expected.includes(column) && !(table === 'forge_jobs' && ['owner_id', 'owner_token', 'created_at', 'updated_at', 'ordinal'].includes(column)));
  if (missing.length || unknown.length) throw new Error(`unsupported_target_columns:${table}:${[...missing, ...unknown].join(',')}`);
}

async function assertEmpty(client, table) {
  if ((await client.query(`SELECT 1 FROM ${quote(table)} LIMIT 1`)).rowCount) throw new Error(`target_not_empty:${table}`);
}
async function insertAndVerify(client, table, columns, values, sourceRows) {
  const sql = `INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) VALUES (${placeholders(columns.length)})`;
  for (let i = 0; i < values.length; i++) await client.query(sql, values[i].map((v,j)=>['request','record','source_refs'].includes(columns[j]) ? JSON.stringify(v) : v));
  const result = await client.query(`SELECT ${columns.map(quote).join(',')} FROM ${quote(table)} ORDER BY ${table === 'forge_jobs' ? 'ordinal' : '1'}`);
  if (result.rowCount !== sourceRows.length) throw new Error(`import_verification_failed:${table}:count`);
  for (let i = 0; i < sourceRows.length; i++) {
    const expected = values[i];
    const actual = result.rows.find(row=>row[columns[0]] === expected[0]);
    if (!actual) throw new Error(`import_verification_failed:${table}:identity`);
    for (let j = 0; j < columns.length; j++) if (!equal(columns[j], expected[j], actual[columns[j]])) throw new Error(`import_verification_failed:${table}:${i}:${columns[j]}`);
  }
}

// Compare source values before lossy migration transforms (lease stripping and
// interruption). Different source records must never become silent duplicates.
function equivalentSource(table, left, right) {
  return SOURCE_TABLES.get(table).every(column => {
    if (['request', 'record', 'source_refs'].includes(column)) {
      return isDeepStrictEqual(json(left[column], table, column), json(right[column], table, column));
    }
    return left[column] === right[column];
  });
}

function mergeSources(paths, selectedTables) {
  const merged = {};
  for (const item of paths) {
    const databasePath = typeof item === 'string' ? item : item.path;
    const tables = typeof item === 'string' ? selectedTables : item.selectedTables ?? selectedTables;
    let source;
    try { source = readSource(databasePath, tables); }
    catch (error) { throw new Error(`auxiliary_source_error:${JSON.stringify(databasePath)}:${error.message}`, { cause: error }); }
    for (const [table, rows] of Object.entries(source)) {
      const identities = merged[table] ||= new Map();
      // The current schemas key jobs/handoffs by id and selections by mode.
      // Forge idem and continuity (agent_id, session_id) are NOT unique: retain
      // distinct ids even when they share these lookup keys.
      const identityColumn = SOURCE_TABLES.get(table)[0];
      for (const row of rows) {
        const identity = row[identityColumn];
        const previous = identities.get(identity);
        if (previous) {
          if (!equivalentSource(table, previous.row, row)) {
            throw new Error(`auxiliary_source_conflict:${table}:${identityColumn}=${JSON.stringify(identity)}:sources=${JSON.stringify([previous.path, databasePath])}`);
          }
        } else identities.set(identity, { row, path: databasePath });
      }
    }
  }
  return Object.fromEntries(Object.entries(merged).map(([table, entries]) => [table, [...entries.values()].map(entry => entry.row)]));
}

/** Read and merge all SQLite sources before atomically importing into empty tables. */
export async function importAuxiliaryDatabases(pool, paths, { selectedTables = null } = {}) {
  if (!pool?.connect) throw new Error('postgres_pool_required');
  if (!Array.isArray(paths)) throw new Error('auxiliary_source_paths_required');
  const source = mergeSources(paths, selectedTables);
  const jobs = (source.forge_jobs || []).map(forgeJob);
  const selections = (source.forge_selections || []).map(row => [row.mode, row.connection_id, row.model_id, row.updated_at]);
  const handoffs = (source.continuity_handoffs || []).map(row => [row.id, row.agent_id, row.session_id, row.run_id, row.source, row.title, row.content, json(row.source_refs, 'continuity_handoffs', 'source_refs'), row.evidence_summary, row.created_at, row.updated_at, row.expires_at]);
  return withPostgresTransaction(pool, async client => {
    for (const [table, columns] of [['forge_jobs', FORGE_JOB_COLUMNS], ['forge_selections', FORGE_SELECTION_COLUMNS], ['continuity_handoffs', HANDOFF_COLUMNS]]) {
      if (!source[table]) continue;
      await client.query(`LOCK TABLE ${quote(table)} IN EXCLUSIVE MODE`);
      await targetLayout(client, table, columns);
      await assertEmpty(client, table);
    }
    if (source.forge_jobs) await insertAndVerify(client, 'forge_jobs', FORGE_JOB_COLUMNS, jobs, source.forge_jobs);
    if (source.forge_selections) await insertAndVerify(client, 'forge_selections', FORGE_SELECTION_COLUMNS, selections, source.forge_selections);
    if (source.continuity_handoffs) await insertAndVerify(client, 'continuity_handoffs', HANDOFF_COLUMNS, handoffs, source.continuity_handoffs);
    return { forgeJobs: jobs.length, forgeSelections: selections.length, continuityHandoffs: handoffs.length };
  });
}

/** Backwards-compatible single-source API, including settings' selected tables. */
export async function importAuxiliaryDatabase(pool, databasePath, options = {}) {
  return importAuxiliaryDatabases(pool, [databasePath], options);
}

export const importForgeAndContinuityDatabase = importAuxiliaryDatabase;
export const AUXILIARY_IMPORT_TABLES = Object.freeze([...SOURCE_TABLES.keys()]);
