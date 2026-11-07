import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const AAD_PREFIX = 'burrow-model-secret-v1';

function aad(secretId, connectionId, name) { return Buffer.from(`${AAD_PREFIX}|${secretId}|connection|${connectionId}|${name}`); }
export function encrypt(key, secretId, connectionId, name, value) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(secretId, connectionId, name));
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}
export function decrypt(key, row) {
  let lastError;
  for (const prefix of [AAD_PREFIX, 'hatchetclaw-model-secret-v1']) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, row.nonce);
      decipher.setAAD(Buffer.from(`${prefix}|${row.id}|connection|${row.connection_id}|${row.name}`));
      decipher.setAuthTag(row.auth_tag);
      return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
    } catch (error) { lastError = error; }
  }
  throw lastError;
}
