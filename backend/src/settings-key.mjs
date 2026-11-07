export function settingsKeyFromEnvironment(env = process.env) {
  const encoded = String(env.BURROW_SETTINGS_KEY ?? '').trim();
  if (!encoded) throw new Error('settings_encryption_key_missing');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('settings_encryption_key_invalid');
  return key;
}
