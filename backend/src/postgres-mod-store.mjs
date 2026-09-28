import { closePostgresPool } from './postgres-foundation.mjs';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { settingsKeyFromEnvironment } from './model-settings-store.mjs';

export const POSTGRES_MOD_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS mod_settings (
  mod_id TEXT NOT NULL, name TEXT NOT NULL, value_json TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (mod_id,name)
);
CREATE TABLE IF NOT EXISTS mod_secrets (
  mod_id TEXT NOT NULL, name TEXT NOT NULL, ciphertext BYTEA NOT NULL,
  nonce BYTEA NOT NULL, auth_tag BYTEA NOT NULL, created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY (mod_id,name)
);
CREATE TABLE IF NOT EXISTS mod_lifecycle (
 mod_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
`;

const AAD_PREFIX = 'burrow-mod-secret-v1';
const now = () => new Date().toISOString();
const aad = (modId, name) => Buffer.from(`${AAD_PREFIX}|${modId}|${name}`);
function seal(key, modId, name, value) {
  const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(modId, name));
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}
function open(key, modId, name, row) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(row.nonce));
  decipher.setAAD(aad(modId, name)); decipher.setAuthTag(Buffer.from(row.auth_tag));
  return Buffer.concat([decipher.update(Buffer.from(row.ciphertext)), decipher.final()]).toString('utf8');
}

export class PostgresModSettingsStore {
  constructor({ modId, pool, key = settingsKeyFromEnvironment(), ownsPool = false, clock = now } = {}) {
    this.modId = String(modId || '').trim();
    if (!this.modId) throw new Error('mod_id_required');
    if (!pool?.query || !pool?.connect) throw new Error('mod_settings_postgres_pool_required');
    if (!Buffer.isBuffer(key) || key.length !== 32) throw new Error('settings_encryption_key_invalid');
    this.pool = pool; this.key = key; this.ownsPool = ownsPool; this.clock = clock;
  }
  async close() { if (this.ownsPool) await closePostgresPool(this.pool); }
  async get(name, fallback = null) {
    const result = await this.pool.query('SELECT value_json FROM mod_settings WHERE mod_id=$1 AND name=$2', [this.modId, String(name)]);
    if (!result.rows[0]) return fallback;
    try { return JSON.parse(result.rows[0].value_json); } catch { return fallback; }
  }
  async set(name, value) {
    const stamp = this.clock();
    await this.pool.query(`INSERT INTO mod_settings(mod_id,name,value_json,created_at,updated_at) VALUES($1,$2,$3,$4,$4)
      ON CONFLICT(mod_id,name) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at`, [this.modId, String(name), JSON.stringify(value), stamp]);
    return value;
  }
  async delete(name) { const result = await this.pool.query('DELETE FROM mod_settings WHERE mod_id=$1 AND name=$2', [this.modId, String(name)]); return result.rowCount > 0; }
  async getSecret(name) { const normalized = String(name); const result = await this.pool.query('SELECT ciphertext,nonce,auth_tag FROM mod_secrets WHERE mod_id=$1 AND name=$2', [this.modId, normalized]); return result.rows[0] ? open(this.key, this.modId, normalized, result.rows[0]) : null; }
  async hasSecret(name) { const result = await this.pool.query('SELECT 1 FROM mod_secrets WHERE mod_id=$1 AND name=$2', [this.modId, String(name)]); return result.rows.length > 0; }
  async setSecret(name, value) {
    const normalized = String(name);
    if (value === null || value === undefined || String(value) === '') return this.clearSecret(normalized);
    const stamp = this.clock(); const encrypted = seal(this.key, this.modId, normalized, value);
    await this.pool.query(`INSERT INTO mod_secrets(mod_id,name,ciphertext,nonce,auth_tag,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)
      ON CONFLICT(mod_id,name) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,nonce=EXCLUDED.nonce,auth_tag=EXCLUDED.auth_tag,updated_at=EXCLUDED.updated_at`, [this.modId, normalized, encrypted.ciphertext, encrypted.nonce, encrypted.authTag, stamp]);
    return true;
  }
  async clearSecret(name) { const result = await this.pool.query('DELETE FROM mod_secrets WHERE mod_id=$1 AND name=$2', [this.modId, String(name)]); return result.rowCount > 0; }
}

export function postgresModStoreFactory({ pool, key, ownsPool = false, clock } = {}) {
  return (modId) => new PostgresModSettingsStore({ modId, pool, key, ownsPool, clock });
}

export async function disabledPostgresMods(pool) {
  const { rows } = await pool.query('SELECT mod_id FROM mod_lifecycle WHERE enabled=0');
  return rows.map(row => row.mod_id);
}

export async function publishPostgresModCatalog(pool, mod) {
  const id = `mod.${mod.id}`, timestamp = now();
  if (!mod.tools?.length) {
    await pool.query('UPDATE mcp_connections SET tools_json=$1,updated_at=$2 WHERE id=$3', ['[]', timestamp, id]);
    return;
  }
  await pool.query(`INSERT INTO mcp_connections(id,name,transport,connection_kind,base_url,enabled,tools_json,created_at,updated_at)
    VALUES($1,$2,'http','http',$3,true,$4,$5,$5)
    ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,tools_json=EXCLUDED.tools_json,updated_at=EXCLUDED.updated_at`,
    [id, `Mod: ${mod.name}`, `mod://${mod.id}`, JSON.stringify(mod.tools), timestamp]);
}
