import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { openSettingsDatabase, settingsDatabasePath } from './settings-database.mjs';

const AAD_PREFIX = 'burrow-mcp-secret-v1';
const now = () => new Date().toISOString();
const text = (value) => String(value ?? '').trim();
const id = (value, field = 'id') => { const result = text(value); if (!/^[A-Za-z0-9._-]{1,96}$/.test(result)) throw new Error(`${field}_invalid`); return result; };
const parseJson = (value, fallback = []) => { try { return JSON.parse(value); } catch { return fallback; } };
const json = (value) => JSON.stringify(value ?? []);

export function settingsKeyFromEnvironment(env = process.env) {
  const encoded = text(env.BURROW_SETTINGS_KEY);
  if (!encoded) throw new Error('settings_encryption_key_missing');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('settings_encryption_key_invalid');
  return key;
}
function aad(secretId, connectionId, name) { return Buffer.from(`${AAD_PREFIX}|${secretId}|connection|${connectionId}|${name}`); }
function encrypt(key, secretId, connectionId, name, value) { const nonce = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad(secretId, connectionId, name)); return { ciphertext: Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]), nonce, authTag: cipher.getAuthTag() }; }
function decrypt(key, row) {
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
function tools(value) { const seen = new Set(); return (Array.isArray(value) ? value : []).map((item) => typeof item === 'string' ? { name: item } : item || {}).map((item) => ({ name: text(item.name), description: text(item.description) || null, inputSchema: item.inputSchema && typeof item.inputSchema === 'object' && !Array.isArray(item.inputSchema) ? item.inputSchema : { type: 'object', properties: {} } })).filter((item) => item.name && item.name.length <= 240 && !seen.has(item.name) && (seen.add(item.name), true)); }
function environmentVariables(value) {
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
function input(value = {}) {
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
  return { name, transport, lifecycle, baseUrl: transport === 'http' ? baseUrl : '', command: transport === 'stdio' ? command : null, args: transport === 'stdio' ? args : [], enabled: value.enabled !== false, tools: tools(value.tools), environmentVariables: environmentVariables(value) };
}
function publicConnection(row, environmentVariables = []) { return row && { id: row.id, name: row.name, transport: row.connection_kind || row.transport, baseUrl: (row.connection_kind || row.transport) === 'http' ? row.base_url : null, command: row.command || null, args: parseJson(row.args_json, []), lifecycle: row.lifecycle || 'ephemeral', enabled: Boolean(row.enabled), tools: tools(parseJson(row.tools_json)), apiKeyConfigured: Boolean(row.secret_id), environmentVariables, createdAt: row.created_at, updatedAt: row.updated_at }; }

export class McpSettingsStore {
  constructor({ databasePath, key } = {}) { this.databasePath = databasePath || settingsDatabasePath(); this.key = key || settingsKeyFromEnvironment(); this.db = openSettingsDatabase({ databasePath: this.databasePath }); }
  close() { this.db.close(); }
  connectionSecrets(connectionId) { return this.db.prepare('SELECT * FROM mcp_connection_secrets WHERE connection_id=?').all(id(connectionId, 'mcp_connection_id')); }
  environmentVariables(connectionId) { return this.connectionSecrets(connectionId).filter((row) => row.name !== 'apiKey').map((row) => ({ name: row.name, configured: true })); }
  secretEnvironment(connectionId) { return Object.fromEntries(this.connectionSecrets(connectionId).filter((row) => row.name !== 'apiKey').map((row) => [row.name, decrypt(this.key, row)])); }
  list() { return this.db.prepare("SELECT c.*,s.id secret_id FROM mcp_connections c LEFT JOIN mcp_connection_secrets s ON s.connection_id=c.id AND s.name='apiKey' ORDER BY c.updated_at DESC").all().map((row) => publicConnection(row, this.environmentVariables(row.id))); }
  get(connectionId) { const row = this.db.prepare("SELECT c.*,s.id secret_id FROM mcp_connections c LEFT JOIN mcp_connection_secrets s ON s.connection_id=c.id AND s.name='apiKey' WHERE c.id=?").get(id(connectionId, 'mcp_connection_id')); return publicConnection(row, row ? this.environmentVariables(row.id) : []); }
  apiKey(connectionId) { const row = this.db.prepare("SELECT * FROM mcp_connection_secrets WHERE connection_id=? AND name='apiKey'").get(id(connectionId, 'mcp_connection_id')); return row ? decrypt(this.key, row) : null; }
  prepareSave(value = {}) { const connection = input(value); const connectionId = value.id ? id(value.id, 'mcp_connection_id') : randomUUID(); return { connectionId, existing: this.get(connectionId), next: { id: connectionId, ...connection } }; }
  save(value = {}) { const { connectionId, existing } = this.prepareSave(value); const connection = input(value); const timestamp = now(); this.db.exec('BEGIN IMMEDIATE'); try { if (existing) this.db.prepare('UPDATE mcp_connections SET name=?,transport=?,connection_kind=?,base_url=?,command=?,args_json=?,lifecycle=?,enabled=?,tools_json=?,updated_at=? WHERE id=?').run(connection.name, 'http', connection.transport, connection.baseUrl, connection.command, json(connection.args), connection.lifecycle, connection.enabled ? 1 : 0, json(connection.tools), timestamp, connectionId); else this.db.prepare('INSERT INTO mcp_connections (id,name,transport,connection_kind,base_url,command,args_json,lifecycle,enabled,tools_json,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(connectionId, connection.name, 'http', connection.transport, connection.baseUrl, connection.command, json(connection.args), connection.lifecycle, connection.enabled ? 1 : 0, json(connection.tools), timestamp, timestamp); const upsertSecret = (name, value) => { const old = this.db.prepare('SELECT id FROM mcp_connection_secrets WHERE connection_id=? AND name=?').get(connectionId, name); const secretId = old?.id || randomUUID(); const sealed = encrypt(this.key, secretId, connectionId, name, value); if (old) this.db.prepare('UPDATE mcp_connection_secrets SET ciphertext=?,nonce=?,auth_tag=?,updated_at=? WHERE id=?').run(sealed.ciphertext, sealed.nonce, sealed.authTag, timestamp, secretId); else this.db.prepare('INSERT INTO mcp_connection_secrets (id,connection_id,name,ciphertext,nonce,auth_tag,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(secretId, connectionId, name, sealed.ciphertext, sealed.nonce, sealed.authTag, timestamp, timestamp); }; if (value.apiKey !== undefined && text(value.apiKey)) upsertSecret('apiKey', text(value.apiKey)); if (connection.environmentVariables !== null) { const names = connection.environmentVariables.map((entry) => entry.name); const existingVariables = this.connectionSecrets(connectionId).filter((row) => row.name !== 'apiKey'); for (const row of existingVariables) if (!names.includes(row.name)) this.db.prepare('DELETE FROM mcp_connection_secrets WHERE id=?').run(row.id); for (const entry of connection.environmentVariables) { if (text(entry.value)) upsertSecret(entry.name, text(entry.value)); else if (!existingVariables.some((row) => row.name === entry.name)) throw new Error('mcp_environment_variable_value_required'); } } this.db.exec('COMMIT'); return this.get(connectionId); } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; } }
  refreshTools(connectionId, discoveredTools = []) { const connection = this.get(connectionId); if (!connection) throw new Error('mcp_connection_not_found'); return this.save({ ...connection, tools: discoveredTools }); }
  remove(connectionId) { return this.db.prepare('DELETE FROM mcp_connections WHERE id=?').run(id(connectionId, 'mcp_connection_id')).changes > 0; }
  agentTools(agentId) { const agent = id(agentId, 'agent_id'); return this.db.prepare(`SELECT g.connection_id,c.name AS connection_name,g.tool_name,g.enabled FROM agent_mcp_tools g JOIN mcp_connections c ON c.id=g.connection_id WHERE g.agent_id=? ORDER BY c.name,g.tool_name`).all(agent).map((row) => ({ connectionId: row.connection_id, connectionName: row.connection_name, toolName: row.tool_name, enabled: Boolean(row.enabled) })); }
  setAgentTools(agentId, entries = []) { const agent = id(agentId, 'agent_id'); const normalized = (Array.isArray(entries) ? entries : []).map((entry) => ({ connectionId: id(entry.connectionId, 'mcp_connection_id'), toolName: text(entry.toolName), enabled: entry.enabled !== false })).filter((entry) => entry.toolName && entry.toolName.length <= 240); const timestamp = now(); this.db.exec('BEGIN IMMEDIATE'); try { if (!this.db.prepare('SELECT id FROM agents WHERE id=?').get(agent)) throw new Error('agent_not_found'); for (const entry of normalized) if (!this.get(entry.connectionId)) throw new Error('mcp_connection_not_found'); this.db.prepare('DELETE FROM agent_mcp_tools WHERE agent_id=?').run(agent); const insert = this.db.prepare('INSERT INTO agent_mcp_tools (agent_id,connection_id,tool_name,enabled,created_at,updated_at) VALUES (?,?,?,?,?,?)'); for (const entry of normalized) insert.run(agent, entry.connectionId, entry.toolName, entry.enabled ? 1 : 0, timestamp, timestamp); this.db.exec('COMMIT'); return this.agentTools(agent); } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; } }
}
