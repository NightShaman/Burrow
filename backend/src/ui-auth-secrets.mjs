import { sealSettingsSecret, openSettingsSecret } from './settings-secret.mjs';

const AAD_PREFIX = 'burrow-ui-auth-secret-v1';
const OIDC_CLIENT_SECRET_NAME = 'oidcClientSecret';

function aad(secretId, name) { return Buffer.from(`${AAD_PREFIX}|${secretId}|${name}`); }
export function encryptUiAuthSecret(key, secretId, name, value) {
  return sealSettingsSecret(key, aad(secretId, name), value);
}
export function decryptUiAuthSecret(key, row) {
  let lastError;
  for (const prefix of [AAD_PREFIX, 'hatchetclaw-ui-auth-secret-v1']) {
    try {
      return openSettingsSecret(key, `${prefix}|${row.id}|${row.name}`, row);
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

export { OIDC_CLIENT_SECRET_NAME };
