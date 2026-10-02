import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const AAD_PREFIX = 'burrow-ui-auth-secret-v1';
const OIDC_CLIENT_SECRET_NAME = 'oidcClientSecret';

function aad(secretId, name) { return Buffer.from(`${AAD_PREFIX}|${secretId}|${name}`); }
export function encryptUiAuthSecret(key, secretId, name, value) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(secretId, name));
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}
export function decryptUiAuthSecret(key, row) {
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

export { OIDC_CLIENT_SECRET_NAME };
