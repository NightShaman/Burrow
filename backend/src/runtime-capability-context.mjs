import { McpSettingsStore } from './mcp-settings-store.mjs';
import { nativeToolSchemas } from './action-proposal.mjs';
import { createExecutionContext } from './execution-context.mjs';

export function loadRuntimeMcpCapabilities({ databasePath, agentId } = {}) {
  const mcpTools = new Map();
  const mcpConnections = new Map();
  if (!process.env.BURROW_SETTINGS_KEY) return { mcpTools, mcpConnections };
  const mcpStore = new McpSettingsStore({ databasePath });
  try {
    for (const connection of mcpStore.list()) {
      if (connection.enabled) mcpConnections.set(connection.id, { ...connection, apiKey: mcpStore.apiKey(connection.id), environmentVariables: mcpStore.secretEnvironment(connection.id) });
    }
    for (const grant of mcpStore.agentTools(agentId).filter((item) => item.enabled)) {
      const connection = mcpConnections.get(grant.connectionId);
      if (connection) mcpTools.set(`${grant.connectionId}:${grant.toolName}`, { ...grant, connection, apiKey: connection.apiKey });
    }
  } finally {
    mcpStore.close();
  }
  return { mcpTools, mcpConnections };
}

export function createRuntimeExecutionContext({ runtimeState, resolvedSessionId, conversationId, continuityScope, agentRuntime, resolveAgentRuntime, runAgentReply, resolvedWorkingRoot, resolvedTarget, dataRoot, executionBoundaries, mcpTools, mcpConnections } = {}) {
  const includeAgentChat = Boolean(agentRuntime && typeof resolveAgentRuntime === 'function');
  const includeTaskBoard = Boolean(runtimeState.agentId);
  return createExecutionContext({
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
  });
}
