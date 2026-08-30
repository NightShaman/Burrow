import { ensureMcpProvider, mcpProviderState, publicMcpError } from './mcporter-adapter.mjs';
const text = (value) => String(value ?? '').trim();
const bounded = (value, limit) => text(value).slice(0, limit);
const keyFor = (connectionId, toolName) => `${connectionId}:${toolName}`;

// MCP catalog text describes server implementation. Do not project backing CLI
// recovery steps into an agent that is operating through the MCP transport.
function publicDescription(value) {
  return bounded(text(value)
    .replace(/\brun\s+[\"`']?bw\s+unlock\s+--raw[\"`']?[^.\n]*/gi, 'request vault access through this MCP provider')
    .replace(/\bset\s+BW_SESSION\b[^.\n]*/gi, 'the runtime manages vault session state')
    .replace(/\bBitwarden CLI\b/gi, 'vault service'), 2_000) || null;
}

export function resolveMcpProvider(connections, provider) {
  const requested = text(provider).toLowerCase();
  if (!requested || !(connections instanceof Map)) return null;
  const exactId = connections.get(text(provider));
  if (exactId) return exactId;
  const matches = [...connections.values()].filter((connection) => text(connection.name).toLowerCase() === requested);
  return matches.length === 1 ? matches[0] : null;
}

export function isGrantedMcpTool(grants, connectionId, toolName) {
  return grants instanceof Map && grants.has(keyFor(connectionId, toolName));
}

export async function mcpProvidersReceipt({ connections, grants, agentId } = {}) {
  if (!(connections instanceof Map)) return { tool: 'mcp_providers', ok: true, providers: [], resultCount: 0 };
  const providers = await Promise.all([...connections.values()]
    .filter((connection) => connection?.enabled)
    .slice(0, 50)
    .map(async (connection) => {
      let lifecycle = mcpProviderState(connection);
      if (connection.lifecycle === 'keep_alive') {
        try { lifecycle = await ensureMcpProvider(connection, { apiKey: connection.apiKey, environmentVariables: connection.environmentVariables }); }
        catch (error) { lifecycle = { ...mcpProviderState(connection), status: 'unavailable', error: publicMcpError(error) }; }
      }
      const catalog = Array.isArray(connection.tools) ? connection.tools : [];
      const grantedToolCount = catalog.filter((tool) => isGrantedMcpTool(grants, connection.id, tool.name)).length;
      return {
        id: connection.id,
        name: bounded(connection.name, 120),
        transport: connection.transport,
        catalogToolCount: catalog.length,
        grantedToolCount,
        available: grantedToolCount > 0 && lifecycle.status !== 'unavailable',
        lifecycle,
      };
    }));
  return { tool: 'mcp_providers', ok: true, agentId: agentId || null, providers, resultCount: providers.length };
}

export async function mcpCapabilitiesReceipt({ connections, grants, provider, query = null, cursor = null, limit = null } = {}) {
  const connection = resolveMcpProvider(connections, provider);
  if (!connection || !connection.enabled) return { tool: 'mcp_capabilities', ok: false, provider: text(provider) || null, error: 'mcp_provider_not_available' };
  if (connection.lifecycle === 'keep_alive') {
    try { await ensureMcpProvider(connection, { apiKey: connection.apiKey, environmentVariables: connection.environmentVariables }); }
    catch { return { tool: 'mcp_capabilities', ok: false, provider: { id: connection.id, name: connection.name }, error: 'mcp_provider_not_available' }; }
  }
  const normalizedQuery = text(query).toLowerCase();
  const start = Math.max(0, Number.parseInt(cursor, 10) || 0);
  const pageSize = Math.max(1, Math.min(20, Number(limit) || 12));
  const catalog = (Array.isArray(connection.tools) ? connection.tools : []).filter((tool) => {
    if (!normalizedQuery) return true;
    return `${tool.name || ''}\n${tool.description || ''}`.toLowerCase().includes(normalizedQuery);
  });
  const tools = catalog.slice(start, start + pageSize).map((tool) => ({
    name: bounded(tool.name, 240),
    description: publicDescription(tool.description),
    inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
    granted: isGrantedMcpTool(grants, connection.id, tool.name),
  }));
  const nextCursor = start + tools.length < catalog.length ? String(start + tools.length) : null;
  return { tool: 'mcp_capabilities', ok: true, provider: { id: connection.id, name: connection.name }, query: normalizedQuery || null, tools, resultCount: tools.length, totalCount: catalog.length, nextCursor };
}

export function grantedMcpTool({ connections, grants, provider, toolName } = {}) {
  const connection = resolveMcpProvider(connections, provider);
  const name = text(toolName);
  if (!connection || !connection.enabled) return { error: 'mcp_provider_not_available', connection: null, tool: null };
  const tool = (connection.tools || []).find((item) => item.name === name) || null;
  if (!tool) return { error: 'mcp_tool_not_found', connection, tool: null };
  if (!isGrantedMcpTool(grants, connection.id, name)) return { error: 'mcp_tool_not_granted', connection, tool };
  return { error: null, connection, tool };
}

export const __test__ = { publicDescription };
