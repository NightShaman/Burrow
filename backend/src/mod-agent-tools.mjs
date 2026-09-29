const providers = new Map();
const providerKey = (id) => id;
export const modToolConnectionId = (id) => `mod.${id}`;

// Catalog and grant storage are the existing MCP connection and agent_mcp_tools
// tables. A mod connection is not a network MCP endpoint; only this live host
// registry can route calls to it.
export async function publishModTools(mod, catalogWriter) {
  if (!mod.server) return;
  if (typeof catalogWriter !== 'function') throw new Error('mod_catalog_writer_required');
  const id = modToolConnectionId(mod.id);
  await catalogWriter(mod);
  if (mod.tools?.length) { providers.set(providerKey(id), mod); mod.toolRegistryKey = providerKey(id); }
  else providers.delete(providerKey(id));
}

export function unpublishModTools(mod) {
  const key = providerKey(modToolConnectionId(mod.id));
  if (providers.get(key) === mod) providers.delete(key);
}

export function activeModToolConnection(id) {
  const mod = providers.get(providerKey(id));
  return mod?.status === 'loaded' && mod.host ? mod : null;
}

export function modToolConnections() {
  return [...providers.entries()].flatMap(([id, mod]) => activeModToolConnection(id) === mod
    ? [{ id, name: `Mod: ${mod.name}`, transport: 'mod', enabled: true, tools: mod.tools, mod, resolveProtectedReference: (name, reference, caller) => mod.host.resolveProtectedReference(name, reference, caller), invoke: (name, args, caller) => {
      if (activeModToolConnection(id) !== mod || !mod.tools.some((tool) => tool.name === name)) throw new Error('mcp_provider_not_available');
      return mod.host.invokeTool(name, args, caller.context, { abortSignal: caller.abortSignal });
    } }]
    : []);
}
