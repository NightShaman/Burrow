import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// Shared settings credential encryption. Callers own their AAD namespace and
// persistence boundary; changing an existing namespace breaks stored secrets.
export function sealSettingsSecret(key, aad, value) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad));
  return { ciphertext: Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]), nonce, authTag: cipher.getAuthTag() };
}
export function openSettingsSecret(key, aad, row) {
  const decipher = createDecipheriv('aes-256-gcm', key, row.nonce);
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(row.auth_tag);
  return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
}
