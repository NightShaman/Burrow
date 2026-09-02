import { runExec } from './harness/exec.mjs';
import { createProcessExecutionRouter, resolveProcessExecutionTarget } from './process-execution-router.mjs';
import { createNativeFilesystemExecutionRouter, resolveNativeFilesystemExecutionTarget } from './native-filesystem-execution-router.mjs';
import { readFileEnvelope } from './harness/read-file.mjs';
import { writeFileEnvelope } from './harness/write-file.mjs';
import { applyPatchEnvelope } from './harness/apply-patch.mjs';
import { editFileEnvelope, gitDiffEnvelope, gitStatusEnvelope, globEnvelope, listFilesEnvelope, searchFilesEnvelope, statPathEnvelope } from './harness/developer-tools.mjs';
import { executeSpawnSubagentTool } from './subagent-tool-executor.mjs';
import { sendAgentMessage } from './agent-chat-tool.mjs';
import { updateOwnToolsProfile } from './agent-profile-tool.mjs';
import { executeContinuityHandoffWriteTool, executeRollingContinuitySearchTool, executeSessionHandoffReadTool, executeWorkingMemoryRecordTool, executeWorkingMemorySearchTool } from './memory-tool-executor.mjs';
import { searchAgentSessionEvidence } from './session-search.mjs';
import { executeTaskBoardCreateTool, executeTaskBoardDeleteTool, executeTaskBoardListTool, executeTaskBoardReassignTool, executeTaskBoardUpdateTool } from './task-board-tool-executor.mjs';
import { compactToolReceipts } from './runtime-result-shapes.mjs';
import { reviewProposalActions } from './action-safety.mjs';
import { invokeMcpTool, publicMcpError, publicMcpFailureDetail } from './mcporter-adapter.mjs';
import { grantedMcpTool, mcpCapabilitiesReceipt, mcpProvidersReceipt } from './mcp-menu.mjs';
import { protectMcpOutput, resolveProtectedBindings } from './protected-values.mjs';
import { loadEffectiveSkillCatalog, loadSelectedSkillText, skillManifest, selectCatalogSkills } from './skill-catalog.mjs';
import path from 'node:path';

function workspacePath(filePath, workspaceRoot, rootDir) {
  if (!filePath) return filePath;
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(workspaceRoot || rootDir || process.cwd(), filePath);
}

export async function executeReviewedProposalActions({ actions = [], reviews = [], workspaceRoot = null, rootDir = null, dataRoot = null, sessionId = null, conversationId = null, agentId = null, agentRuntime = null, resolveAgentRuntime = null, runAgentReply = null, workingMemoryStore = null, executionPolicy = null, modelConfig = null, traceLogger = null, artifactPrefix = null, observedToolResults = [], executionContext = null, abortSignal = null } = {}) {
  agentId = agentId || executionContext?.agentId || null;
  const resolvedConversationId = conversationId || executionContext?.conversationId || null;
  // Agent home is the normal-chat default. Explicit internal/delegated
  // structural targets remain valid one-turn execution contexts; a model may
  // otherwise choose an absolute cwd for one shell_exec call.
  const executionRoot = executionContext?.target?.kind === 'filesystem'
    ? executionContext.target.root
    : executionContext?.workspaceRoot || workspaceRoot || rootDir || process.cwd();
  const toolResults = [];
  const skipped = [];
  const routeFilesystem = createNativeFilesystemExecutionRouter({
    localExecute: async ({ tool, arguments: args }) => {
      if (tool === 'files_read') return readFileEnvelope(args);
      if (tool === 'files_list') return listFilesEnvelope(args);
      if (tool === 'files_find') return globEnvelope(args);
      if (tool === 'files_inspect') return statPathEnvelope(args);
      if (tool === 'files_search') return searchFilesEnvelope(args);
      if (tool === 'files_write') return writeFileEnvelope(args);
      if (tool === 'files_edit') return editFileEnvelope(args);
      throw new Error('native_filesystem_tool_unsupported');
    },
    remoteController: executionContext?.processExecutionController || null,
  });
  const executeFilesystem = (action, args) => routeFilesystem({
    target: resolveNativeFilesystemExecutionTarget(executionContext || {}),
    operation: { tool: action.tool, arguments: args },
  }, { parentRunId: executionContext?.parentRunId || traceLogger?.runId, toolCallId: action.toolCallId, abortSignal });

  for (const action of actions) {
    const suppliedReview = reviews.find((item) => item.index === action.index) || null;
    if (suppliedReview?.status !== 'allowed') {
      const status = suppliedReview?.status || 'unreviewed';
      skipped.push({ index: action.index, tool: action.tool, status, ...((suppliedReview?.blockers || []).length ? { blockers: suppliedReview.blockers } : {}) });
      continue;
    }
    // Recheck at the concrete executor boundary. Supplied allowed reviews are
    // useful receipts, but they are not trusted authority; a stale/forged
    // allowed review must not bypass operator hard blocks or parser errors.
    const executionReview = reviewProposalActions({ actions: [action], workspaceRoot: executionRoot, executionContext }).reviews[0] || suppliedReview;
    if (executionReview?.status !== 'allowed') {
      skipped.push({ index: action.index, tool: action.tool, status: executionReview?.status || 'blocked', ...((executionReview?.blockers || []).length ? { blockers: executionReview.blockers } : {}) });
      continue;
    }
    if (action.tool === 'shell_exec') {
      const target = resolveProcessExecutionTarget(executionContext || {});
      // The authoritative backend resolves protected references. Remote values
      // are passed only to the authenticated process controller, never embedded
      // in command text or ordinary process environment fields.
      const protectedInput = resolveProtectedBindings(action.protectedBindings, executionContext?.protectedValues);
      if (protectedInput.errors.length) {
        toolResults.push({ tool: 'shell_exec', ok: false, command: action.command, cwd: action.cwd ? path.resolve(action.cwd) : executionRoot, error: protectedInput.errors.join(','), protectedBindings: protectedInput.bindings });
        continue;
      }
      const process = {
        command: action.command,
        cwd: action.cwd ? path.resolve(action.cwd) : (executionContext?.executionEnvironment?.workspaceRoot || executionRoot),
        env: protectedInput.env,
        traceLogger,
        artifactPrefix: `${artifactPrefix || 'proposal'}-${action.index}-shell_exec`,
        reason: action.reason,
        abortSignal,
        protectedValues: Object.values(protectedInput.env),
      };
      const routeProcess = executionContext?.processExecutionRouter || createProcessExecutionRouter({
        localExecute: runExec,
        remoteController: executionContext?.processExecutionController || null,
      });
      const result = await routeProcess({ target, process, protectedBindings: action.protectedBindings,
        ...(target.kind === 'remote' && protectedInput.bindings.length ? { protectedValues: protectedInput.env, protectedBindingMetadata: protectedInput.bindings } : {}) }, {
        parentRunId: executionContext?.parentRunId || traceLogger?.runId,
        toolCallId: action.toolCallId,
        abortSignal,
      });
      if (protectedInput.bindings.length) result.protectedBindings = protectedInput.bindings;
      toolResults.push(result);
      continue;
    }

    if (action.tool === 'files_read') { toolResults.push(await executeFilesystem(action, { filePath: workspacePath(action.filePath, executionRoot, rootDir), workspaceRoot: executionRoot, rootDir, traceLogger, artifactPrefix: `${artifactPrefix || 'proposal'}-${action.index}-read`, reason: action.reason, offsetBytes: action.offsetBytes ?? 0, ...(action.maxBytes ? { maxBytes: action.maxBytes } : {}) })); continue; }
    if (action.tool === 'files_list') { toolResults.push(await executeFilesystem(action, { dirPath: action.dirPath || executionRoot, workspaceRoot: executionRoot, maxDepth: action.maxDepth, maxEntries: action.maxEntries, traceLogger, rootDir, artifactPrefix: `${artifactPrefix || 'proposal'}-${action.index}-list`, reason: action.reason })); continue; }
    if (action.tool === 'files_find') { toolResults.push(await executeFilesystem(action, { pattern: action.pattern, dirPath: action.dirPath || executionRoot, workspaceRoot: executionRoot, maxDepth: action.maxDepth, maxEntries: action.maxEntries, traceLogger, rootDir, artifactPrefix: `${artifactPrefix || 'proposal'}-${action.index}-files_find`, reason: action.reason })); continue; }
    if (action.tool === 'files_inspect') { toolResults.push(await executeFilesystem(action, { path: workspacePath(action.path, executionRoot, rootDir), workspaceRoot: executionRoot, traceLogger, rootDir, artifactPrefix: `${artifactPrefix || 'proposal'}-${action.index}-stat`, reason: action.reason })); continue; }
    if (action.tool === 'files_search') { toolResults.push(await executeFilesystem(action, { query: action.query, dirPath: action.dirPath || executionRoot, workspaceRoot: executionRoot, maxDepth: action.maxDepth, maxMatches: action.maxMatches, traceLogger, rootDir, artifactPrefix: `${artifactPrefix || 'proposal'}-${action.index}-search`, reason: action.reason })); continue; }
    if (action.tool === 'git_status' || action.tool === 'git_diff') {
      const target = resolveProcessExecutionTarget(executionContext || {});
      const routeProcess = executionContext?.processExecutionRouter || createProcessExecutionRouter({
        localExecute: runExec,
        remoteController: executionContext?.processExecutionController || null,
      });
      const execute = (process) => routeProcess({ target, process }, {
        parentRunId: executionContext?.parentRunId || traceLogger?.runId,
        toolCallId: action.toolCallId,
        abortSignal,
      });
      const envelope = action.tool === 'git_status' ? gitStatusEnvelope : gitDiffEnvelope;
      toolResults.push(await envelope({ dirPath: action.dirPath || executionRoot, workspaceRoot: executionRoot, traceLogger, rootDir, artifactPrefix: `${artifactPrefix || 'proposal'}-${action.index}-${action.tool}`, reason: action.reason, execute }));
      continue;
    }
    if (action.tool === 'files_edit') { toolResults.push(await executeFilesystem(action, { filePath: workspacePath(action.filePath, executionRoot, rootDir), oldText: action.oldText, newText: action.newText, workspaceRoot: executionRoot, traceLogger, rootDir, artifactPrefix: `${artifactPrefix || 'proposal'}-${action.index}-edit`, reason: action.reason })); continue; }

    if (action.tool === 'list_skills' || action.tool === 'load_skill') {
      const skillsWorkspace = executionContext?.agentWorkspaceRoot ? path.dirname(executionContext.agentWorkspaceRoot) : executionRoot;
      const catalog = await loadEffectiveSkillCatalog({ workspaceRoot: skillsWorkspace, agentId: agentId || executionContext?.agentId || 'hatchet', agentRuntime: executionContext?.agentRuntime || null });
      const started = await traceLogger?.toolStart?.({ tool: action.tool, skillId: action.skillId || null, catalogCount: catalog.availableSkills.length });
      let result;
      if (action.tool === 'list_skills') {
        result = { tool: 'list_skills', ok: true, skills: catalog.availableSkills.map(skillManifest) };
      } else {
        const choice = selectCatalogSkills({ catalog: catalog.skills, ids: [action.skillId], source: 'agent-requested' });
        if (!choice.selected.length) result = { tool: 'load_skill', ok: false, skillId: action.skillId, error: choice.rejected[0]?.reason || 'skill_not_found' };
        else {
          const loaded = await loadSelectedSkillText(skillsWorkspace, choice.selected, { maxTotalChars: 64_000, maxPerSkillChars: 64_000 });
          const skill = loaded[0];
          result = skill.missing ? { tool: 'load_skill', ok: false, skillId: action.skillId, error: skill.error || 'skill_source_missing' } : { tool: 'load_skill', ok: true, skill: { ...skillManifest(skill), version: skill.version, content: skill.content, contentTruncated: skill.contentTruncated } };
        }
      }
      toolResults.push(result);
      await (traceLogger?.toolEnd || traceLogger?.tool)?.({
        tool: action.tool,
        ...(started?.payload?.activityId ? { activityId: started.payload.activityId } : {}),
        ok: result.ok,
        skillId: action.skillId || null,
        version: result.skill?.version || null,
        // Preserve discovery cards, but never loaded skill body in trace events.
        skills: action.tool === 'list_skills' ? result.skills.map(({ id, name, description, lifecycle, available, owner, ownership }) => ({ id, name, description, lifecycle, available, owner, ownership: ownership ? { scope: ownership.scope, agentId: ownership.agentId } : null })) : undefined,
        error: result.error || null,
      });
      continue;
    }

    if (action.tool === 'mcp_providers') {
      const result = mcpProvidersReceipt({ connections: executionContext?.mcpConnections, grants: executionContext?.mcpTools, agentId });
      toolResults.push(result);
      continue;
    }

    if (action.tool === 'mcp_capabilities') {
      const result = mcpCapabilitiesReceipt({ connections: executionContext?.mcpConnections, grants: executionContext?.mcpTools, provider: action.mcpProvider, query: action.query, cursor: action.cursor, limit: action.limit });
      toolResults.push(result);
      continue;
    }

    if (action.tool === 'mcp_call') {
      const selected = grantedMcpTool({ connections: executionContext?.mcpConnections, grants: executionContext?.mcpTools, provider: action.mcpProvider, toolName: action.mcpToolName });
      const started = await traceLogger?.toolStart?.({ tool: 'mcp_call', provider: action.mcpProvider, mcpToolName: action.mcpToolName, connectionId: selected.connection?.id || null });
      let result;
      try {
        if (selected.error) throw new Error(selected.error);
        const output = await invokeMcpTool(selected.connection, { apiKey: selected.connection.apiKey, environmentVariables: selected.connection.environmentVariables, toolName: action.mcpToolName, arguments: action.mcpArguments });
        const protectedOutput = protectMcpOutput(output, { provider: selected.connection.name, toolName: action.mcpToolName, mcpArguments: action.mcpArguments, registry: executionContext?.protectedValues });
        result = { tool: 'mcp_call', ok: true, provider: selected.connection.name, mcpToolName: action.mcpToolName, connectionId: selected.connection.id, output: protectedOutput.safeOutput, ...(protectedOutput.protectedValues.length ? { protectedValues: protectedOutput.protectedValues } : {}) };
      } catch (error) { result = { tool: 'mcp_call', ok: false, provider: action.mcpProvider, mcpToolName: action.mcpToolName, connectionId: selected.connection?.id || null, error: publicMcpError(error, 'mcp_tool_failed'), ...publicMcpFailureDetail(error, [selected.connection?.apiKey, ...Object.values(selected.connection?.environmentVariables || {})]) }; }
      toolResults.push(result);
      await (traceLogger?.toolEnd || traceLogger?.tool)?.({ tool: 'mcp_call', ...(started?.payload?.activityId ? { activityId: started.payload.activityId } : {}), ok: result.ok, provider: result.provider, mcpToolName: result.mcpToolName, connectionId: result.connectionId, error: result.error || null });
      continue;
    }

    if (action.tool === 'session_search') {
      const started = await traceLogger?.toolStart?.({ tool: 'session_search', query: action.query, scope: action.sessionScope });
      const result = await searchAgentSessionEvidence({
        rootDir: executionContext?.agentWorkspaceRoot || rootDir,
        additionalRootDirs: [dataRoot || executionContext?.dataRoot].filter(Boolean),
        dataRoot: executionContext?.agentDataRoot || dataRoot,
        agentId,
        sessionId: sessionId || executionContext?.sessionId || 'default',
        query: action.query,
        scope: action.sessionScope,
        limit: action.limit,
      });
      toolResults.push(result);
      await (traceLogger?.toolEnd || traceLogger?.tool)?.({
        tool: 'session_search',
        ...(started?.payload?.activityId ? { activityId: started.payload.activityId } : {}),
        ok: result.ok,
        query: result.query,
        scope: result.scope,
        resultCount: result.count,
      });
      continue;
    }

    if (action.tool === 'memory_working_search') {
      const started = await traceLogger?.toolStart?.({ tool: 'memory_working_search', query: action.query, project: action.project || null });
      const result = executeWorkingMemorySearchTool({ arguments: { query: action.query, project: action.project, limit: action.limit }, agentId, continuityScope: executionContext?.continuityScope, store: workingMemoryStore });
      toolResults.push(result);
      await (traceLogger?.toolEnd || traceLogger?.tool)?.({ tool: 'memory_working_search', ...(started?.payload?.activityId ? { activityId: started.payload.activityId } : {}), ok: result.ok, query: result.query, project: result.project, resultCount: result.resultCount ?? 0, error: result.error || null });
      continue;
    }

    if (action.tool === 'memory_rolling_search') {
      const started = await traceLogger?.toolStart?.({ tool: 'memory_rolling_search', query: action.query, project: action.project || null });
      const result = executeRollingContinuitySearchTool({ arguments: { query: action.query, project: action.project, limit: action.limit }, agentId, continuityScope: executionContext?.continuityScope, store: workingMemoryStore });
      toolResults.push(result);
      await (traceLogger?.toolEnd || traceLogger?.tool)?.({ tool: 'memory_rolling_search', ...(started?.payload?.activityId ? { activityId: started.payload.activityId } : {}), ok: result.ok, query: result.query, project: result.project, resultCount: result.resultCount ?? 0, error: result.error || null });
      continue;
    }

    if (action.tool === 'memory_working_write') {
      const started = await traceLogger?.toolStart?.({ tool: 'memory_working_write', project: action.project, kind: action.memoryKind });
      const result = executeWorkingMemoryRecordTool({ arguments: { project: action.project, kind: action.memoryKind, state: action.state, title: action.title, content: action.content, sourceRefs: action.sourceRefs }, agentId, sessionId, conversationId: resolvedConversationId, continuityScope: executionContext?.continuityScope, store: workingMemoryStore });
      toolResults.push(result);
      await (traceLogger?.toolEnd || traceLogger?.tool)?.({ tool: 'memory_working_write', ...(started?.payload?.activityId ? { activityId: started.payload.activityId } : {}), ok: result.ok, record: result.record || null, error: result.error || null });
      continue;
    }

    if (action.tool === 'session_read_handoff') {
      const started = await traceLogger?.toolStart?.({ tool: 'session_read_handoff' });
      const result = executeSessionHandoffReadTool({ agentId, sessionId: sessionId || executionContext?.sessionId || 'default', dataRoot: executionContext?.agentDataRoot || dataRoot });
      toolResults.push(result);
      await (traceLogger?.toolEnd || traceLogger?.tool)?.({ tool: 'session_read_handoff', ...(started?.payload?.activityId ? { activityId: started.payload.activityId } : {}), ok: result.ok, found: Boolean(result.handoff), error: result.error || null });
      continue;
    }

    if (action.tool === 'session_write_handoff') {
      const started = await traceLogger?.toolStart?.({ tool: 'session_write_handoff' });
      const result = executeContinuityHandoffWriteTool({ arguments: { title: action.title, content: action.content, sourceRefs: action.sourceRefs }, agentId, sessionId, runId: traceLogger?.runId || null, dataRoot: executionContext?.agentDataRoot || dataRoot });
      toolResults.push(result);
      await (traceLogger?.toolEnd || traceLogger?.tool)?.({ tool: 'session_write_handoff', ...(started?.payload?.activityId ? { activityId: started.payload.activityId } : {}), ok: result.ok, handoff: result.handoff || null, error: result.error || null });
      continue;
    }

    if (action.tool === 'tasks_list') {
      const started = await traceLogger?.toolStart?.({ tool: 'tasks_list', projectId: action.project || null });
      const result = executeTaskBoardListTool({ arguments: { projectId: action.project, status: action.status, priority: action.priority, assignedAgentId: action.assignedAgentId }, databasePath: executionContext?.settingsDatabasePath });
      toolResults.push(result);
      await (traceLogger?.toolEnd || traceLogger?.tool)?.({ tool: 'tasks_list', ...(started?.payload?.activityId ? { activityId: started.payload.activityId } : {}), ok: result.ok, resultCount: result.resultCount, error: result.error || null });
      continue;
    }
    if (action.tool === 'tasks_create') {
      const started = await traceLogger?.toolStart?.({ tool: 'tasks_create', projectId: action.project || null });
      const result = executeTaskBoardCreateTool({ arguments: { projectId: action.project, title: action.title, ...(action.description === null ? {} : { description: action.description }), ...(action.status === null ? {} : { status: action.status }), ...(action.priority === null ? {} : { priority: action.priority }), ...(action.metadata === null ? {} : { metadata: action.metadata }), ...(action.assignedAgentId === null ? {} : { assignedAgentId: action.assignedAgentId }) }, agentId, databasePath: executionContext?.settingsDatabasePath });
      toolResults.push(result);
      await (traceLogger?.toolEnd || traceLogger?.tool)?.({ tool: 'tasks_create', ...(started?.payload?.activityId ? { activityId: started.payload.activityId } : {}), ok: result.ok, task: result.task || null, error: result.error || null });
      continue;
    }
    if (action.tool === 'tasks_update') {
      const started = await traceLogger?.toolStart?.({ tool: 'tasks_update', taskId: action.taskId });
      const result = executeTaskBoardUpdateTool({ arguments: { taskId: action.taskId, ...(action.title === null ? {} : { title: action.title }), ...(action.description === null ? {} : { description: action.description }), ...(action.status === null ? {} : { status: action.status }), ...(action.priority === null ? {} : { priority: action.priority }), ...(action.metadata === null ? {} : { metadata: action.metadata }), ...(action.assignedAgentId === null ? {} : { assignedAgentId: action.assignedAgentId }) }, agentId, databasePath: executionContext?.settingsDatabasePath });
      toolResults.push(result);
      await (traceLogger?.toolEnd || traceLogger?.tool)?.({ tool: 'tasks_update', ...(started?.payload?.activityId ? { activityId: started.payload.activityId } : {}), ok: result.ok, task: result.task || null, error: result.error || null });
      continue;
    }

    if (action.tool === 'tasks_assign') {
      const started = await traceLogger?.toolStart?.({ tool: 'tasks_assign', taskId: action.taskId, assignedAgentId: action.assignedAgentId });
      const result = executeTaskBoardReassignTool({ arguments: { taskId: action.taskId, assignedAgentId: action.assignedAgentId }, agentId, databasePath: executionContext?.settingsDatabasePath });
      toolResults.push(result);
      await (traceLogger?.toolEnd || traceLogger?.tool)?.({ tool: 'tasks_assign', ...(started?.payload?.activityId ? { activityId: started.payload.activityId } : {}), ok: result.ok, task: result.task || null, error: result.error || null });
      continue;
    }
    if (action.tool === 'tasks_delete') {
      const started = await traceLogger?.toolStart?.({ tool: 'tasks_delete', taskId: action.taskId });
      const result = executeTaskBoardDeleteTool({ arguments: { taskId: action.taskId }, databasePath: executionContext?.settingsDatabasePath });
      toolResults.push(result);
      await (traceLogger?.toolEnd || traceLogger?.tool)?.({ tool: 'tasks_delete', ...(started?.payload?.activityId ? { activityId: started.payload.activityId } : {}), ok: result.ok, task: result.task || null, error: result.error || null });
      continue;
    }
    if (action.tool === 'agent_update_tools_profile') {
      const started = await traceLogger?.toolStart?.({ tool: 'agent_update_tools_profile', agentId });
      const result = updateOwnToolsProfile({ agentId, markdown: action.profileToolsContent, databasePath: executionContext?.settingsDatabasePath });
      toolResults.push(result);
      await (traceLogger?.toolEnd || traceLogger?.tool)?.({ tool: 'agent_update_tools_profile', ...(started?.payload?.activityId ? { activityId: started.payload.activityId } : {}), ok: result.ok, agentId: agentId || null, document: result.document || null, error: result.error || null });
      continue;
    }

    if (action.tool === 'files_write') {
      toolResults.push(await executeFilesystem(action, {
        filePath: workspacePath(action.filePath, executionRoot, rootDir),
        content: action.content,
        workspaceRoot: executionRoot,
        traceLogger,
        artifactPrefix: `${artifactPrefix || 'proposal'}-${action.index}-write`,
      }));
      continue;
    }

    if (action.tool === 'files_patch') {
      toolResults.push(await applyPatchEnvelope({
        patch: action.patch,
        workspaceRoot: executionRoot,
        baseRoot: executionRoot,
        rootDir,
        traceLogger,
        artifactPrefix: `${artifactPrefix || 'proposal'}-${action.index}-patch`,
        observedToolResults: [...observedToolResults, ...toolResults],
      }));
      continue;
    }

    if (action.tool === 'agent_send_message') {
      const started = await traceLogger?.toolStart?.({ tool: 'agent_send_message', recipientAgentId: action.recipientAgentId, targetSessionId: action.targetSessionId || 'default', messageMode: action.messageMode || 'request_reply' });
      let result;
      try {
        result = await sendAgentMessage({ senderRuntime: agentRuntime || executionContext?.agentRuntime, resolveRecipientRuntime: resolveAgentRuntime || executionContext?.resolveAgentRuntime, runRecipientReply: runAgentReply || executionContext?.runAgentReply, recipientAgentId: action.recipientAgentId, targetSessionId: action.targetSessionId || 'default', content: action.content, messageMode: action.messageMode || 'request_reply', runId: traceLogger?.runId || null, sourceSessionId: sessionId });
      } catch (error) {
        result = { tool: 'agent_send_message', ok: false, recipientAgentId: action.recipientAgentId || null, targetSessionId: action.targetSessionId || 'default', error: error?.message || String(error), autoExecuted: false };
      }
      toolResults.push(result);
      await (traceLogger?.toolEnd || traceLogger?.tool)?.({
        tool: 'agent_send_message',
        ...(started?.payload?.activityId ? { activityId: started.payload.activityId } : {}),
        ok: result.ok,
        senderAgentId: result.senderAgentId || agentRuntime?.agentId || executionContext?.agentRuntime?.agentId || null,
        recipientAgentId: result.recipientAgentId || action.recipientAgentId || null,
        sourceSessionId: result.sourceSessionId || sessionId || null,
        targetSessionId: result.targetSessionId || action.targetSessionId || 'default',
        sourceEntryId: result.sourceEntryId || null,
        recipientEntryId: result.recipientEntryId || null,
        mirroredReplyEntryId: result.reply?.entryId || null,
        recipientReplyEntryId: result.reply?.recipientReplyEntryId || null,
        messageMode: result.messageMode || action.messageMode || 'request_reply',
        autoExecuted: false,
        error: result.error || result.reply?.error || null,
      });
      continue;
    }

    if (action.tool === 'spawn_subagent') {
      const started = await traceLogger?.toolStart?.({ tool: 'spawn_subagent', label: action.label || null, task: action.task || action.purpose || action.reason || null, model: action.model || null, modelProfile: action.modelProfile || null, target: action.target || null });
      const result = await executeSpawnSubagentTool({
        arguments: {
          task: action.task || action.purpose || action.reason,
          label: action.label,
          model: action.model,
          modelProfile: action.modelProfile,
          timeoutMs: action.timeoutMs,
          target: action.target,
          activityId: started?.payload?.activityId || null,
        },
        executionContext,
        rootDir,
        dataRoot,
        sessionId,
        conversationId: resolvedConversationId,
        runId: traceLogger?.runId || null,
        traceLogger,
        modelConfig,
        executionPolicy,
        });
      toolResults.push(result);
      // The subagent executor emits the matching result with this activity ID;
      // it owns the child-process lifecycle and must close the live row.
      continue;
    }

    skipped.push({ index: action.index, tool: action.tool, status: 'unsupported_executor_tool' });
  }

  // Raw results remain local to this executor while an action is running.
  // The returned execution state is deliberately receipt-only.
  return {
    executed: toolResults.length,
    skipped,
    // Native provider continuations need the original result only long enough
    // to serialize its call-ID-paired tool message. Durable/runtime receipts
    // stay compact and never become a second prompt-evidence clipboard.
    nativeToolResults: toolResults,
    toolResults: compactToolReceipts(toolResults),
  };
}
