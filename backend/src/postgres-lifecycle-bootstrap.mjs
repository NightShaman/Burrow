import path from 'node:path';
import { createPostgresPool, postgresConfig } from './postgres-foundation.mjs';
import { createPostgresLifecycle, createExternalPostgresLifecycle } from './postgres-lifecycle.mjs';

/**
 * Resolve the opt-in PostgreSQL process lifecycle without changing the current
 * PostgreSQL runtime default. The parent server owns the returned lifecycle and
 * must call closePostgresLifecycle during orderly shutdown.
 *
 * Modes: `managed` starts PostgreSQL 17 under the application user; `external`
 * only validates a supplied pool/client and never initializes or stops it.
 */
export function postgresLifecycleConfig({ env = process.env, runtimeRoot = env.BURROW_RUNTIME_ROOT || './.burrow' } = {}) {
  const mode = env.BURROW_POSTGRES_LIFECYCLE || env.BURROW_POSTGRES_MODE || 'disabled';
  if (!['disabled', 'managed', 'external'].includes(mode)) {
    throw new Error(`Unsupported BURROW_POSTGRES_LIFECYCLE mode "${mode}"`);
  }
  if (mode === 'disabled') return Object.freeze({ mode });
  const expectedMajor = Number(env.BURROW_POSTGRES_MAJOR || 17);
  if (!Number.isInteger(expectedMajor) || expectedMajor < 1) throw new Error('BURROW_POSTGRES_MAJOR must be a positive integer');
  const timeoutMs = Number(env.BURROW_POSTGRES_LIFECYCLE_TIMEOUT_MS || 30_000);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('BURROW_POSTGRES_LIFECYCLE_TIMEOUT_MS must be positive');
  if (mode === 'external') return Object.freeze({ mode, expectedMajor, timeoutMs, poolConfig: postgresConfig(env) });
  return Object.freeze({
    mode,
    expectedMajor,
    dataDir: path.resolve(env.BURROW_POSTGRES_DATA_DIR || path.join(runtimeRoot, 'postgres')),
    socketDir: path.resolve(env.BURROW_POSTGRES_SOCKET_DIR || path.join(runtimeRoot, 'postgres-socket')),
    logFile: path.resolve(env.BURROW_POSTGRES_LOG_FILE || path.join(runtimeRoot, 'postgres.log')),
    initdb: env.BURROW_POSTGRES_INITDB || 'initdb',
    pgCtl: env.BURROW_POSTGRES_PG_CTL || 'pg_ctl',
    postgres: env.BURROW_POSTGRES_BIN || 'postgres',
    timeoutMs,
  });
}

/** Build an explicitly selected lifecycle. Disabled mode returns null. */
export function createPostgresLifecycleFromEnv(options = {}) {
  const config = postgresLifecycleConfig(options);
  if (config.mode === 'disabled') return null;
  if (config.mode === 'external') {
    const query = options.query;
    if (!query && !options.pool && !options.client) throw new Error('External PostgreSQL lifecycle requires query or client');
    return createExternalPostgresLifecycle({ ...config, query, pool: options.pool, client: options.client, cancel: options.cancel });
  }
  return createPostgresLifecycle(config);
}

/** Start the selected lifecycle and return a small parent-owned handle. */
export async function startPostgresLifecycle(options = {}) {
  const lifecycle = options.lifecycle || createPostgresLifecycleFromEnv(options);
  if (!lifecycle) return Object.freeze({ enabled: false, lifecycle: null, close: async () => {} });
  await lifecycle.start();
  let closed = false;
  let closing;
  return Object.freeze({
    enabled: true,
    lifecycle,
    status: () => lifecycle.status(),
    async close() {
      if (closed) return;
      if (!closing) {
        closing = Promise.resolve().then(() => lifecycle.stop()).then(() => { closed = true; }).finally(() => { closing = undefined; });
      }
      await closing;
    },
  });
}

/**
 * Convenience boundary for a server parent: start PostgreSQL before invoking
 * `run`, and stop it even when startup or the server exits with an error.
 */
export async function withPostgresLifecycle(run, options = {}) {
  if (typeof run !== 'function') throw new TypeError('run must be a function');
  const handle = await startPostgresLifecycle(options);
  try { return await run(handle); } finally { await handle.close(); }
}

export { createPostgresPool };
