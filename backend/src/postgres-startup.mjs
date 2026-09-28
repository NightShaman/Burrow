import { promises as fs } from 'node:fs';
import path from 'node:path';
import { userInfo } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createPostgresPool, postgresConfig, postgresTransactionContext, withPostgresTransaction } from './postgres-foundation.mjs';
import { postgresLifecycleConfig, startPostgresLifecycle } from './postgres-lifecycle-bootstrap.mjs';
import { migratePostgres } from './postgres-migrations.mjs';
import { runPostgresCutover } from './postgres-cutover.mjs';

async function exists(file) { try { await fs.stat(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }

/** Read-only discovery of the current canonical layout. Noncanonical layouts require a manifest. */
export async function discoverPostgresSources({ env = process.env } = {}) {
  if (env.BURROW_POSTGRES_IMPORT_MANIFEST) return JSON.parse(await fs.readFile(env.BURROW_POSTGRES_IMPORT_MANIFEST, 'utf8'));
  if (env.BURROW_AGENT_WORKSPACE_ROOT) throw new Error('postgres_discovery_custom_agent_root_requires_manifest');
  const root = path.resolve(env.BURROW_RUNTIME_ROOT || './.burrow');
  const settings = path.resolve(env.BURROW_SETTINGS_DB || path.join(root, 'config/settings.sqlite'));
  const workspace = path.resolve(env.BURROW_WORKSPACE_ROOT || path.join(root, 'workspace'));
  const conversations = [];
  const auxiliary = [];
  let agentRoots = 0;
  // Include orphaned agent directories: silently omitting legacy sessions is not safe.
  for (const entry of await fs.readdir(workspace, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
    if (entry.isSymbolicLink()) throw new Error('postgres_discovery_symlink_requires_manifest');
    if (!entry.isDirectory()) continue;
    agentRoots++;
    const home = path.join(workspace, entry.name);
    if (await exists(path.join(home, 'sessions'))) conversations.push({ agentId: entry.name, rootDir: home });
    for (const name of ['continuity-handoffs.sqlite', 'forge.sqlite']) if (await exists(path.join(home, name))) auxiliary.push(path.join(home, name));
  }
  for (const name of ['forge.sqlite', 'continuity-handoffs.sqlite']) if (await exists(path.join(root, name))) auxiliary.push(path.join(root, name));
  if (!await exists(settings)) {
    // Native installs explicitly set this canonical path even before any SQLite database exists.
    // A different configured path is not evidence of a fresh installation.
    if (settings !== path.join(root, 'config/settings.sqlite') || agentRoots || auxiliary.length) throw new Error('postgres_discovery_missing_settings_source');
    return null;
  }
  const db = new DatabaseSync(settings, { readOnly: true });
  try {
    // Validate identities without opening a writable legacy store or applying SQLite migrations.
    const ids = new Set(db.prepare('SELECT id FROM agents').all().map(row => row.id));
    for (const c of conversations) if (!ids.has(c.agentId)) throw new Error(`postgres_discovery_unknown_agent:${c.agentId}`);
  } finally { db.close(); }
  return { migrationId: 'burrow-postgres-cutover-v1', settings: { path: settings }, conversations: conversations.sort((a,b) => a.agentId.localeCompare(b.agentId)), ...(auxiliary.length ? { auxiliary: auxiliary.sort().map(path => ({ path })) } : {}) };
}

/** Start, initialize schema, and atomically import before the caller can launch a server. */
export async function preparePostgresStartup({ env = process.env } = {}) {
  const config = postgresLifecycleConfig({ env });
  if (config.mode === 'disabled') throw new Error('postgres_startup_requires_explicit_lifecycle');
  const childEnv = { ...env, BURROW_UI_POSTGRES: '1' };
  if (config.mode === 'managed') {
    // initdb creates the operating-system role and postgres database; TCP is disabled.
    delete childEnv.BURROW_POSTGRES_URL; delete childEnv.DATABASE_URL;
    childEnv.BURROW_POSTGRES_HOST = config.socketDir;
    childEnv.BURROW_POSTGRES_PORT = '5432';
    childEnv.BURROW_POSTGRES_DATABASE = 'postgres';
    childEnv.BURROW_POSTGRES_USER = userInfo().username;
    delete childEnv.BURROW_POSTGRES_PASSWORD;
  }
  const pool = createPostgresPool({ config: postgresConfig(childEnv) });
  let handle;
  try {
    handle = await startPostgresLifecycle({ env, query: pool.query.bind(pool) });
    await migratePostgres(pool);
    // An explicit manifest selects its own migration identity, not the default receipt.
    // Reading this configuration is distinct from discovering/reading legacy sources.
    const explicit = env.BURROW_POSTGRES_IMPORT_MANIFEST
      ? JSON.parse(await fs.readFile(env.BURROW_POSTGRES_IMPORT_MANIFEST, 'utf8')) : null;
    const migrationId = explicit?.migrationId || 'burrow-postgres-cutover-v1';
    const result = await withPostgresTransaction(pool, async client => {
      // Serialize receipt selection, source discovery and first import with cutover's lock.
      // A racing startup must see the committed fresh/import receipt before inspecting SQLite.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('burrow-cutover',0))");
      const prior = await client.query('SELECT result FROM burrow_migration_receipts WHERE migration_id=$1', [migrationId]);
      if (prior.rowCount) return { ...prior.rows[0].result, repeated: true };
      const manifest = explicit || await discoverPostgresSources({ env });
      if (manifest) return runPostgresCutover(postgresTransactionContext(client), manifest);
      const fresh = { fresh: true };
      await client.query('INSERT INTO burrow_migration_receipts(migration_id,manifest,fingerprint,completed_at,result) VALUES($1,$2::jsonb,$3,$4,$5::jsonb)',
        [migrationId, JSON.stringify({ migrationId, fresh: true }), 'fresh', new Date().toISOString(), JSON.stringify(fresh)]);
      return fresh;
    });
    await pool.end();
    return { env: childEnv, result, close: () => handle.close() };
  } catch (error) {
    await pool.end().catch(() => {});
    if (handle) await handle.close().catch(() => {});
    throw error;
  }
}
