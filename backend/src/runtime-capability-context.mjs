import { modToolConnections } from './mod-agent-tools.mjs';
import { McpSettingsStore } from './mcp-settings-store.mjs';
import { nativeToolSchemas } from './action-proposal.mjs';
import { createExecutionContext } from './execution-context.mjs';

export async function loadRuntimeMcpCapabilities({ databasePath, agentId, stores = null } = {}) {
  const mcpTools = new Map();
  const mcpConnections = new Map();
  const mcpStore = stores?.mcp || (process.env.BURROW_SETTINGS_KEY ? new McpSettingsStore({ databasePath }) : null);
  if (!mcpStore) return { mcpTools, mcpConnections };
  try {
    const connections = await mcpStore.list();
    for (const connection of connections) {
      if (!connection.enabled) continue;
      const isMod = String(connection.id).startsWith('mod.') || String(connection.baseUrl || '').startsWith('mod://');
      if (isMod) continue; // Only the live host registry can authorize mod invocation.
      const enriched = { ...connection, apiKey: await mcpStore.apiKey(connection.id), environmentVariables: await mcpStore.secretEnvironment(connection.id) };
      mcpConnections.set(connection.id, enriched);
    }
    // The live host registry supplies invocation for mod tools. Its catalog is
    // layered over the persisted catalog, never used to replace it wholesale.
    for (const connection of modToolConnections(databasePath)) {
      const persisted = await mcpStore.get(connection.id);
      if (persisted?.enabled) mcpConnections.set(connection.id, { ...persisted, ...connection });
    }
    for (const grant of (await mcpStore.agentTools(agentId)).filter((item) => item.enabled)) {
      const connection = mcpConnections.get(grant.connectionId);
      if (connection) mcpTools.set(`${grant.connectionId}:${grant.toolName}`, { ...grant, connection, apiKey: connection.apiKey });
    }
  } finally {
    if (!stores?.mcp) await mcpStore.close?.();
  }
  return { mcpTools, mcpConnections };
}

export function createRuntimeExecutionContext({ stores = null, runtimeState, resolvedSessionId, conversationId, continuityScope, agentRuntime, resolveAgentRuntime, runAgentReply, resolvedWorkingRoot, resolvedTarget, dataRoot, executionBoundaries, mcpTools, mcpConnections, parentRunId = null } = {}) {
  const includeAgentChat = Boolean(agentRuntime && typeof resolveAgentRuntime === 'function');
  const includeTaskBoard = Boolean(runtimeState.agentId);
  return createExecutionContext({
    conversationStore: stores?.conversations,
    sessionId: resolvedSessionId,
    conversationId,
    continuityScope,
    agentId: runtimeState.agentId,
    includeAgentChat,
    includeTaskBoard,
    agentRuntime,
    resolveAgentRuntime,
    runAgentReply,
    workspaceRoot: resolvedWorkingRoot,
    target: resolvedTarget,
    dataRoot,
    cacheRoot: runtimeState.cacheRoot,
    settingsDatabasePath: runtimeState.settingsDatabasePath,
    agentWorkspaceRoot: agentRuntime?.agentWorkspaceRoot,
    agentDataRoot: agentRuntime?.agentDataRoot,
    skillsRoot: agentRuntime?.skillsRoot,
    filesystemBoundaries: agentRuntime?.filesystemBoundaries || runtimeState.filesystemBoundaries,
    executionBoundaries,
    toolSchemas: nativeToolSchemas({ includeWorkingMemory: Boolean(runtimeState.agentId), includeAgentProfile: Boolean(runtimeState.agentId && runtimeState.settingsDatabasePath), includeAgentChat, includeTaskBoard, includeMcpMenu: mcpConnections.size > 0 }),
    mcpTools,
    mcpConnections,
    protectedValues: new Map(),
    executionEnvironment: agentRuntime?.executionEnvironment || { kind: 'local', workspaceRoot: resolvedWorkingRoot },
    processExecutionController: agentRuntime?.processExecutionController || null,
    parentRunId,
  });
}
