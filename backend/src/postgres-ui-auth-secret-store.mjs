import { normalizePostgresPool } from './postgres-foundation.mjs';
import { randomUUID } from 'node:crypto';
import { closePostgresPool, withPostgresTransaction } from './postgres-foundation.mjs';
import { settingsKeyFromEnvironment } from './model-settings-store.mjs';
import { encryptUiAuthSecret, decryptUiAuthSecret, OIDC_CLIENT_SECRET_NAME } from './ui-auth-secrets.mjs';

export const POSTGRES_UI_AUTH_SECRET_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS ui_auth_secrets (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, ciphertext BYTEA NOT NULL, nonce BYTEA NOT NULL,
 auth_tag BYTEA NOT NULL, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);`;

const now = () => new Date().toISOString();
export class PostgresUiAuthSecretStore {
  constructor({ pool, key, encryptionKey, clock = now, ownsPool = false } = {}) {
    if (!pool) throw new Error('pool_required');
    this.pool = normalizePostgresPool(pool); this.key = key || encryptionKey || settingsKeyFromEnvironment(); this.clock = clock; this.ownsPool = ownsPool;
    if (!Buffer.isBuffer(this.key) || this.key.length !== 32) throw new Error('settings_encryption_key_invalid');
  }
  async close() { if (this.ownsPool) await closePostgresPool(this.pool); }
  async get(name = OIDC_CLIENT_SECRET_NAME) {
    const { rows } = await this.pool.query('SELECT * FROM ui_auth_secrets WHERE name=$1', [name]);
    return rows[0] ? decryptUiAuthSecret(this.key, rows[0]) : null;
  }
  async has(name = OIDC_CLIENT_SECRET_NAME) {
    const { rowCount } = await this.pool.query('SELECT 1 FROM ui_auth_secrets WHERE name=$1', [name]);
    return rowCount > 0;
  }
  async set(name = OIDC_CLIENT_SECRET_NAME, value) {
    return withPostgresTransaction(this.pool, async (client) => {
      const timestamp = this.clock();
      const candidateId = randomUUID();
      let sealed = encryptUiAuthSecret(this.key, candidateId, name, value);
      const inserted = await client.query(`INSERT INTO ui_auth_secrets(id,name,ciphertext,nonce,auth_tag,created_at,updated_at)
        VALUES($1,$2,$3,$4,$5,$6,$6) ON CONFLICT(name) DO NOTHING RETURNING id`,
        [candidateId, name, sealed.ciphertext, sealed.nonce, sealed.authTag, timestamp]);
      let id = inserted.rows[0]?.id;
      if (!id) {
        const existing = await client.query('SELECT id FROM ui_auth_secrets WHERE name=$1 FOR UPDATE', [name]);
        id = existing.rows[0]?.id;
        if (!id) throw new Error('ui_auth_secret_write_conflict');
        sealed = encryptUiAuthSecret(this.key, id, name, value);
        await client.query('UPDATE ui_auth_secrets SET ciphertext=$1,nonce=$2,auth_tag=$3,updated_at=$4 WHERE id=$5', [sealed.ciphertext, sealed.nonce, sealed.authTag, timestamp, id]);
      }
      return id;
    });
  }
}
export default PostgresUiAuthSecretStore;
