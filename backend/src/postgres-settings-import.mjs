import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { DEFAULT_RETENTION_POLICY } from './retention-settings.mjs';
import { DatabaseSync } from 'node:sqlite';
import { importAuxiliaryDatabases } from './postgres-auxiliary-import.mjs';
import { withPostgresTransaction, postgresTransactionContext } from './postgres-foundation.mjs';

// This is the exact current SQLite settings contract (30 tables).
const TABLE_COLUMNS = Object.freeze({
  agent_mcp_tools:['agent_id','connection_id','tool_name','enabled','created_at','updated_at'], agent_model_selections:['agent_id','connection_id','model_id','reasoning_effort','updated_at','temperature'], agent_profile_documents:['agent_id','kind','markdown','created_at','updated_at'], agent_skill_assignments:['agent_id','skill_id','created_at'], agents:['id','name','enabled','available_capabilities','created_at','updated_at','context_config_json','execution_environment_json'], api_tokens:['id','name','token_hash','token_prefix','scopes_json','expires_at','last_used_at','revoked_at','created_at','updated_at'], chat_identities:['kind','id','name','avatar','created_at','updated_at'], conversation_project_bindings:['agent_id','session_id','project_id','created_at','updated_at'], dream_diary_entries:['id','agent_id','entry_date','phase','narrative','source_refs','created_at','updated_at'], dream_settings:['agent_id','enabled','cron_expression','timezone','prompt','created_at','updated_at','model_connection_id','model'], mcp_connection_secrets:['id','connection_id','name','ciphertext','nonce','auth_tag','created_at','updated_at'], mcp_connections:['id','name','transport','base_url','enabled','tools_json','created_at','updated_at','connection_kind','command','args_json','lifecycle'], mod_installations:['mod_id','source_id','version','archive_sha256','installed_at','updated_at'], mod_lifecycle:['mod_id','enabled','created_at','updated_at'], mod_secrets:['mod_id','name','ciphertext','nonce','auth_tag','created_at','updated_at'], mod_settings:['mod_id','name','value_json','created_at','updated_at'], mod_source_secrets:['source_id','ciphertext','nonce','auth_tag','created_at','updated_at'], mod_sources:['id','url','provider','mod_id','mod_name','latest_version','archive_url','status','error','last_checked_at','created_at','updated_at'], model_connection_secrets:['id','connection_id','name','ciphertext','nonce','auth_tag','created_at','updated_at'], model_connections:['id','provider','api_type','base_url','accepted_input_json','models_json','created_at','updated_at'], scheduled_job_runs:['id','job_id','scheduled_for','status','agent_id','session_id','run_id','dispatched_at','completed_at','trace_dir','decision','ok','error','result_json','created_at','updated_at'], scheduled_jobs:['id','agent_id','name','prompt','cron_expression','timezone','session_id','enabled','next_run_at','last_run_at','created_at','updated_at','model_connection_id','model','owner_mod_id'], schema_migrations:['version','name','applied_at','checksum'], settings_meta:['key','value_json','updated_at'], skill_global_assignments:['skill_id','created_at'], skills:['id','name','description','content','lifecycle','created_at','updated_at'], task_board_project_paths:['id','project_id','label','path','note','sort_order','created_at','updated_at'], task_board_projects:['id','name','description','created_at','updated_at','notes'], task_board_tasks:['id','project_id','title','description','status','assigned_agent_id','metadata_json','execution_json','created_at','updated_at','priority'], ui_auth_secrets:['id','name','ciphertext','nonce','auth_tag','created_at','updated_at']
});
const TABLES = Object.freeze(Object.keys(TABLE_COLUMNS));
const WORKING_MEMORY_COLUMNS = ['id','agent_id','session_id','conversation_id','project','kind','state','title','content','source_refs','pinned','created_at','updated_at','expires_at','last_recalled_at'];
const DERIVED_FTS_TABLES = new Set(['working_memory_fts','working_memory_fts_data','working_memory_fts_idx','working_memory_fts_docsize','working_memory_fts_config']);
const quote = (s) => `"${String(s).replaceAll('"','""')}"`;
const digest = (a,d,p,n) => createHash('sha256').update([a,d,p,n].join('\0')).digest('hex');

function readSource(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
    const unknown = names.filter(n=>!Object.hasOwn(TABLE_COLUMNS,n) && n !== 'working_memory' && !DERIVED_FTS_TABLES.has(n) && !['forge_jobs','forge_selections'].includes(n));
    if (unknown.length) throw new Error(`unsupported_source_tables:${unknown.join(',')}`);
    const absent = TABLES.filter(n=>!names.includes(n));
    if (absent.length) throw new Error(`missing_source_tables:${absent.join(',')}`);
    if (names.includes('forge_jobs') !== names.includes('forge_selections')) throw new Error('incomplete_forge_source');
    const tables = [...TABLES, ...(names.includes('working_memory') ? ['working_memory'] : [])].map(name => {
      const columns = name === 'working_memory' ? WORKING_MEMORY_COLUMNS : TABLE_COLUMNS[name];
      const actual = db.prepare(`PRAGMA table_info(${quote(name)})`).all().map(r=>r.name);
      if (actual.length !== columns.length || actual.some((v,i)=>v!==columns[i])) throw new Error(`unsupported_source_columns:${name}`);
      return { name, columns, rows: db.prepare(`SELECT ${columns.map(quote).join(',')} FROM ${quote(name)}`).all() };
    });
    return { tables, hasForge: names.includes('forge_jobs') };
  } finally { db.close(); }
}
function equal(a, b, type) {
  if (type === 'timestamptz') return a === null && b === null || new Date(a).getTime() === new Date(b).getTime();
  if (type === 'jsonb') return isDeepStrictEqual(a, typeof b === 'string' ? JSON.parse(b) : b);
  return isDeepStrictEqual(a, b);
}

/** Import a complete SQLite settings database into an empty PostgreSQL application database. */
export async function importSettingsDatabase(pool, databasePath, { auxiliarySources = [] } = {}) {
  if (!pool?.connect) throw new Error('postgres_pool_required');
  const {tables: source, hasForge} = readSource(databasePath);
  return withPostgresTransaction(pool, async client => {
    const info = await client.query("SELECT table_name,column_name,udt_name,data_type FROM information_schema.columns WHERE table_schema=current_schema()");
    const targetColumns = new Map();
    for (const r of info.rows) (targetColumns.get(r.table_name) || targetColumns.set(r.table_name,[]).get(r.table_name)).push(r);
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['burrow-settings-import']);
    for (const name of targetColumns.keys()) {
      if (name === 'burrow_schema_migrations') continue;
      await client.query(`LOCK TABLE ${quote(name)} IN EXCLUSIVE MODE`);
      if ((await client.query(`SELECT 1 FROM ${quote(name)} LIMIT 1`)).rowCount) throw new Error(`target_not_empty:${name}`);
    }
    for (const table of source) {
      if (table.name === 'schema_migrations') continue;
      const actual=targetColumns.get(table.name); if (!actual) throw new Error(`unsupported_target_table:${table.name}`);
      const missing=table.columns.filter(c=>!actual.some(x=>x.column_name===c)); if(missing.length) throw new Error(`unsupported_target_columns:${table.name}:${missing.join(',')}`);
      const occupied=await client.query(`SELECT 1 FROM ${quote(table.name)} LIMIT 1`); if(occupied.rowCount) throw new Error(`target_not_empty:${table.name}`);
    }
    const ledger = source.find(t=>t.name==='schema_migrations').rows;
    const meta = source.find(t=>t.name==='settings_meta');
    const archival = { version:1, source:'sqlite', rows:ledger };
    const metaRows = [...meta.rows];
    metaRows.push({key:'sqlite_schema_migrations',value_json:JSON.stringify(archival),updated_at:new Date().toISOString()});
    const byName = new Map(source.map(t=>[t.name,t])); byName.set('settings_meta',{...meta,rows:metaRows});
    // Parents precede children; this order is explicit and is part of the import contract.
    const order=['model_connections','agents','chat_identities','skills','task_board_projects','mod_sources','mod_installations','mcp_connections','model_connection_secrets','mcp_connection_secrets','agent_model_selections','agent_mcp_tools','agent_profile_documents','agent_skill_assignments','skill_global_assignments','dream_settings','dream_diary_entries','task_board_project_paths','task_board_tasks','scheduled_jobs','scheduled_job_runs','api_tokens','mod_lifecycle','mod_secrets','mod_settings','mod_source_secrets','settings_meta','ui_auth_secrets','conversation_project_bindings', ...(byName.has('working_memory') ? ['working_memory'] : [])];
    let rowsImported = 0;
    async function insert(name, row) {
      const info = targetColumns.get(name);
      if (!info) throw new Error(`unsupported_target_table:${name}`);
      const columns = Object.keys(row);
      const values = columns.map(column => {
        const type = info.find(c => c.column_name === column)?.udt_name;
        if (!type) throw new Error(`unsupported_target_columns:${name}:${column}`);
        let value = row[column];
        if (value === null) return null;
        if (type === 'bool') return Boolean(Number(value));
        if (type === 'bytea') return Buffer.from(value);
        if (type === 'jsonb') return typeof value === 'string' ? JSON.stringify(JSON.parse(value)) : JSON.stringify(value);
        return value;
      });
      const result = await client.query(`INSERT INTO ${quote(name)} (${columns.map(quote).join(',')}) VALUES (${columns.map((_,i)=>'$'+(i+1)).join(',')}) RETURNING ${columns.map(quote).join(',')}`, values);
      if (result.rowCount !== 1 || columns.some((c,i) => !equal(result.rows[0][c], values[i], info.find(x=>x.column_name===c).udt_name))) throw new Error(`import_verification_failed:${name}`);
      rowsImported++;
    }
    for (const name of order) {
      for (const original of byName.get(name).rows) {
        const row = { ...original };
        if (name === 'dream_diary_entries') row.narrative_digest = digest(row.agent_id,row.entry_date,row.phase,row.narrative);
        await insert(name, row);
      }
    }
    const metadata = new Map(meta.rows.map(row => [row.key, row]));
    for (const [key, table] of [['installation_setup_state','installation_setup_state'], ['working_memory_retention','working_memory_retention_settings']]) {
      const row = metadata.get(key);
      if (row) await insert(table, { owner_id:'default', value_json:row.value_json, updated_at:row.updated_at });
    }
    const policy = metadata.get('retention_policy'), state = metadata.get('retention_policy_state');
    if (policy || state) await insert('retention_settings', {
      owner_id:'default', policy_json:policy?.value_json || JSON.stringify(DEFAULT_RETENTION_POLICY),
      state_json:state?.value_json || JSON.stringify({lastRunAt:null,lastResult:null,lastError:null,nextRunAt:null}), updated_at:(policy || state).updated_at,
    });
    // Deleted agents can leave metadata behind; archive it but do not project orphan rows.
    const agentIds = new Set(byName.get('agents').rows.map(row => row.id));
    const connectionIds = new Set(byName.get('model_connections').rows.map(row => row.id));
    for (const row of meta.rows) {
      if (['dream-preload:', 'dream-ledger:', 'dream-scope-review:', 'rolling-continuity:', 'brain-promotion-candidates:'].some(prefix => row.key.startsWith(prefix))) await insert('working_memory_meta', {key:row.key,value_json:row.value_json,updated_at:row.updated_at});
      if (row.key.startsWith('dream-cycle:')) {
        const value = JSON.parse(row.value_json);
        if (agentIds.has(row.key.slice('dream-cycle:'.length))) await insert('dream_cycle_state', {agent_id:row.key.slice('dream-cycle:'.length),state_json:value,updated_at:row.updated_at});
      }
      if (row.key.startsWith('dream-cycle-receipt:')) {
        const value = JSON.parse(row.value_json);
        if (agentIds.has(value.agentId)) await insert('dream_cycle_receipts', {agent_id:value.agentId,run_id:value.runId,receipt_json:value,updated_at:row.updated_at});
      }
      if (row.key.startsWith('dream-cycle-occurrence:')) {
        const value = JSON.parse(row.value_json);
        if (agentIds.has(value.agentId)) await insert('dream_cycle_occurrences', {agent_id:value.agentId,scheduled_for:value.scheduledFor,occurrence_json:value,created_at:row.updated_at});
      }
      if (row.key.startsWith('model_auth_preview:')) {
        const connectionId = row.key.slice('model_auth_preview:'.length);
        // Legacy metadata outlives deleted connections. Preserve it in settings_meta,
        // but only materialize active previews whose parent still exists.
        if (connectionIds.has(connectionId)) await insert('model_auth_previews', { connection_id:connectionId, value_json:row.value_json, updated_at:row.updated_at });
      }
      if (['openai_codex_client_version','models_dev_catalog'].includes(row.key)) await insert('model_settings_cache', { cache_key:row.key, value_json:row.value_json, updated_at:row.updated_at });
    }
    const sources = [...(hasForge ? [{ path: databasePath, selectedTables: ['forge_jobs','forge_selections'] }] : []), ...auxiliarySources];
    const auxiliary = sources.length ? await importAuxiliaryDatabases(postgresTransactionContext(client), sources) : null;
    return Object.freeze({ tablesImported:source.length, rowsImported, ...(hasForge ? {forge: auxiliary} : {}), ...(auxiliarySources.length ? {auxiliary} : {}) });
  });
}
export const SETTINGS_IMPORT_TABLE_COLUMNS=TABLE_COLUMNS;
export default {importSettingsDatabase};
