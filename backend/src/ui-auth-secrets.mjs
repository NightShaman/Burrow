import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { settingsKeyFromEnvironment } from './model-settings-store.mjs';

const AAD_PREFIX = 'burrow-ui-auth-secret-v1';
const OIDC_CLIENT_SECRET_NAME = 'oidcClientSecret';

function now() { return new Date().toISOString(); }
function aad(secretId, name) { return Buffer.from(`${AAD_PREFIX}|${secretId}|${name}`); }
function encrypt(key, secretId, name, value) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(secretId, name));
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}
function decrypt(key, row) {
  let lastError;
  for (const prefix of [AAD_PREFIX, 'hatchetclaw-ui-auth-secret-v1']) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, row.nonce);
      decipher.setAAD(Buffer.from(`${prefix}|${row.id}|${row.name}`));
      decipher.setAuthTag(row.auth_tag);
      return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

export function getUiAuthSecret(db, name = OIDC_CLIENT_SECRET_NAME) {
  const row = db.prepare('SELECT * FROM ui_auth_secrets WHERE name=?').get(name);
  return row ? decrypt(settingsKeyFromEnvironment(), row) : null;
}

export function hasUiAuthSecret(db, name = OIDC_CLIENT_SECRET_NAME) {
  return Boolean(db.prepare('SELECT 1 FROM ui_auth_secrets WHERE name=?').get(name));
}

export function setUiAuthSecret(db, value, name = OIDC_CLIENT_SECRET_NAME) {
  const key = settingsKeyFromEnvironment();
  const timestamp = now();
  const existing = db.prepare('SELECT id FROM ui_auth_secrets WHERE name=?').get(name);
  const secretId = existing?.id || randomUUID();
  const sealed = encrypt(key, secretId, name, value);
  if (existing) db.prepare('UPDATE ui_auth_secrets SET ciphertext=?, nonce=?, auth_tag=?, updated_at=? WHERE id=?').run(sealed.ciphertext, sealed.nonce, sealed.authTag, timestamp, secretId);
  else db.prepare('INSERT INTO ui_auth_secrets (id,name,ciphertext,nonce,auth_tag,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(secretId, name, sealed.ciphertext, sealed.nonce, sealed.authTag, timestamp, timestamp);
  return secretId;
}

export { OIDC_CLIENT_SECRET_NAME };
