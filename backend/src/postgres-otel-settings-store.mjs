import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { normalizePostgresPool, closePostgresPool, withPostgresTransaction } from './postgres-foundation.mjs';
import { settingsKeyFromEnvironment } from './model-settings-store.mjs';
import { mergeDestination, normalizeDestination } from './otel-destinations.mjs';

const ROW_ID = 'operator';
const AAD = Buffer.from('burrow-opentelemetry-settings-v1|operator|headers');

export const POSTGRES_OTEL_SETTINGS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS opentelemetry_settings (
  id TEXT PRIMARY KEY CHECK (id='operator'),
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  endpoint TEXT NOT NULL DEFAULT '',
  headers_ciphertext BYTEA,
  headers_nonce BYTEA,
  headers_auth_tag BYTEA,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT opentelemetry_settings_headers_complete CHECK (
    (headers_ciphertext IS NULL AND headers_nonce IS NULL AND headers_auth_tag IS NULL)
    OR (headers_ciphertext IS NOT NULL AND headers_nonce IS NOT NULL AND headers_auth_tag IS NOT NULL)
  )
);`;

// Forward-only migration. Version 60 above is immutable.
export const POSTGRES_OTEL_DESTINATIONS_SCHEMA_SQL = `
ALTER TABLE opentelemetry_settings ADD COLUMN destinations_authoritative BOOLEAN NOT NULL DEFAULT FALSE;
CREATE TABLE opentelemetry_destinations (
  id TEXT PRIMARY KEY,
  position INTEGER NOT NULL UNIQUE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  enabled BOOLEAN NOT NULL,
  endpoint TEXT NOT NULL,
  traces_endpoint TEXT NOT NULL,
  metrics_endpoint TEXT NOT NULL,
  protocol TEXT NOT NULL,
  traces_enabled BOOLEAN NOT NULL,
  metrics_enabled BOOLEAN NOT NULL,
  metrics_temporality TEXT NOT NULL,
  connection JSONB NOT NULL,
  tls_verify BOOLEAN NOT NULL,
  secrets_ciphertext BYTEA NOT NULL,
  secrets_nonce BYTEA NOT NULL,
  secrets_auth_tag BYTEA NOT NULL
);`;

function seal(key, value, aad = AAD) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}

function open(key, row, aad = AAD) {
  if (!row?.headers_ciphertext) return null;
  const decipher = createDecipheriv('aes-256-gcm', key, row.headers_nonce);
  decipher.setAAD(aad);
  decipher.setAuthTag(row.headers_auth_tag);
  return Buffer.concat([decipher.update(row.headers_ciphertext), decipher.final()]).toString('utf8');
}

const destinationAAD = (id) => Buffer.from(`burrow-opentelemetry-destination-v1|operator|${id}|secrets`);
const now = () => new Date().toISOString();

export class PostgresOtelSettingsStore {
  constructor({ pool, key, encryptionKey, clock = now, ownsPool = false } = {}) {
    if (!pool) throw new Error('pool_required');
    this.pool = normalizePostgresPool(pool);
    this.key = key || encryptionKey || settingsKeyFromEnvironment();
    this.clock = clock;
    this.ownsPool = ownsPool;
    if (!Buffer.isBuffer(this.key) || this.key.length !== 32) throw new Error('settings_encryption_key_invalid');
  }

  async close() { if (this.ownsPool) await closePostgresPool(this.pool); }

  // Single query produces a consistent snapshot even during concurrent list replacement.
  async readWith(client) {
    const { rows } = await client.query(`SELECT s.*, d.id AS destination_id, d.position AS destination_position,
      d.name AS destination_name, d.provider AS destination_provider, d.enabled AS destination_enabled,
      d.endpoint AS destination_endpoint, d.traces_endpoint, d.metrics_endpoint, d.protocol,
      d.traces_enabled, d.metrics_enabled, d.metrics_temporality, d.connection, d.tls_verify,
      d.secrets_ciphertext, d.secrets_nonce, d.secrets_auth_tag
      FROM opentelemetry_settings s LEFT JOIN opentelemetry_destinations d ON s.destinations_authoritative
      WHERE s.id=$1 ORDER BY d.position`, [ROW_ID]);
    const row = rows[0];
    if (!row) return null;
    try {
      if (!row.destinations_authoritative) return { enabled: row.enabled === true, endpoint: String(row.endpoint || ''), headers: open(this.key, row) };
      const destinations = rows.filter((entry) => entry.destination_id).map((entry) => {
        const secrets = JSON.parse(open(this.key, { headers_ciphertext: entry.secrets_ciphertext, headers_nonce: entry.secrets_nonce, headers_auth_tag: entry.secrets_auth_tag }, destinationAAD(entry.destination_id)));
        return { id: entry.destination_id, name: entry.destination_name, provider: entry.destination_provider, enabled: entry.destination_enabled,
          endpoint: entry.destination_endpoint, tracesEndpoint: entry.traces_endpoint, metricsEndpoint: entry.metrics_endpoint,
          protocol: entry.protocol, tracesEnabled: entry.traces_enabled, metricsEnabled: entry.metrics_enabled,
          metricsTemporality: entry.metrics_temporality, connection: entry.connection, tls: { verify: entry.tls_verify },
          headers: secrets.headers || null, credentials: secrets.credentials || {} };
      });
      return { enabled: row.enabled === true, endpoint: destinations[0]?.endpoint || '', headers: destinations[0]?.headers || null, destinations };
    } catch { throw new Error('opentelemetry_headers_unavailable'); }
  }

  async read() { return this.readWith(this.pool); }

  /** Serialize read/validate/merge/write under one lock, including legacy writers. */
  async update(mutate) {
    return withPostgresTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['opentelemetry-settings:operator']);
      const current = await this.readWith(client);
      const next = await mutate(current);
      const authoritative = Array.isArray(next.destinations);
      const encrypted = !authoritative && next.headers ? seal(this.key, next.headers) : null;
      const timestamp = this.clock();
      await client.query(`INSERT INTO opentelemetry_settings(
          id,enabled,endpoint,headers_ciphertext,headers_nonce,headers_auth_tag,created_at,updated_at,destinations_authoritative
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$7,$8)
        ON CONFLICT(id) DO UPDATE SET enabled=EXCLUDED.enabled,endpoint=EXCLUDED.endpoint,
          headers_ciphertext=EXCLUDED.headers_ciphertext,headers_nonce=EXCLUDED.headers_nonce,
          headers_auth_tag=EXCLUDED.headers_auth_tag,updated_at=EXCLUDED.updated_at,destinations_authoritative=EXCLUDED.destinations_authoritative`,
      [ROW_ID, next.enabled === true, authoritative ? '' : String(next.endpoint || ''), encrypted?.ciphertext || null, encrypted?.nonce || null, encrypted?.authTag || null, timestamp, authoritative]);
      await client.query('DELETE FROM opentelemetry_destinations');
      if (authoritative) for (let position = 0; position < next.destinations.length; position += 1) {
        const destination = next.destinations[position];
        const secret = seal(this.key, JSON.stringify({ headers: destination.headers || null, credentials: destination.credentials || {} }), destinationAAD(destination.id));
        await client.query(`INSERT INTO opentelemetry_destinations (id,position,name,provider,enabled,endpoint,traces_endpoint,metrics_endpoint,protocol,
          traces_enabled,metrics_enabled,metrics_temporality,connection,tls_verify,secrets_ciphertext,secrets_nonce,secrets_auth_tag)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [destination.id, position, destination.name, destination.provider, destination.enabled, destination.endpoint, destination.tracesEndpoint,
          destination.metricsEndpoint, destination.protocol, destination.tracesEnabled, destination.metricsEnabled, destination.metricsTemporality,
          JSON.stringify(destination.connection), destination.tls.verify, secret.ciphertext, secret.nonce, secret.authTag]);
      }
      return next;
    });
  }

  async write({ enabled, endpoint, headers } = {}) {
    return this.update((current) => {
      if (Array.isArray(current?.destinations)) {
        if (current.destinations.length > 1) throw new Error('opentelemetry_legacy_ambiguous');
        if (!current.destinations.length) {
          const fresh = normalizeDestination({ id: 'default', name: 'Default', provider: 'custom', enabled: Boolean(endpoint), endpoint: String(endpoint || ''), protocol: 'http/json', ...(headers ? { headers } : {}) });
          return { enabled: enabled === true, destinations: [mergeDestination(fresh)] };
        }
        const previous = current.destinations[0];
        if (previous.provider !== 'custom' || previous.tracesEndpoint || previous.metricsEndpoint || previous.protocol !== 'http/json' || !previous.tracesEnabled || !previous.metricsEnabled || !previous.tls.verify || Object.keys(previous.connection || {}).length || Object.values(previous.credentials || {}).some(Boolean)) throw new Error('opentelemetry_legacy_ambiguous');
        const destination = mergeDestination({ ...previous, enabled: Boolean(endpoint), endpoint: String(endpoint || ''), ...(headers === undefined ? { headers: undefined } : headers === null ? { headers: undefined, clearHeaders: true } : { headers }), credentials: undefined }, previous);
        return { enabled: enabled === true, destinations: [destination] };
      }
      return { enabled: enabled === true, endpoint: String(endpoint || ''), headers: headers === undefined ? current?.headers || null : headers };
    });
  }

}

export const __postgresOtelSettingsStore__ = Object.freeze({ ROW_ID, seal, open, destinationAAD });
export default PostgresOtelSettingsStore;
