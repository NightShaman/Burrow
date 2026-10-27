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

export function createPostgresPool({ config = postgresConfig(), PoolClass = Pool, onIdleError = detail => console.error("PostgreSQL idle connection lost; replacement on next checkout", detail) } = {}) {
  const pool = new PoolClass({ ...config, types: { getTypeParser(oid, format) {
    if (oid === 1184 && format !== 'binary') return value => new Date(value).toISOString();
    return pg.types.getTypeParser(oid, format);
  } } });
  // pg removes the broken idle client before emitting this event. Keep the pool
  // available: subsequent checkout reconnects through the driver, while normal
  // query failures remain visible to callers. Never log raw driver diagnostics.
  pool.on('error', () => {
    try { onIdleError({ event: 'postgres_idle_connection_lost', recovery: 'replace_on_next_checkout' }); }
    catch { /* diagnostics must not convert recoverable loss into process failure */ }
  });
  return pool;
}

const transactionClients = new WeakMap();
let savepointSequence = 0;
/** Explicit borrowed transaction context; nested operations cannot commit the owner. */
export function postgresTransactionContext(client) {
  if (!client?.query) throw new TypeError('postgres_transaction_client_required');
  const context = Object.freeze({ get query() { return (...args) => client.query(...args); }, get connect() { return async () => client; } });
  transactionClients.set(context, client);
  return context;
}

/** Run statements on one checked-out client; nested contexts use savepoints. */
async function acquireTransactionClient(pool, { deadline, signal } = {}) {
  signal?.throwIfAborted();
  if (deadline === undefined && !signal) return pool.connect();
  let stopped = false;
  let timer;
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => { stopped = true; reject(signal.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    if (deadline !== undefined) timer = setTimeout(() => {
      stopped = true;
      reject(new Error('history_query_budget_exceeded'));
    }, Math.max(0, deadline - performance.now()));
  });
  // The driver cannot remove a queued checkout. Its eventual client remains
  // owned here, never by the cancelled caller, and is returned without BEGIN.
  const checkout = Promise.resolve().then(() => pool.connect()).then(client => {
    if (stopped) { client.release(); return; }
    return client;
  });
  try { return await Promise.race([checkout, cancelled]); }
  finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

// PostgreSQL may keep executing after a client socket closes (e.g. a lock
// wait or pg_sleep). Send the driver's protocol CancelRequest to this exact
// backend, then let its query reject and transaction rollback before release.
// No pool checkout is needed, so cancellation also works with an exhausted pool.
function cancelOwnedQuery(client) {
  const query = client.activeQuery;
  if (!query || !client.connectionParameters) return Promise.resolve();
  return new Promise(resolve => {
    const canceller = new pg.Client({ ...client.connectionParameters, ssl: false });
    const connection = canceller.connection;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true; clearTimeout(timer); connection.stream?.destroy(); resolve();
    };
    // Failure to deliver cancellation never detaches the original query. Its
    // owner still waits for query settlement and cannot commit after abort.
    const timer = setTimeout(finish, 10_000);
    connection.once('error', finish); connection.once('end', finish);
    try { canceller.cancel(client, query); } catch { finish(); }
  });
}

function cancellableTransactionClient(client, signal) {
  if (!signal) return client;
  return new Proxy(client, { get(target, key) {
    if (key === 'query') return (...args) => {
      signal.throwIfAborted();
      return target.query(...args);
    };
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
}

export async function withPostgresTransaction(pool, work, acquisition = {}) {
  if (transactionClients.has(pool)) {
    const client = transactionClients.get(pool);
    acquisition.signal?.throwIfAborted();
    const name = `burrow_nested_${++savepointSequence}`;
    await client.query(`SAVEPOINT ${name}`);
    try {
      const result = await work(cancellableTransactionClient(client, acquisition.signal));
      acquisition.signal?.throwIfAborted();
      await client.query(`RELEASE SAVEPOINT ${name}`);
      return result;
    } catch (error) {
      try { await client.query(`ROLLBACK TO SAVEPOINT ${name}`); await client.query(`RELEASE SAVEPOINT ${name}`); } catch { /* outer transaction owns cleanup */ }
      throw error;
    }
  }
  const client = await acquireTransactionClient(pool, acquisition);
  const signal = acquisition.signal;
  let discard = false;
  // Only the owner of a dedicated checkout may cancel its active query.
  let cancellation = Promise.resolve();
  const abort = () => { discard = true; cancellation = cancelOwnedQuery(client); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    signal?.throwIfAborted();
    await client.query('BEGIN');
    try {
      signal?.throwIfAborted();
      const result = await work(cancellableTransactionClient(client, acquisition.signal));
      signal?.throwIfAborted();
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await cancellation;
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      signal?.throwIfAborted();
      throw error;
    }
  } catch (error) {
    signal?.throwIfAborted();
    throw error;
  } finally {
    signal?.removeEventListener('abort', abort);
    await cancellation;
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

// Normalize driver-native instants at the store boundary, including borrowed pools.
// Do not alter JSON payloads or mutate the caller's pool/type parser configuration.
const normalizedPools = new WeakMap();
export function normalizePostgresPool(pool) {
  if (!pool || normalizedPools.has(pool)) return normalizedPools.get(pool) || pool;
  const result = value => {
    if (Array.isArray(value)) return value.map(result);
    if (value?.rows) return { ...value, rows: value.rows.map(row => Object.fromEntries(Object.entries(row).map(([key, item]) => [key, item instanceof Date ? item.toISOString() : item]))) };
    return value;
  };
  const proxy = new Proxy(pool, { get(target, key) {
    if (key === 'query') return (...args) => {
      if (typeof args.at(-1) === 'function') {
        const callback = args.pop();
        return target.query(...args, (error, value) => callback(error, result(value)));
      }
      const value = target.query(...args);
      return value?.then ? value.then(result) : value;
    };
    if (key === 'connect') return async (...args) => normalizePostgresPool(await target.connect(...args));
    const value = Reflect.get(target, key, target);
    return typeof value === 'function' ? value.bind(target) : value;
  } });
  if (transactionClients.has(pool)) transactionClients.set(proxy, transactionClients.get(pool));
  normalizedPools.set(pool, proxy);
  normalizedPools.set(proxy, proxy);
  return proxy;
}
