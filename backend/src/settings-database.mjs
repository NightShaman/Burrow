import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

function now() { return new Date().toISOString(); }

export function settingsDatabasePath({ dataRoot = null } = {}) {
  return process.env.BURROW_SETTINGS_DB || path.join(dataRoot || process.env.BURROW_RUNTIME_ROOT || process.env.BURROW_DATA_ROOT || '/mnt/local/burrow', 'config', 'settings.sqlite');
}

const INITIAL_RECORDS = `
  CREATE TABLE IF NOT EXISTS model_connections (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, api_type TEXT NOT NULL, base_url TEXT NOT NULL,
    accepted_input_json TEXT NOT NULL DEFAULT '["text","image"]', models_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS model_connection_secrets (
    id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES model_connections(id) ON DELETE CASCADE,
    name TEXT NOT NULL, ciphertext BLOB NOT NULL, nonce BLOB NOT NULL, auth_tag BLOB NOT NULL,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(connection_id, name)
  );
  CREATE TABLE IF NOT EXISTS chat_identities (
    kind TEXT NOT NULL CHECK (kind IN ('operator', 'agent')),
    id TEXT NOT NULL, name TEXT NOT NULL, avatar TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (kind, id)
  );
  CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)), model_profile TEXT,
    available_capabilities TEXT NOT NULL DEFAULT '["chat","files","skills"]',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  );
`;

const FOUNDATION_METADATA = `
  CREATE TABLE IF NOT EXISTS settings_meta (
    key TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
`;

export const SETTINGS_OWNERSHIP = Object.freeze([
  Object.freeze({ id: 'model-connections', authority: 'sqlite', storage: 'model_connections', surface: 'model-settings-api', migration: 'complete', notes: 'Connection metadata, enabled models, and encrypted API keys; normal chat resolves by SQLite ID.' }),
  Object.freeze({ id: 'chat-identities', authority: 'sqlite', storage: 'chat_identities', surface: 'chat-identity-api', migration: 'complete', notes: 'Operator and agent display identities.' }),
  Object.freeze({ id: 'agent-registry', authority: 'sqlite', storage: 'agents', surface: 'agent-registry-api', migration: 'complete', notes: 'Agent records and bounded context configuration.' }),
  Object.freeze({ id: 'agent-profile-documents', authority: 'sqlite', storage: 'agent_profile_documents', surface: 'agent-profile-documents-api', migration: 'complete', notes: 'Per-agent virtual Markdown prompt documents: SOUL, RULES, ORIENTATION, PREFERENCES, TOOLS, and DreamMemory.' }),
  Object.freeze({ id: 'dream-diary', authority: 'sqlite', storage: 'dream_diary_entries', surface: 'dream-diary-store', migration: 'complete', notes: 'Per-agent operator-facing DreamDiary narrative entries; not loaded into agent prompt context.' }),
  Object.freeze({ id: 'dream-settings', authority: 'sqlite', storage: 'dream_settings', surface: 'dream-settings-api', migration: 'complete', notes: 'Operator-owned Dream enablement, schedule, timezone, and editable prompt.' }),
  Object.freeze({ id: 'runtime-ui-context-settings', authority: 'service-environment', storage: 'service environment', surface: 'deployment', migration: 'complete', notes: 'Deployment paths and listener settings are service-environment owned.' }),
  Object.freeze({ id: 'workspace-registry', authority: 'runtime-files', storage: 'runtime/workspace state', surface: 'not-yet-defined', migration: 'deferred', notes: 'Do not migrate before workspace ownership and routing UX are defined.' }),
  Object.freeze({ id: 'runtime-bindings', authority: 'sqlite', storage: 'runtime_session_bindings, runtime_run_bindings, runtime_active_turns', surface: 'runtime-binding-store', migration: 'complete', notes: 'Durable adapter session/thread and run/turn correlation records; detaching retains native thread references.' }),
  Object.freeze({ id: 'task-board', authority: 'sqlite', storage: 'task_board_projects, task_board_tasks', surface: 'task-board-api', migration: 'complete', notes: 'Projects, task status, agent assignment, execution receipts, and board metadata.' }),
  Object.freeze({ id: 'scheduled-jobs', authority: 'sqlite', storage: 'scheduled_jobs, scheduled_job_runs', surface: 'scheduled-jobs-api', migration: 'complete', notes: 'Operator-owned agent schedules and durable dispatch/result receipts.' }),
  Object.freeze({ id: 'mcp-connections', authority: 'sqlite', storage: 'mcp_connections, mcp_connection_secrets, agent_mcp_tools', surface: 'agent-mcp-settings-api', migration: 'complete', notes: 'HTTP MCP connection records, encrypted API keys, discovered tool metadata, and per-agent tool grants.' }),
  Object.freeze({ id: 'execution-boundaries', authority: 'sqlite', storage: 'settings_meta.execution_boundaries', surface: 'execution-boundaries-settings-api', migration: 'complete', notes: 'Operator-owned hard blocks enforced at concrete tool execution boundaries.' }),
  Object.freeze({ id: 'mods', authority: 'sqlite', storage: 'mod_settings, mod_secrets', surface: 'mod-runtime', migration: 'complete', notes: 'Namespaced mod settings and settings-key-encrypted secrets; mod packages never own Burrow database tables directly.' }),
]);

function checksum(value) { return createHash('sha256').update(value).digest('hex'); }

// v25 was applied while the runtime was still named HatchetClaw. The migration
// only changed the product name inside its default prompt during the Burrow
// rename; existing databases must remain bootable without rewriting history.
const LEGACY_MIGRATION_CHECKSUMS = Object.freeze({
  25: new Set(['0fbadc277d5c976f632c65a9ad6af038170594fcd86388febf4a76db7a69e9db']),
});

const MIGRATIONS = Object.freeze([
  { version: 1, name: 'initial-settings-records', body: INITIAL_RECORDS },
  {
    version: 2,
    name: 'agent-context-config-column',
    body: 'ALTER TABLE agents ADD COLUMN context_config_json TEXT NOT NULL DEFAULT \'{"version":1}\';',
    apply(db) {
      const columns = db.prepare('PRAGMA table_info(agents)').all().map((column) => column.name);
      if (!columns.includes('context_config_json')) db.exec(this.body);
    },
  },
  { version: 3, name: 'settings-foundation-metadata', body: FOUNDATION_METADATA },
  {
    version: 4,
    name: 'sqlite-model-selection-authority',
    body: 'INSERT INTO settings_meta (key,value_json,updated_at) VALUES (\'model_selection_authority\',\'"sqlite"\',CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at;',
  },
  {
    version: 5,
    name: 'remove-agent-model-profile',
    body: 'ALTER TABLE agents DROP COLUMN model_profile;',
    apply(db) {
      const columns = db.prepare('PRAGMA table_info(agents)').all().map((column) => column.name);
      if (columns.includes('model_profile')) db.exec(this.body);
    },
  },
  {
    version: 6,
    name: 'agent-model-selection-runtime-authority',
    body: `CREATE TABLE IF NOT EXISTS agent_model_selections (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL REFERENCES model_connections(id) ON DELETE RESTRICT,
      model_id TEXT NOT NULL, reasoning_effort TEXT NOT NULL DEFAULT 'off',
      updated_at TEXT NOT NULL
    );`,
  },
  {
    version: 7,
    name: 'memory-connection-authority',
    body: `CREATE TABLE IF NOT EXISTS memory_connections (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL DEFAULT 'memory-api', base_url TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_connection_secrets (
      id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES memory_connections(id) ON DELETE CASCADE,
      name TEXT NOT NULL, ciphertext BLOB NOT NULL, nonce BLOB NOT NULL, auth_tag BLOB NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(connection_id,name)
    );`,
  },
  {
    version: 8,
    name: 'runtime-session-run-bindings',
    body: `CREATE TABLE IF NOT EXISTS runtime_session_bindings (
      id TEXT PRIMARY KEY,
      adapter_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      adapter_generation TEXT NOT NULL,
      native_thread_id TEXT,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      closed_at TEXT,
      UNIQUE(adapter_id, agent_id, session_id, adapter_generation)
    );
    CREATE TABLE IF NOT EXISTS runtime_run_bindings (
      run_id TEXT PRIMARY KEY,
      session_binding_id TEXT NOT NULL REFERENCES runtime_session_bindings(id) ON DELETE RESTRICT,
      native_turn_id TEXT,
      state TEXT NOT NULL,
      last_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_sequence >= 0),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      terminal_at TEXT
    );
    CREATE INDEX IF NOT EXISTS runtime_run_bindings_session_binding_idx ON runtime_run_bindings(session_binding_id);
    CREATE TABLE IF NOT EXISTS runtime_active_turns (
      session_binding_id TEXT PRIMARY KEY REFERENCES runtime_session_bindings(id) ON DELETE RESTRICT,
      run_id TEXT NOT NULL UNIQUE REFERENCES runtime_run_bindings(run_id) ON DELETE RESTRICT,
      native_turn_id TEXT,
      state TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,
  },
  {
    version: 9,
    name: 'agent-model-runtime-selection',
    body: "ALTER TABLE agent_model_selections ADD COLUMN runtime_id TEXT NOT NULL DEFAULT 'direct-api';",
    apply(db) {
      const columns = db.prepare('PRAGMA table_info(agent_model_selections)').all().map((column) => column.name);
      if (!columns.includes('runtime_id')) db.exec(this.body);
    },
  },
  {
    // This identity was recorded during the aborted runtime-routing rollout.
    // Keep its exact ledger checksum so existing settings databases remain
    // bootable, but never drop the restored compatibility column on new DBs.
    version: 10,
    name: 'remove-agent-model-runtime-selection',
    body: 'ALTER TABLE agent_model_selections DROP COLUMN runtime_id;',
    apply() {},
  },
  {
    // Likewise retain the already-recorded connection-runtime migration.
    // Current direct runtime code ignores this optional compatibility field.
    version: 11,
    name: 'connection-runtime-selection',
    body: "ALTER TABLE model_connections ADD COLUMN runtime_id TEXT NOT NULL DEFAULT 'direct-api'; UPDATE model_connections SET runtime_id='codex-harness' WHERE lower(api_type)='openai-responses';",
    apply(db) {
      const columns = db.prepare('PRAGMA table_info(model_connections)').all().map((column) => column.name);
      if (!columns.includes('runtime_id')) db.exec(this.body);
      db.exec("UPDATE model_connections SET runtime_id='codex-harness' WHERE lower(api_type)='openai-responses'");
    },
  },
  {
    version: 12,
    name: 'task-board-sqlite-authority',
    body: `CREATE TABLE IF NOT EXISTS task_board_projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS task_board_tasks (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES task_board_projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL CHECK(status IN ('backlog','todo','in_progress','review','done','cancelled')),
      assigned_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}', execution_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS task_board_tasks_project_status_idx ON task_board_tasks(project_id,status,updated_at);`,
  },
  {
    version: 13,
    name: 'task-board-priority',
    body: "ALTER TABLE task_board_tasks ADD COLUMN priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('critical','high','normal','low')); CREATE INDEX IF NOT EXISTS task_board_tasks_priority_idx ON task_board_tasks(priority,updated_at);",
    apply(db) {
      const columns = db.prepare('PRAGMA table_info(task_board_tasks)').all().map((column) => column.name);
      if (!columns.includes('priority')) db.exec(this.body);
    },
  },
  {
    version: 14,
    name: 'mcp-connections-and-agent-tool-grants',
    body: `CREATE TABLE IF NOT EXISTS mcp_connections (
      id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
      transport TEXT NOT NULL CHECK(transport IN ('http')),
      base_url TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      tools_json TEXT NOT NULL DEFAULT '[]', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS mcp_connection_secrets (
      id TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
      name TEXT NOT NULL, ciphertext BLOB NOT NULL, nonce BLOB NOT NULL, auth_tag BLOB NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(connection_id,name)
    );
    CREATE TABLE IF NOT EXISTS agent_mcp_tools (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      connection_id TEXT NOT NULL REFERENCES mcp_connections(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(agent_id,connection_id,tool_name)
    );
    CREATE INDEX IF NOT EXISTS agent_mcp_tools_agent_idx ON agent_mcp_tools(agent_id,enabled);`,
  },
  {
    version: 15,
    name: 'remove-codex-harness-runtime-state',
    body: `DELETE FROM runtime_active_turns WHERE session_binding_id IN (SELECT id FROM runtime_session_bindings WHERE adapter_id='codex-harness');
    DELETE FROM runtime_run_bindings WHERE session_binding_id IN (SELECT id FROM runtime_session_bindings WHERE adapter_id='codex-harness');
    DELETE FROM runtime_session_bindings WHERE adapter_id='codex-harness';
    ALTER TABLE agent_model_selections DROP COLUMN runtime_id;
    ALTER TABLE model_connections DROP COLUMN runtime_id;`,
    apply(db) {
      // Remove only bindings owned by the retired adapter, in FK-safe order.
      db.exec(`DELETE FROM runtime_active_turns WHERE session_binding_id IN (SELECT id FROM runtime_session_bindings WHERE adapter_id='codex-harness');
        DELETE FROM runtime_run_bindings WHERE session_binding_id IN (SELECT id FROM runtime_session_bindings WHERE adapter_id='codex-harness');
        DELETE FROM runtime_session_bindings WHERE adapter_id='codex-harness';`);
      const selectionColumns = db.prepare('PRAGMA table_info(agent_model_selections)').all().map((column) => column.name);
      if (selectionColumns.includes('runtime_id')) db.exec('ALTER TABLE agent_model_selections DROP COLUMN runtime_id;');
      const connectionColumns = db.prepare('PRAGMA table_info(model_connections)').all().map((column) => column.name);
      if (connectionColumns.includes('runtime_id')) db.exec('ALTER TABLE model_connections DROP COLUMN runtime_id;');
    },
  },
  {
    version: 16,
    name: 'mcp-stdio-connections',
    body: `ALTER TABLE mcp_connections ADD COLUMN connection_kind TEXT NOT NULL DEFAULT 'http' CHECK(connection_kind IN ('http','stdio'));
      ALTER TABLE mcp_connections ADD COLUMN command TEXT;
      ALTER TABLE mcp_connections ADD COLUMN args_json TEXT NOT NULL DEFAULT '[]';`,
    apply(db) {
      const columns = db.prepare('PRAGMA table_info(mcp_connections)').all().map((column) => column.name);
      if (!columns.includes('connection_kind')) db.exec("ALTER TABLE mcp_connections ADD COLUMN connection_kind TEXT NOT NULL DEFAULT 'http' CHECK(connection_kind IN ('http','stdio')); ");
      if (!columns.includes('command')) db.exec('ALTER TABLE mcp_connections ADD COLUMN command TEXT;');
      if (!columns.includes('args_json')) db.exec("ALTER TABLE mcp_connections ADD COLUMN args_json TEXT NOT NULL DEFAULT '[]';");
    },
  },
  {
    version: 17,
    name: 'agent-profile-markdown-documents',
    body: `CREATE TABLE IF NOT EXISTS agent_profile_documents (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('SOUL','RULES','ORIENTATION')),
      markdown TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(agent_id,kind)
    );`,
  },
  {
    version: 18,
    name: 'agent-profile-tools-document',
    body: `CREATE TABLE agent_profile_documents_v18 (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('SOUL','RULES','ORIENTATION','TOOLS')),
      markdown TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(agent_id,kind)
    );
    INSERT INTO agent_profile_documents_v18 (agent_id,kind,markdown,created_at,updated_at)
      SELECT agent_id,kind,markdown,created_at,updated_at FROM agent_profile_documents;
    INSERT INTO agent_profile_documents_v18 (agent_id,kind,markdown,created_at,updated_at)
      SELECT id,'TOOLS','',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM agents
      WHERE NOT EXISTS (SELECT 1 FROM agent_profile_documents_v18 WHERE agent_id=agents.id AND kind='TOOLS');
    DROP TABLE agent_profile_documents;
    ALTER TABLE agent_profile_documents_v18 RENAME TO agent_profile_documents;`,
  },
  {
    version: 19,
    name: 'operator-owned-scheduled-jobs',
    body: `CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id TEXT PRIMARY KEY, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
      name TEXT NOT NULL, prompt TEXT NOT NULL, cron_expression TEXT NOT NULL, timezone TEXT NOT NULL,
      session_id TEXT NOT NULL DEFAULT 'default', enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      next_run_at TEXT, last_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(agent_id,name)
    );
    CREATE INDEX IF NOT EXISTS scheduled_jobs_due_idx ON scheduled_jobs(enabled,next_run_at);
    CREATE TABLE IF NOT EXISTS scheduled_job_runs (
      id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
      scheduled_for TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('running','completed','failed','cancelled','missed','skipped')),
      agent_id TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT, dispatched_at TEXT, completed_at TEXT,
      trace_dir TEXT, decision TEXT, ok INTEGER, error TEXT, result_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS scheduled_job_runs_job_idx ON scheduled_job_runs(job_id,scheduled_for DESC);`,
  },
  {
    version: 20,
    name: 'retire-native-memory-api-connections',
    body: 'DROP TABLE IF EXISTS memory_connection_secrets; DROP TABLE IF EXISTS memory_connections;',
  },
  {
    version: 21,
    name: 'agent-model-selection-temperature',
    body: 'ALTER TABLE agent_model_selections ADD COLUMN temperature REAL NOT NULL DEFAULT 0.2 CHECK(temperature >= 0 AND temperature <= 2);',
    apply(db) {
      const columns = db.prepare('PRAGMA table_info(agent_model_selections)').all().map((column) => column.name);
      if (!columns.includes('temperature')) db.exec(this.body);
    },
  },
  {
    version: 22,
    name: 'agent-profile-dream-memory-document',
    body: `CREATE TABLE agent_profile_documents_v22 (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('SOUL','RULES','ORIENTATION','TOOLS','DREAM_MEMORY')),
      markdown TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(agent_id,kind)
    );
    INSERT INTO agent_profile_documents_v22 (agent_id,kind,markdown,created_at,updated_at)
      SELECT agent_id,kind,markdown,created_at,updated_at FROM agent_profile_documents;
    INSERT INTO agent_profile_documents_v22 (agent_id,kind,markdown,created_at,updated_at)
      SELECT id,'DREAM_MEMORY','# DreamMemory\n\nSemi-durable local continuity distilled from recent work. Human-editable. Not authoritative. Verify mutable facts before acting.\n',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM agents
      WHERE NOT EXISTS (SELECT 1 FROM agent_profile_documents_v22 WHERE agent_id=agents.id AND kind='DREAM_MEMORY');
    DROP TABLE agent_profile_documents;
    ALTER TABLE agent_profile_documents_v22 RENAME TO agent_profile_documents;`,
  },
  {
    version: 23,
    name: 'dream-diary-entries',
    body: `CREATE TABLE IF NOT EXISTS dream_diary_entries (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      entry_date TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('light','rem','deep','manual')),
      narrative TEXT NOT NULL,
      source_refs TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(agent_id,entry_date,phase,narrative)
    );
    CREATE INDEX IF NOT EXISTS dream_diary_entries_agent_date_idx ON dream_diary_entries(agent_id,entry_date DESC,created_at DESC);`,
  },
  {
    version: 24,
    name: 'dream-settings',
    body: `CREATE TABLE IF NOT EXISTS dream_settings (
      agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0,1)),
      cron_expression TEXT NOT NULL DEFAULT '0 4 * * *',
      timezone TEXT NOT NULL DEFAULT 'UTC',
      prompt TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,
  },
  {
    version: 25,
    name: 'dream-settings-default-prompt-dreamlike',
    body: `UPDATE dream_settings SET prompt='You are keeping Burrow''s dream diary. Write one short first-person entry from the day''s residue.

Voice & tone:
- Curious, sharp, a little haunted, and gently funny.
- A goblin-minded poet-programmer sorting fragments by moonlight.
- Mix technical residue with dream texture: traces and fog, SQLite and moth wings, APIs and old floorboards.
- Let the fragments make one or two strange but useful connections.

Use the provided residue as inspiration, not gospel. DreamMemory is semi-durable local continuity, not durable truth. DreamDiary is for the operator''s morning read, not agent authority.

Rules:
- Keep it between 80 and 180 words.
- Flowing prose only: no headers, bullets, preamble, sign-off, or analysis.
- Do not mention AI, agent, LLM, model, prompt, system, or runtime internals as self-reference.
- Do not say "I am dreaming", "in my dream", or explain the dream process.
- Keep secrets out. If a fragment smells credential-adjacent, turn away from it.
- Output only the diary entry.', updated_at=CURRENT_TIMESTAMP WHERE prompt='Operator Directs, Agent Decides, Runtime Proves.

Use recent session residue and local working-memory continuity to produce useful dream outputs without treating them as durable truth.

DreamMemory carries forward semi-durable local continuity for the agent. It must stay concise, mutable, and non-authoritative. Verify mutable facts before action.

DreamDiary is for the operator: readable narrative reflection, never prompt authority, never Brain.';`,
  },
  {
    version: 26,
    name: 'dream-settings-model-selection',
    body: `dream_settings gains nullable model_connection_id and model columns for dream-only model selection.`,
    apply: ensureDreamSettingsModelColumns,
  },
  {
    version: 27,
    name: 'ui-auth-secrets',
    body: `CREATE TABLE IF NOT EXISTS ui_auth_secrets (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      ciphertext BLOB NOT NULL,
      nonce BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );`,
  },
  {
    version: 28,
    name: 'mcp-connection-lifecycle',
    body: "ALTER TABLE mcp_connections ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'ephemeral' CHECK(lifecycle IN ('ephemeral','keep_alive'));",
    apply(db) {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='mcp_connections'").get();
      if (!table) return;
      const columns = new Set(db.prepare('PRAGMA table_info(mcp_connections)').all().map((column) => column.name));
      if (!columns.has('lifecycle')) db.exec(this.body);
    },
  },
  {
    version: 29,
    name: 'namespaced-mod-settings-and-secrets',
    body: `CREATE TABLE IF NOT EXISTS mod_settings (
      mod_id TEXT NOT NULL,
      name TEXT NOT NULL,
      value_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(mod_id,name)
    );
    CREATE TABLE IF NOT EXISTS mod_secrets (
      mod_id TEXT NOT NULL,
      name TEXT NOT NULL,
      ciphertext BLOB NOT NULL,
      nonce BLOB NOT NULL,
      auth_tag BLOB NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY(mod_id,name)
    );`,
  },
  {
    version: 30,
    name: 'scheduled-job-occurrence-uniqueness',
    body: 'CREATE UNIQUE INDEX IF NOT EXISTS scheduled_job_runs_occurrence_uq ON scheduled_job_runs(job_id,scheduled_for);',
    apply(db) {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='scheduled_job_runs'").get();
      if (table) db.exec(this.body);
    },
  },
  {
    version: 31,
    name: 'agent-profile-preferences-document',
    body: `CREATE TABLE agent_profile_documents_v31 (
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK(kind IN ('SOUL','RULES','ORIENTATION','PREFERENCES','TOOLS','DREAM_MEMORY')),
      markdown TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(agent_id,kind)
    );
    INSERT INTO agent_profile_documents_v31 (agent_id,kind,markdown,created_at,updated_at)
      SELECT agent_id,kind,markdown,created_at,updated_at FROM agent_profile_documents;
    INSERT INTO agent_profile_documents_v31 (agent_id,kind,markdown,created_at,updated_at)
      SELECT id,'PREFERENCES','# PREFERENCES\n\nCurrent operator-specific working preferences. Operator edits are authoritative. This document contains current guidance only; no audit history.\n',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM agents
      WHERE NOT EXISTS (SELECT 1 FROM agent_profile_documents_v31 WHERE agent_id=agents.id AND kind='PREFERENCES');
    DROP TABLE agent_profile_documents;
    ALTER TABLE agent_profile_documents_v31 RENAME TO agent_profile_documents;`,
    apply(db) {
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_profile_documents'").get();
      if (table) db.exec(this.body);
    },
  },
].map((migration) => Object.freeze({ ...migration, checksum: checksum(`${migration.version}:${migration.name}:${migration.body}`) })));

function ensureDreamSettingsModelColumns(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(dream_settings)').all().map((row) => row.name));
  if (!columns.has('model_connection_id')) db.exec('ALTER TABLE dream_settings ADD COLUMN model_connection_id TEXT;');
  if (!columns.has('model')) db.exec('ALTER TABLE dream_settings ADD COLUMN model TEXT;');
}

function configure(db) {
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  // Another freshly spawned CLI/test process can briefly hold the setup lock.
  // WAL is an optimization, not a boot requirement; treat an existing busy
  // journal mode as acceptable and let busy_timeout protect normal access.
  try { db.exec('PRAGMA journal_mode = WAL;'); } catch (error) {
    if (!/database is locked/i.test(String(error?.message || error))) throw error;
  }
}

export function withSettingsTransaction(db, operation) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

export function applySettingsMigrations(db, { clock = now } = {}) {
  configure(db);
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at TEXT NOT NULL,
    checksum TEXT NOT NULL
  );`);
  const applied = new Map(db.prepare('SELECT version, name, checksum FROM schema_migrations').all().map((row) => [row.version, row]));
  for (const migration of MIGRATIONS) {
    const previous = applied.get(migration.version);
    if (previous) {
      // The already-deployed v7 memory schema was introduced before the
      // migration label was finalized. Its tables are identical; retain that
      // deployed record instead of making service boot depend on a rename.
      if (migration.version === 7 && previous.name === 'memory-connections') continue;
      if (previous.name === migration.name && (previous.checksum === migration.checksum || LEGACY_MIGRATION_CHECKSUMS[migration.version]?.has(previous.checksum))) continue;
      throw new Error(`settings_migration_checksum_mismatch:${migration.version}`);
      continue;
    }
    withSettingsTransaction(db, () => {
      if (migration.apply) migration.apply(db);
      else db.exec(migration.body);
      // Multiple isolated test/CLI processes may initialize one empty settings
      // database concurrently. Migration bodies are idempotent; let the first
      // committer own the ledger row instead of failing the other initializer.
      db.prepare('INSERT OR IGNORE INTO schema_migrations (version,name,applied_at,checksum) VALUES (?,?,?,?)')
        .run(migration.version, migration.name, clock(), migration.checksum);
    });
  }
  return settingsMigrationStatus(db);
}

export function settingsMigrationStatus(db) {
  const applied = db.prepare('SELECT version,name,applied_at,checksum FROM schema_migrations ORDER BY version').all();
  return {
    currentVersion: MIGRATIONS.at(-1)?.version || 0,
    appliedVersion: applied.at(-1)?.version || 0,
    upToDate: applied.length === MIGRATIONS.length && applied.every((row, index) => {
      const migration = MIGRATIONS[index];
      // v7 shipped once under an earlier label with the identical schema.
      if (migration.version === 7 && row.name === 'memory-connections') return true;
      return row.version === migration.version && row.name === migration.name && (row.checksum === migration.checksum || LEGACY_MIGRATION_CHECKSUMS[migration.version]?.has(row.checksum));
    }),
    applied: applied.map((row) => ({ version: row.version, name: row.name, appliedAt: row.applied_at, checksum: row.checksum })),
  };
}

export function getSettingsMeta(db, key) {
  const row = db.prepare('SELECT value_json FROM settings_meta WHERE key=?').get(String(key));
  if (!row) return null;
  try { return JSON.parse(row.value_json); } catch { return null; }
}

export function setSettingsMeta(db, key, value, { clock = now } = {}) {
  const valueJson = JSON.stringify(value);
  db.prepare(`INSERT INTO settings_meta (key,value_json,updated_at) VALUES (?,?,?)
    ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
    .run(String(key), valueJson, clock());
  return value;
}

/**
 * Safe inspection/export foundation. This inventory deliberately excludes
 * ciphertext and plaintext secrets. It is not a backup or a generic import
 * format; those require a future operator-owned recovery surface.
 */
export function settingsOwnershipInventory(db) {
  const count = (table) => Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count || 0);
  return {
    schema: 'burrow.settings-ownership/v1',
    migration: settingsMigrationStatus(db),
    ownership: SETTINGS_OWNERSHIP,
    records: {
      modelConnections: count('model_connections'),
      modelConnectionSecretsConfigured: count('model_connection_secrets'),
      chatIdentities: count('chat_identities'),
      agents: count('agents'),
      runtimeSessionBindings: count('runtime_session_bindings'),
      runtimeRunBindings: count('runtime_run_bindings'),
      runtimeActiveTurns: count('runtime_active_turns'),
      scheduledJobs: count('scheduled_jobs'),
      scheduledJobRuns: count('scheduled_job_runs'),
      dreamDiaryEntries: count('dream_diary_entries'),
      dreamSettings: count('dream_settings'),
    },
  };
}

export function openSettingsDatabase({ databasePath } = {}) {
  const resolvedPath = databasePath || settingsDatabasePath();
  mkdirSync(path.dirname(resolvedPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(resolvedPath);
  chmodSync(resolvedPath, 0o600);
  applySettingsMigrations(db);
  return db;
}

export const __settingsDatabase = Object.freeze({ MIGRATIONS });
