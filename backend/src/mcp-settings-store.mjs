import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';

const AAD_PREFIX = 'burrow-mcp-secret-v1';
const text = (value) => String(value ?? '').trim();
const id = (value, field = 'id') => { const result = text(value); if (!/^[A-Za-z0-9._-]{1,96}$/.test(result)) throw new Error(`${field}_invalid`); return result; };
export function settingsKeyFromEnvironment(env = process.env) {
  const encoded = text(env.BURROW_SETTINGS_KEY);
  if (!encoded) throw new Error('settings_encryption_key_missing');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('settings_encryption_key_invalid');
  return key;
}
function aad(secretId, connectionId, name) { return Buffer.from(`${AAD_PREFIX}|${secretId}|connection|${connectionId}|${name}`); }
export function encryptMcpSecret(key, secretId, connectionId, name, value) { const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad(secretId, connectionId, name)); return { ciphertext: Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]), nonce, authTag: cipher.getAuthTag() }; }
export function decryptMcpSecret(key, row) {
  let lastError;
  for (const prefix of [AAD_PREFIX, 'hatchetclaw-mcp-secret-v1']) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, row.nonce);
      decipher.setAAD(Buffer.from(`${prefix}|${row.id}|connection|${row.connection_id}|${row.name}`));
      decipher.setAuthTag(row.auth_tag);
      return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
    } catch (error) { lastError = error; }
  }
  throw lastError;
}
export function normalizeMcpTools(value) { const seen = new Set(); return (Array.isArray(value) ? value : []).map((item) => typeof item === 'string' ? { name: item } : item || {}).map((item) => ({ name: text(item.name), description: text(item.description) || null, inputSchema: item.inputSchema && typeof item.inputSchema === 'object' && !Array.isArray(item.inputSchema) ? item.inputSchema : { type: 'object', properties: {} } })).filter((item) => item.name && item.name.length <= 240 && !seen.has(item.name) && (seen.add(item.name), true)); }
export function normalizeMcpEnvironmentVariables(value) {
  const seen = new Set();
  if (value.environmentVariables === undefined) return null;
  if (!Array.isArray(value.environmentVariables)) throw new Error('mcp_environment_variables_invalid');
  return value.environmentVariables.map((entry) => ({ name: text(entry?.name), value: entry?.value === undefined ? undefined : String(entry.value) })).filter((entry) => {
    if (!entry.name) return false;
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(entry.name) || seen.has(entry.name)) throw new Error('mcp_environment_variable_name_invalid');
    seen.add(entry.name);
    return true;
  });
}
// Lowercase names are the secret-store identity; values are never trimmed.
export function normalizeMcpHeaders(headers) {
  if (headers === undefined) return null;
  if (!headers || typeof headers !== 'object' || Array.isArray(headers) || Object.keys(headers).length > 64) throw new Error('mcp_headers_invalid');
  const entries = [], seen = new Set();
  for (const [name, value] of Object.entries(headers)) {
    const canonical = name.toLowerCase();
    if (name.length > 128 || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || seen.has(canonical)) throw new Error('mcp_header_name_invalid');
    seen.add(canonical);
    if (value !== null && (typeof value !== 'string' || /[\r\n\0]/.test(value) || Buffer.byteLength(value, 'utf8') > 8192)) throw new Error('mcp_header_value_invalid');
    entries.push([canonical, value]);
  }
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}
export function normalizeMcpInput(value = {}) {
  const name = text(value.name); const transport = text(value.transport).toLowerCase();
  if (!name || name.length > 120) throw new Error('mcp_name_invalid');
  if (!['http', 'stdio'].includes(transport)) throw new Error('mcp_transport_invalid');
  const lifecycle = text(value.lifecycle || 'ephemeral').toLowerCase();
  if (!['ephemeral', 'keep_alive'].includes(lifecycle)) throw new Error('mcp_lifecycle_invalid');
  const baseUrl = text(value.baseUrl);
  const command = text(value.command);
  const args = Array.isArray(value.args) ? value.args.map((item) => text(item)).filter(Boolean) : [];
  if (transport === 'http' && !/^https?:\/\//i.test(baseUrl)) throw new Error('mcp_base_url_invalid');
  if (transport === 'stdio' && (!command || command.length > 240)) throw new Error('mcp_command_invalid');
  if (args.some((item) => item.length > 2_000)) throw new Error('mcp_args_invalid');
  return { name, transport, lifecycle, baseUrl: transport === 'http' ? baseUrl : '', command: transport === 'stdio' ? command : null, args: transport === 'stdio' ? args : [], enabled: value.enabled !== false, tools: normalizeMcpTools(value.tools), environmentVariables: normalizeMcpEnvironmentVariables(value), headers: normalizeMcpHeaders(value.headers) };
}
// Compatibility export only; persistence requires the PostgreSQL store.
export class McpSettingsStore {
  constructor() { throw new Error('postgres_required'); }
}
