import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { openSettingsDatabase } from './settings-database.mjs';
import { settingsKeyFromEnvironment } from './model-settings-store.mjs';

const AAD_PREFIX = 'burrow-mod-secret-v1';
const now = () => new Date().toISOString();

function keyName(modId, name) { return `${modId}:${name}`; }
function aad(modId, name) { return Buffer.from(`${AAD_PREFIX}|${modId}|${name}`); }
function seal(key, modId, name, value) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(modId, name));
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}
function open(key, modId, name, row) {
  const decipher = createDecipheriv('aes-256-gcm', key, row.nonce);
  decipher.setAAD(aad(modId, name));
  decipher.setAuthTag(row.auth_tag);
  return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
}

export class ModSettingsStore {
  constructor({ modId, databasePath, key = settingsKeyFromEnvironment() } = {}) {
    this.modId = String(modId || '').trim();
    if (!this.modId) throw new Error('mod_id_required');
    this.db = openSettingsDatabase({ databasePath });
    this.key = key;
  }

  get(name, fallback = null) {
    const row = this.db.prepare('SELECT value_json FROM mod_settings WHERE mod_id=? AND name=?').get(this.modId, String(name));
    if (!row) return fallback;
    try { return JSON.parse(row.value_json); } catch { return fallback; }
  }

  set(name, value) {
    const timestamp = now();
    this.db.prepare(`INSERT INTO mod_settings (mod_id,name,value_json,created_at,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(mod_id,name) DO UPDATE SET value_json=excluded.value_json,updated_at=excluded.updated_at`)
      .run(this.modId, String(name), JSON.stringify(value), timestamp, timestamp);
    return value;
  }

  delete(name) { return this.db.prepare('DELETE FROM mod_settings WHERE mod_id=? AND name=?').run(this.modId, String(name)).changes > 0; }

  getSecret(name) {
    const normalized = String(name);
    const row = this.db.prepare('SELECT ciphertext,nonce,auth_tag FROM mod_secrets WHERE mod_id=? AND name=?').get(this.modId, normalized);
    return row ? open(this.key, this.modId, normalized, row) : null;
  }

  hasSecret(name) { return Boolean(this.db.prepare('SELECT 1 FROM mod_secrets WHERE mod_id=? AND name=?').get(this.modId, String(name))); }

  setSecret(name, value) {
    const normalized = String(name);
    if (value === null || value === undefined || String(value) === '') return this.clearSecret(normalized);
    const timestamp = now();
    const encrypted = seal(this.key, this.modId, normalized, value);
    this.db.prepare(`INSERT INTO mod_secrets (mod_id,name,ciphertext,nonce,auth_tag,created_at,updated_at) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(mod_id,name) DO UPDATE SET ciphertext=excluded.ciphertext,nonce=excluded.nonce,auth_tag=excluded.auth_tag,updated_at=excluded.updated_at`)
      .run(this.modId, normalized, encrypted.ciphertext, encrypted.nonce, encrypted.authTag, timestamp, timestamp);
    return true;
  }

  clearSecret(name) { return this.db.prepare('DELETE FROM mod_secrets WHERE mod_id=? AND name=?').run(this.modId, String(name)).changes > 0; }
  close() { this.db.close(); }
}

export function modSettingsApi(store) {
  return Object.freeze({ get: store.get.bind(store), set: store.set.bind(store), delete: store.delete.bind(store) });
}
export function modSecretsApi(store) {
  return Object.freeze({ get: store.getSecret.bind(store), set: store.setSecret.bind(store), clear: store.clearSecret.bind(store), has: store.hasSecret.bind(store) });
}
