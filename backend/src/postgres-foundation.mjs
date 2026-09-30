import pg from 'pg';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { checkServerIdentity } from 'node:tls';

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
  // pg connection-string TLS options override the ssl object. Reject mixed
  // sources rather than silently losing CA or certificate verification.
  const tlsMode = env.BURROW_POSTGRES_SSL_MODE;
  if (tlsMode && !['disable', 'verify-full'].includes(tlsMode)) {
    throw new Error('BURROW_POSTGRES_SSL_MODE must be disable or verify-full');
  }
  if (connectionString && tlsMode) {
    let url;
    try { url = new URL(connectionString); } catch { throw new Error('Invalid PostgreSQL connection URL'); }
    if ([...url.searchParams.keys()].some((key) => /^ssl/i.test(key))) {
      throw new Error('Use BURROW_POSTGRES_SSL_MODE without URL ssl parameters');
    }
  }
  const caFile = env.BURROW_POSTGRES_SSL_CA_FILE;
  if (caFile && tlsMode !== 'verify-full') {
    throw new Error('BURROW_POSTGRES_SSL_CA_FILE requires verify-full');
  }
  if (tlsMode === 'disable') config.ssl = false;
  if (tlsMode === 'verify-full') {
    // node-postgres omits SNI for IP literals; Node then skips its default
    // hostname check. Pin verification to the configured destination explicitly.
    const hostname = connectionString ? new URL(connectionString).hostname.replace(/^\[|\]$/g, '') : config.host;
    config.ssl = { rejectUnauthorized: true, checkServerIdentity: (_servername, cert) => checkServerIdentity(hostname, cert) };
    if (caFile) {
      try { config.ssl.ca = readFileSync(caFile, 'utf8'); }
      catch { throw new Error('Unable to read BURROW_POSTGRES_SSL_CA_FILE'); }
      if (!config.ssl.ca.includes('-----BEGIN CERTIFICATE-----')) {
        throw new Error('BURROW_POSTGRES_SSL_CA_FILE must contain a PEM certificate');
      }
    }
  }
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
