import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { normalizePostgresPool, closePostgresPool, withPostgresTransaction } from './postgres-foundation.mjs';
import { settingsKeyFromEnvironment } from './model-settings-store.mjs';

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

function seal(key, value) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(AAD);
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}

function open(key, row) {
  if (!row?.headers_ciphertext) return null;
  const decipher = createDecipheriv('aes-256-gcm', key, row.headers_nonce);
  decipher.setAAD(AAD);
  decipher.setAuthTag(row.headers_auth_tag);
  return Buffer.concat([decipher.update(row.headers_ciphertext), decipher.final()]).toString('utf8');
}

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

  async read() {
    const { rows } = await this.pool.query('SELECT * FROM opentelemetry_settings WHERE id=$1', [ROW_ID]);
    const row = rows[0];
    if (!row) return null;
    try { return { enabled: row.enabled === true, endpoint: String(row.endpoint || ''), headers: open(this.key, row) }; }
    catch { throw new Error('opentelemetry_headers_unavailable'); }
  }

  async write({ enabled, endpoint, headers } = {}) {
    return withPostgresTransaction(this.pool, async (client) => {
      const timestamp = this.clock();
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', ['opentelemetry-settings:operator']);
      let existingHeaders = null;
      if (headers === undefined) {
        const existing = await client.query('SELECT * FROM opentelemetry_settings WHERE id=$1 FOR UPDATE', [ROW_ID]);
        try { existingHeaders = existing.rows[0] ? open(this.key, existing.rows[0]) : null; }
        catch { throw new Error('opentelemetry_headers_unavailable'); }
      }
      const effectiveHeaders = headers === undefined ? existingHeaders : headers;
      const encrypted = effectiveHeaders ? seal(this.key, effectiveHeaders) : null;
      await client.query(`INSERT INTO opentelemetry_settings(
          id,enabled,endpoint,headers_ciphertext,headers_nonce,headers_auth_tag,created_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$7)
        ON CONFLICT(id) DO UPDATE SET enabled=EXCLUDED.enabled,endpoint=EXCLUDED.endpoint,
          headers_ciphertext=EXCLUDED.headers_ciphertext,headers_nonce=EXCLUDED.headers_nonce,
          headers_auth_tag=EXCLUDED.headers_auth_tag,updated_at=EXCLUDED.updated_at`,
      [ROW_ID, enabled === true, String(endpoint || ''), encrypted?.ciphertext || null, encrypted?.nonce || null, encrypted?.authTag || null, timestamp]);
      return { enabled: enabled === true, endpoint: String(endpoint || ''), headers: effectiveHeaders || null };
    });
  }
}

export const __postgresOtelSettingsStore__ = Object.freeze({ ROW_ID, seal, open });
export default PostgresOtelSettingsStore;
