import { persistMcpImages } from './mcp-image-content.mjs';
import { invokeMcpTool, publicMcpError, publicMcpFailureDetail } from './mcporter-adapter.mjs';
import { grantedMcpTool, mcpCapabilitiesReceipt, mcpProvidersReceipt } from './mcp-menu.mjs';
import { activeModToolConnection } from './mod-agent-tools.mjs';
import { credentialProducer, protectMcpOutput, protectToolOutput } from './protected-values.mjs';

// Concrete MCP implementation. Dispatch authorization, cancellation and receipts
// remain the caller's responsibility; grant and live mod checks are local here.
export async function executeMcpTool({ action, executionContext = null, agentId = null, sessionId = null, conversationId = null, resolvedConversationId = null, workspaceRoot = null, rootDir = null, abortSignal = null, traceLogger = null, invokeMcp = invokeMcpTool } = {}) {
  if (action.tool === 'mcp_providers') return { result: mcpProvidersReceipt({ connections: executionContext?.mcpConnections, grants: executionContext?.mcpTools, agentId }) };
  if (action.tool === 'mcp_capabilities') return { result: mcpCapabilitiesReceipt({ connections: executionContext?.mcpConnections, grants: executionContext?.mcpTools, provider: action.mcpProvider, query: action.query, cursor: action.cursor, limit: action.limit }) };
  if (action.tool !== 'mcp_call') throw new Error('mcp_tool_unsupported');
  const selected = grantedMcpTool({ connections: executionContext?.mcpConnections, grants: executionContext?.mcpTools, provider: action.mcpProvider, toolName: action.mcpToolName });
  const started = await traceLogger?.toolStart?.({ tool: 'mcp_call', toolCallId: action.toolCallId || null, provider: action.mcpProvider, mcpToolName: action.mcpToolName, connectionId: selected.connection?.id || null });
  let result;
  try {
    if (selected.error) throw new Error(selected.error);
    if (selected.connection.transport === 'mod') {
      // Reviews and discovery are snapshots. A revoked grant must fail even
      // when a queued action executes later in the same turn.
      const mcp = executionContext?.stores?.mcp;
      if (!mcp) throw new Error('mcp_store_required');
      const liveMod = activeModToolConnection(selected.connection.id);
      const connection = await mcp.get(selected.connection.id);
      if (!liveMod || liveMod !== selected.connection.mod || !liveMod.tools.some((tool) => tool.name === action.mcpToolName) || !connection?.enabled) throw new Error('mcp_provider_not_available');
      const grants = await mcp.agentTools(agentId, {availableOnly:true});
      if (liveMod.tools.find((tool) => tool.name === action.mcpToolName)?.availability !== 'mod-authorized' && !grants.some((grant) => grant.connectionId === selected.connection.id && grant.toolName === action.mcpToolName && grant.enabled)) throw new Error('mcp_tool_not_granted');
    }
    abortSignal?.throwIfAborted();
    const output = selected.connection.transport === 'mod'
      ? await selected.connection.invoke(action.mcpToolName, action.mcpArguments, { context: { agentId, sessionId, conversationId, runId: executionContext?.parentRunId || null }, abortSignal })
      : await invokeMcp(selected.connection, { apiKey: selected.connection.apiKey, headers: selected.connection.headers, environmentVariables: selected.connection.environmentVariables, toolName: action.mcpToolName, arguments: action.mcpArguments, preserveContentResults: true, signal: abortSignal });
    const protectedOutput = selected.connection.transport === 'mod'
      ? protectToolOutput(output, { registry: executionContext?.protectedValues,
        managedIssuer: (declaration) => {
          if (!agentId || !executionContext?.protectedValues || typeof selected.connection.resolveProtectedReference !== 'function') return null;
          return { managed: true, reference: declaration.reference, version: declaration.version,
            providerId: selected.connection.id,
            toolName: action.mcpToolName, mod: selected.connection.mod,
            caller: { agentId, sessionId, conversationId: resolvedConversationId },
            resolve: (reference, caller) => selected.connection.resolveProtectedReference(action.mcpToolName, reference, caller) };
        } })
      : protectMcpOutput(output, { provider: selected.connection.name, toolName: action.mcpToolName, mcpArguments: action.mcpArguments, registry: executionContext?.protectedValues });
    const withheld = protectedOutput.protection.status === 'withheld';
    const imageResult = await persistMcpImages(protectedOutput.safeOutput, {
      agentWorkspaceRoot: executionContext?.agentWorkspaceRoot || workspaceRoot || rootDir,
      retentionDays: executionContext?.stores?.albdruck ? (await executionContext.stores.albdruck.readRetention()).attachmentDays : 30,
    });
    const isError = imageResult.output?.isError === true;
    result = {
      tool: 'mcp_call', ok: !withheld && !isError, provider: selected.connection.name, mcpToolName: action.mcpToolName, connectionId: selected.connection.id,
      output: imageResult.output,
      ...(imageResult.attachments.length ? { attachments: imageResult.attachments } : {}),
      ...(isError ? { error: 'mcp_tool_failed' } : {}),
      protection: protectedOutput.protection,
      ...(withheld ? { error: 'mcp_sensitive_response_withheld' } : {}),
      ...(protectedOutput.protectedValues.length ? { protectedValues: protectedOutput.protectedValues } : {}),
    };
  } catch (error) {
    const sensitiveProducer = credentialProducer({ provider: selected.connection?.name || action.mcpProvider, toolName: action.mcpToolName, mcpArguments: action.mcpArguments });
    result = {
      tool: 'mcp_call', ok: false, provider: action.mcpProvider, mcpToolName: action.mcpToolName, connectionId: selected.connection?.id || null,
      error: selected.connection?.transport === 'mod' ? (error?.message === 'mcp_tool_not_granted' ? 'mcp_tool_not_granted' : 'mcp_tool_failed') : publicMcpError(error, 'mcp_tool_failed'),
      // Credential providers may place retrieved values in an isError text
      // payload. That payload has not crossed the protection adapter, so do
      // not project free-form diagnostics from it into model-visible state.
      ...(selected.connection?.transport === 'mod' || sensitiveProducer ? {} : publicMcpFailureDetail(error, [selected.connection?.apiKey, ...Object.values(selected.connection?.environmentVariables || {}), ...Object.values(selected.connection?.headers || {})])),
    };
  }
  return { result, finishTrace: () => (traceLogger?.toolEnd || traceLogger?.tool)?.({ tool: 'mcp_call', toolCallId: action.toolCallId || null, ...(started?.payload?.activityId ? { activityId: started.payload.activityId } : {}), ok: result.ok, provider: result.provider, mcpToolName: result.mcpToolName, connectionId: result.connectionId, error: result.error || null }) };
}
