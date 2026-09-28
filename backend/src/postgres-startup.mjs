import { promises as fs } from 'node:fs';
import path from 'node:path';
import { userInfo } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createPostgresPool, postgresConfig } from './postgres-foundation.mjs';
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
  // Include orphaned agent directories: silently omitting legacy sessions is not safe.
  for (const entry of await fs.readdir(workspace, { withFileTypes: true }).catch(e => { if (e.code === 'ENOENT') return []; throw e; })) {
    if (entry.isSymbolicLink()) throw new Error('postgres_discovery_symlink_requires_manifest');
    if (!entry.isDirectory()) continue;
    const home = path.join(workspace, entry.name);
    if (await exists(path.join(home, 'sessions'))) conversations.push({ agentId: entry.name, rootDir: home });
    for (const name of ['continuity-handoffs.sqlite', 'forge.sqlite']) if (await exists(path.join(home, name))) auxiliary.push(path.join(home, name));
  }
  for (const name of ['forge.sqlite', 'continuity-handoffs.sqlite']) if (await exists(path.join(root, name))) auxiliary.push(path.join(root, name));
  if (!await exists(settings)) {
    if (env.BURROW_SETTINGS_DB || conversations.length || auxiliary.length) throw new Error('postgres_discovery_missing_settings_source');
    return null;
  }
  const db = new DatabaseSync(settings, { readOnly: true });
  try {
    // Validate identities without opening a writable legacy store or applying SQLite migrations.
    const ids = new Set(db.prepare('SELECT id FROM agents').all().map(row => row.id));
    for (const c of conversations) if (!ids.has(c.agentId)) throw new Error(`postgres_discovery_unknown_agent:${c.agentId}`);
  } finally { db.close(); }
  if (auxiliary.length > 1) throw new Error('postgres_discovery_multiple_auxiliary_sources_require_manifest');
  return { migrationId: 'burrow-postgres-cutover-v1', settings: { path: settings }, conversations: conversations.sort((a,b) => a.agentId.localeCompare(b.agentId)), ...(auxiliary.length ? { auxiliary: { path: auxiliary[0] } } : {}) };
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
    let manifest = await discoverPostgresSources({ env });
    // A removed source must not turn a completed migration into a fresh installation.
    const prior = await pool.query('SELECT manifest FROM burrow_migration_receipts WHERE migration_id=$1', ['burrow-postgres-cutover-v1']);
    if (!manifest && prior.rowCount) manifest = prior.rows[0].manifest;
    const result = manifest ? await runPostgresCutover(pool, manifest) : { fresh: true };
    await pool.end();
    return { env: childEnv, result, close: () => handle.close() };
  } catch (error) {
    await pool.end().catch(() => {});
    if (handle) await handle.close().catch(() => {});
    throw error;
  }
}
