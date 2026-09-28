import pg from 'pg';
import { createHash } from 'node:crypto';

const { Pool } = pg;

function positiveInteger(value, fallback) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error('PostgreSQL pool settings must be positive integers');
  return parsed;
}

/** Resolve PostgreSQL settings without ever including the password in returned diagnostics. */
export function postgresConfig(env = process.env) {
  const connectionString = env.BURROW_POSTGRES_URL || env.DATABASE_URL;
  const config = connectionString
    ? { connectionString }
    : {
        host: env.BURROW_POSTGRES_HOST || '127.0.0.1',
        port: Number(env.BURROW_POSTGRES_PORT || 5432),
        database: env.BURROW_POSTGRES_DATABASE || 'burrow',
        user: env.BURROW_POSTGRES_USER || 'burrow',
        password: env.BURROW_POSTGRES_PASSWORD,
      };
  const max = positiveInteger(env.BURROW_POSTGRES_POOL_MAX, 10);
  const idleTimeoutMillis = positiveInteger(env.BURROW_POSTGRES_IDLE_TIMEOUT_MS, 30_000);
  const connectionTimeoutMillis = positiveInteger(env.BURROW_POSTGRES_CONNECTION_TIMEOUT_MS, 10_000);
  return Object.freeze({ ...config, max, idleTimeoutMillis, connectionTimeoutMillis });
}

export function createPostgresPool({ config = postgresConfig(), PoolClass = Pool } = {}) {
  return new PoolClass(config);
}

const transactionClients = new WeakMap();
let savepointSequence = 0;
/** Explicit borrowed transaction context; nested operations cannot commit the owner. */
export function postgresTransactionContext(client) {
  if (!client?.query) throw new TypeError('postgres_transaction_client_required');
  const context = Object.freeze({ connect: async () => client });
  transactionClients.set(context, client);
  return context;
}

/** Run statements on one checked-out client; nested contexts use savepoints. */
export async function withPostgresTransaction(pool, work) {
  if (transactionClients.has(pool)) {
    const client = transactionClients.get(pool);
    const name = `burrow_nested_${++savepointSequence}`;
    await client.query(`SAVEPOINT ${name}`);
    try {
      const result = await work(client);
      await client.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      try { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); await client.query(`RELEASE SAVEPOINT ${name}`); } catch { /* outer transaction owns cleanup */ }
      throw error;
    }
  }
  const client = await pool.connect();
  let discard = false;
  try {
    await client.query('BEGIN');
    try {
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      throw error;
    }
  } finally {
    // Failed rollback makes session state unknowable; discard rather than reuse.
    client.release(discard);
  }
}

export async function closePostgresPool(pool) {
  if (pool && typeof pool.end === 'function') await pool.end();
}

export function postgresConfigSummary(config) {
  return Object.freeze({
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    poolMax: config.max,
  });
}

export function migrationChecksum(sql) {
  return createHash('sha256').update(sql).digest('hex');
}

export function migrationLockKey(namespace = 'burrow-schema') {
  const bytes = createHash('sha256').update(namespace).digest();
  return bytes.readBigInt64BE(0).toString();
}
