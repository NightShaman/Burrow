import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const stable = (value) => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? `${v}` : v);
// Current settings schema, after retirement migrations; historical CREATE TABLE
// declarations are not an inventory of live authorities.
const ALLOWED = new Set([
  'agent_mcp_tools', 'agent_model_selections', 'agent_profile_documents',
  'agent_skill_assignments', 'agents', 'api_tokens', 'chat_identities',
  'conversation_project_bindings', 'dream_diary_entries', 'dream_settings',
  'mcp_connection_secrets', 'mcp_connections', 'mod_installations',
  'mod_lifecycle', 'mod_secrets', 'mod_settings', 'mod_source_secrets',
  'mod_sources', 'model_connection_secrets', 'model_connections',
  'scheduled_job_runs', 'scheduled_jobs', 'schema_migrations', 'settings_meta',
  'skill_global_assignments', 'skills', 'task_board_project_paths',
  'task_board_projects', 'task_board_tasks', 'ui_auth_secrets',
]);
const REQUIRED = new Set(['agents', 'agent_profile_documents']);

function sqliteRows(db, sql, params = []) { return db.prepare(sql).all(...params); }
function tableNames(db) { return sqliteRows(db, "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map(r => r.name); }

/** Read-only inventory. This function never executes a write against the source database. */
export function inventorySqliteSource(databasePath) {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tables = tableNames(db).map(name => {
      const columns = sqliteRows(db, `PRAGMA table_info(${quoteIdent(name)})`).map(({ name: column, type, notnull, dflt_value, pk }) => ({ name: column, type, notNull: Boolean(notnull), default: dflt_value, primaryKey: pk }));
      const count = Number(sqliteRows(db, `SELECT COUNT(*) AS count FROM ${quoteIdent(name)}`)[0].count);
      const sql = sqliteRows(db, 'SELECT sql FROM sqlite_master WHERE type=\'table\' AND name=?', [name])[0]?.sql || '';
      return { name, columns, count, sql };
    });
    const schema = tables.map(({ name, columns, sql }) => ({ name, columns, sql }));
    const fingerprint = sha256(stable(schema));
    const unsupportedTables = tables.filter(t => !ALLOWED.has(t.name)).map(t => t.name);
    return Object.freeze({ kind: 'sqlite-source-inventory', tables, tableCount: tables.length, schemaFingerprint: fingerprint, unsupportedTables, supported: unsupportedTables.length === 0 && [...REQUIRED].every(name => tableNames(db).includes(name)) });
  } finally { db.close(); }
}

function quoteIdent(value) { return `"${String(value).replaceAll('"', '""')}"`; }

/** Parse an exported JSONL source. Any non-empty malformed line is fatal. */
export function parseJsonlSource(input) {
  const text = readFileSync(input, 'utf8');
  const records = []; const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    try { records.push(JSON.parse(lines[i])); } catch (error) { throw new Error(`source_jsonl_corrupt_line:${i + 1}`, { cause: error }); }
  }
  return records;
}

// Import execution deliberately unavailable until every owned source table has an
// explicit verified mapping. Inventory is not authorization to omit unknown data.
export const __postgresImport = Object.freeze({ ALLOWED });
export default { inventorySqliteSource, parseJsonlSource };
