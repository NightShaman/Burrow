import { openSettingsDatabase, settingsDatabasePath } from './settings-database.mjs';
import path from 'node:path';

const providers = new Map();
const scope = (databasePath) => path.resolve(databasePath || settingsDatabasePath());
const providerKey = (databasePath, id) => `${scope(databasePath)}\0${id}`;
export const modToolConnectionId = (id) => `mod.${id}`;

// Catalog and grant storage are the existing MCP connection and agent_mcp_tools
// tables. A mod connection is not a network MCP endpoint; only this live host
// registry can route calls to it.
export function publishModTools(mod, databasePath) {
  if (!mod.server) return;
  const id = modToolConnectionId(mod.id);
  const key = providerKey(databasePath, id);
  const db = openSettingsDatabase({ databasePath });
  try {
    if (mod.tools?.length) {
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO mcp_connections (id,name,transport,connection_kind,base_url,enabled,tools_json,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,tools_json=excluded.tools_json,updated_at=excluded.updated_at`)
        .run(id, `Mod: ${mod.name}`, 'http', 'http', `mod://${mod.id}`, 1, JSON.stringify(mod.tools), now, now);
      providers.set(key, mod);
      mod.toolDatabasePath = scope(databasePath);
    } else {
      providers.delete(key);
      // An empty catalog must not discard existing operator grants.
      db.prepare('UPDATE mcp_connections SET tools_json=?,updated_at=? WHERE id=?').run('[]', new Date().toISOString(), id);
    }
  } finally { db.close(); }
}

export function unpublishModTools(mod) {
  const key = providerKey(mod.toolDatabasePath, modToolConnectionId(mod.id));
  if (providers.get(key) === mod) providers.delete(key);
}

export function activeModToolConnection(id, databasePath) {
  const mod = providers.get(providerKey(databasePath, id));
  return mod?.status === 'loaded' && mod.host ? mod : null;
}

export function modToolConnections(databasePath) {
  const prefix = `${scope(databasePath)}\0`;
  return [...providers.entries()].flatMap(([key, mod]) => {
    if (!key.startsWith(prefix)) return [];
    const id = key.slice(prefix.length);
    return activeModToolConnection(id, databasePath) === mod
      ? [{ id, name: `Mod: ${mod.name}`, transport: 'mod', databasePath: scope(databasePath), enabled: true, tools: mod.tools, mod, resolveProtectedReference: (name, reference, caller) => mod.host.resolveProtectedReference(name, reference, caller), invoke: (name, args, caller) => {
        if (activeModToolConnection(id, databasePath) !== mod || !mod.tools.some((tool) => tool.name === name)) throw new Error('mcp_provider_not_available');
        return mod.host.invokeTool(name, args, caller.context, { abortSignal: caller.abortSignal });
      } }] : [];
  });
}
