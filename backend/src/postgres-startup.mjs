import { closePostgresWithRetry } from './postgres-cleanup.mjs';
import { userInfo } from 'node:os';
import { createPostgresPool, postgresConfig } from './postgres-foundation.mjs';
import { postgresLifecycleConfig, startPostgresLifecycle } from './postgres-lifecycle-bootstrap.mjs';
import { migratePostgres } from './postgres-migrations.mjs';

/** Resolve the exact runtime destination without starting or mutating PostgreSQL. */
export function resolvePostgresRuntimeEnv({ env = process.env, runtimeRoot } = {}) {
  const config = postgresLifecycleConfig({ env, ...(runtimeRoot ? { runtimeRoot } : {}) });
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
  return childEnv;
}

/** Initialize PostgreSQL before launching the server. Never discover or import local databases. */
export async function preparePostgresStartup({ env = process.env } = {}) {
  const config = postgresLifecycleConfig({ env });
  if (config.mode === 'disabled') throw new Error('postgres_startup_requires_explicit_lifecycle');
  const childEnv = resolvePostgresRuntimeEnv({ env });
  const pool = createPostgresPool({ config: postgresConfig(childEnv) });
  const cleanup = { budgetMs: Number(env.BURROW_POSTGRES_CLEANUP_BUDGET_MS || 60_000) };
  let handle;
  try {
    handle = await startPostgresLifecycle({ env, pool });
    await migratePostgres(pool);
    const result = { initialized: true };
    await pool.end();
    return { env: childEnv, result, close: () => closePostgresWithRetry(handle, cleanup) };
  } catch (error) {
    await pool.end().catch(() => {});
    handle ||= error.postgresLifecycleHandle;
    if (handle) {
      try { await closePostgresWithRetry(handle, cleanup); }
      catch (cleanupError) {
        const failure = new AggregateError([error, cleanupError], 'Startup failed and PostgreSQL cleanup requires operator recovery');
        failure.postgresLifecycleHandle = handle;
        throw failure;
      }
    }
    throw error;
  }
}
