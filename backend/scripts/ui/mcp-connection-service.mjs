import {
  diagnoseMcpConnection,
  discoverMcpTools,
  reconcilePersistentMcpConnection,
} from '../../src/mcporter-adapter.mjs';
import { createCatalogRefreshDiagnostics } from '../../src/http-operational-log.mjs';

/**
 * MCP connection HTTP workflows. PostgreSQL settings and daemon reconciliation
 * are explicit dependencies; mcporter owns its own persistent daemon protocol.
 */
export function createMcpConnectionService({
  mcpStore,
  resolveAgentRuntime,
  logger,
  reconcilePersistentMcpConnectionImpl = reconcilePersistentMcpConnection,
  discoverMcpToolsImpl = discoverMcpTools,
  diagnoseMcpConnectionImpl = diagnoseMcpConnection,
  createCatalogRefreshDiagnosticsImpl = createCatalogRefreshDiagnostics,
} = {}) {
  if (typeof mcpStore !== 'function') throw new TypeError('mcp_store_required');
  if (typeof resolveAgentRuntime !== 'function') throw new TypeError('resolve_agent_runtime_required');
  const mcpCatalogDiagnostics = createCatalogRefreshDiagnosticsImpl(logger, 'mcp');

  async function mcpConnections() {
    return { ok: true, connections: await mcpStore().list() };
  }

  async function saveMcpConnection(body = {}) {
    try {
      const store = mcpStore();
      const prepared = typeof store.prepareSave === 'function'
        ? store.prepareSave(body)
        : { existing: body.id ? await store.get(body.id) : null, next: body };
      const { existing, next } = await prepared;
      const previousApiKey = existing ? await store.apiKey(existing.id) : null;
      const nextApiKey = body.apiKey === undefined || !String(body.apiKey || '').trim() ? previousApiKey : String(body.apiKey).trim();
      const previousHeaders = existing ? await store.secretHeaders(existing.id) : {};
      const previousEnvironmentVariables = existing ? await store.secretEnvironment(existing.id) : {};
      const nextEnvironmentVariables = Array.isArray(body.environmentVariables) ? Object.fromEntries(body.environmentVariables.map((entry) => [String(entry?.name || '').trim(), entry?.value === undefined || !String(entry.value).trim() ? previousEnvironmentVariables[String(entry?.name || '').trim()] : String(entry.value).trim()]).filter(([name, value]) => name && value)) : previousEnvironmentVariables;
      // Persist configuration and scoped secrets before touching a running daemon.
      // A stale/broken keep-alive process must not turn a valid settings update into
      // a failed save (and lose the operator's replacement secret).
      const connection = await store.save(body);
      try {
        await reconcilePersistentMcpConnectionImpl(existing, connection, { previousApiKey, nextApiKey, previousEnvironmentVariables, nextEnvironmentVariables, previousHeaders, nextHeaders: await store.secretHeaders(connection.id) });
      } catch (error) {
        void logger?.event?.('mcp_connection_reconcile_failed', { connectionId: connection.id, error }, { level: 'warn', component: 'mcp' });
      }
      return { ok: true, connection };
    } catch (error) { return { ok: false, status: 400, error: String(error?.message || error) }; }
  }

  async function removeMcpConnection(id) {
    try {
      const store = mcpStore();
      const connection = await store.get(id);
      if (!connection) return false;
      await reconcilePersistentMcpConnectionImpl(connection, null, { previousApiKey: await store.apiKey(connection.id), previousHeaders: await store.secretHeaders(connection.id), previousEnvironmentVariables: await store.secretEnvironment(connection.id) });
      return await store.remove(id);
    } catch (error) { throw error; }
  }

  async function discoverMcpConnection(body = {}) {
    try {
      const connection = await mcpStore().get(body.connectionId);
      if (!connection) return { ok: false, status: 404, error: 'mcp_connection_not_found' };
      const tools = await discoverMcpToolsImpl(connection, { apiKey: await mcpStore().apiKey(connection.id), headers: await mcpStore().secretHeaders(connection.id), environmentVariables: await mcpStore().secretEnvironment(connection.id) });
      const refreshed = await mcpStore().refreshTools(connection.id, tools);
      mcpCatalogDiagnostics('mcp_catalog_refresh', true, { connectionId: connection.id });
      return { ok: true, connection: refreshed, tools };
    } catch (error) {
      mcpCatalogDiagnostics('mcp_catalog_refresh', false, { connectionId: body.connectionId, error });
      return { ok: false, status: 400, error: String(error?.message || error) };
    }
  }

  async function diagnoseMcpConnection(body = {}) {
    const connection = await mcpStore().get(body.connectionId);
    if (!connection) return { ok: false, status: 404, error: 'mcp_connection_not_found' };
    const result = await diagnoseMcpConnectionImpl(connection, { apiKey: await mcpStore().apiKey(connection.id), headers: await mcpStore().secretHeaders(connection.id), environmentVariables: await mcpStore().secretEnvironment(connection.id), toolName: typeof body.toolName === 'string' && body.toolName.trim() ? body.toolName.trim() : null, arguments: body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments) ? body.arguments : {} });
    return { ...result, ...(result.ok ? {} : { status: 400 }) };
  }

  async function agentMcpTools(agentId) {
    try { await resolveAgentRuntime(agentId); return { ok: true, agentId, tools: await mcpStore().agentTools(agentId) }; }
    catch (error) { return { ok: false, status: error?.statusCode || 400, error: String(error?.message || error) }; }
  }

  async function saveAgentMcpTools(agentId, body = {}) {
    try { return { ok: true, agentId, tools: await mcpStore().setAgentTools(agentId, body.tools) }; }
    catch (error) { return { ok: false, status: String(error?.message || error) === 'agent_not_found' ? 404 : 400, error: String(error?.message || error) }; }
  }

  return {
    mcpConnections,
    saveMcpConnection,
    removeMcpConnection,
    discoverMcpConnection,
    diagnoseMcpConnection,
    agentMcpTools,
    saveAgentMcpTools,
  };
}
