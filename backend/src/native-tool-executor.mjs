import { redactText } from './redaction.mjs';
import { runExec } from './harness/exec.mjs';
import { createProcessExecutionRouter, resolveProcessExecutionTarget } from './process-execution-router.mjs';
import { createNativeFilesystemExecutionRouter, resolveNativeFilesystemExecutionTarget } from './native-filesystem-execution-router.mjs';
import { readFileEnvelope } from './harness/read-file.mjs';
import { writeFileEnvelope } from './harness/write-file.mjs';
import { applyPatchEnvelope } from './harness/apply-patch.mjs';
import { editFileEnvelope, gitDiffEnvelope, gitStatusEnvelope, globEnvelope, listFilesEnvelope, searchFilesEnvelope, statPathEnvelope } from './harness/developer-tools.mjs';
import { activeModToolConnection } from './mod-agent-tools.mjs';
import { resolveManagedProtectedBindings } from './protected-values.mjs';
import path from 'node:path';

function workspacePath(filePath, workspaceRoot, rootDir) {
  if (!filePath) return filePath;
  if (path.isAbsolute(filePath)) return filePath;
  return path.resolve(workspaceRoot || rootDir || process.cwd(), filePath);
}

function withExecutionProvenance(result, target, executionContext, toolCallId) {
  if (!result || typeof result !== 'object') return result;
  const parentRunId = executionContext?.parentRunId || null;
  return {
    ...result,
    execution: target?.kind === 'remote'
      ? { kind: 'remote', providerId: target.providerId, targetId: target.targetId, parentRunId, toolCallId: toolCallId || null, operationId: result.operationId || null }
      : { kind: 'local', parentRunId, toolCallId: toolCallId || null },
  };
}

// Concrete native filesystem/process implementation for already-reviewed actions.
// The dispatcher owns batch identity, live safety, cancellation fencing and receipts.
export function createNativeToolExecutor({ executionContext = null, executionRoot, rootDir = null, traceLogger = null, artifactPrefix = null, abortSignal = null, agentId = null, sessionId = null, resolvedConversationId = null } = {}) {
  const routeFilesystem = createNativeFilesystemExecutionRouter({
    localExecute: async ({ tool, arguments: args }) => {
      if (tool === 'files_read') return readFileEnvelope(args);
      if (tool === 'files_list') return listFilesEnvelope(args);
      if (tool === 'files_find') return globEnvelope(args);
      if (tool === 'files_inspect') return statPathEnvelope(args);
      if (tool === 'files_search') return searchFilesEnvelope(args);
      if (tool === 'files_write') return writeFileEnvelope(args);
      if (tool === 'files_edit') return editFileEnvelope(args);
      if (tool === 'files_patch') return applyPatchEnvelope(args);
      throw new Error('native_filesystem_tool_unsupported');
    },
    remoteController: executionContext?.processExecutionController || null,
  });
  const executeFilesystem = async (action, args) => {
    const target = resolveNativeFilesystemExecutionTarget(executionContext || {});
    const result = await routeFilesystem({ target, operation: { tool: action.tool, arguments: args } }, {
      parentRunId: executionContext?.parentRunId || traceLogger?.runId,
      toolCallId: action.toolCallId,
      // The remote router starts the Core tool span before resolving its carrier.
      telemetry: executionContext?.telemetry || null,
      traceContext: executionContext?.traceContext || null,
      abortSignal,
    });
    return withExecutionProvenance(result, target, executionContext, action.toolCallId);
  };

  return async function executeNativeTool(action, { observedToolResults = [] } = {}) {
    if (action.tool === 'shell_exec') {
      const target = resolveProcessExecutionTarget(executionContext || {});
      const traceDetails = {
        command: redactText(action.command).slice(0, 2000),
        cwd: redactText(action.cwd ? path.resolve(action.cwd) : executionRoot).slice(0, 1000),
        reason: typeof action.reason === 'string' ? action.reason.slice(0, 500) : null,
        providerId: target.kind === 'remote' ? target.providerId : null,
      };
      const started = await traceLogger?.toolStart?.({
        ...traceDetails,
        tool: 'shell_exec',
        toolCallId: action.toolCallId || null,
        targetId: target.kind === 'remote' ? target.targetId : null,
        executionTarget: target.kind,
      });
      // The authoritative backend resolves protected references. Remote values
      // are passed only to the authenticated process controller, never embedded
      // in command text or ordinary process environment fields.
      const protectedInput = await resolveManagedProtectedBindings(action.protectedBindings, executionContext?.protectedValues, {
        caller: { agentId, sessionId, conversationId: resolvedConversationId },
        authorize: async (entry) => {
          const mod = activeModToolConnection(entry.providerId);
          if (!mod || mod !== entry.mod || !mod.tools.some((tool) => tool.name === entry.toolName)) return false;
          const mcp = executionContext?.stores?.mcp;
          if (!mcp) return false;
          const connection = await mcp.get(entry.providerId);
          const grants = await mcp.agentTools(agentId, {availableOnly:true});
          return Boolean(connection?.enabled && (mod.tools.find((tool) => tool.name === entry.toolName)?.availability === 'mod-authorized' || grants.some((grant) => grant.connectionId === entry.providerId && grant.toolName === entry.toolName && grant.enabled)));
        },
      });
      if (protectedInput.errors.length) {
        const result = { tool: 'shell_exec', ok: false, command: action.command, cwd: action.cwd ? path.resolve(action.cwd) : executionRoot, error: protectedInput.errors.join(','), protectedBindings: protectedInput.bindings };
        return { result, finishTrace: () => (traceLogger?.toolEnd || traceLogger?.tool)?.({
          ...traceDetails,
          tool: 'shell_exec',
          ...(started?.payload?.activityId ? { activityId: started.payload.activityId } : {}),
          toolCallId: action.toolCallId || null,
          targetId: target.kind === 'remote' ? target.targetId : null,
          executionTarget: target.kind,
          ok: false,
          error: result.error,
        }) };
      }
      const process = {
        command: action.command,
        cwd: action.cwd ? path.resolve(action.cwd) : executionRoot,
        env: protectedInput.env,
        traceLogger,
        // This proposal boundary owns the one logical shell tool activity.
        // runExec still writes its usual stdout/stderr/result artifacts.
        emitToolEvents: !traceLogger,
        artifactPrefix: `${artifactPrefix || 'proposal'}-${action.index}-shell_exec`,
        reason: action.reason,
        abortSignal,
        protectedValues: Object.values(protectedInput.env),
      };
      const routeProcess = executionContext?.processExecutionRouter || createProcessExecutionRouter({
        localExecute: runExec,
        remoteController: executionContext?.processExecutionController || null,
      });
      let result;
      try {
        result = await routeProcess({ target, process, protectedBindings: action.protectedBindings,
          ...(target.kind === 'remote' && protectedInput.bindings.length ? { protectedValues: protectedInput.env, protectedBindingMetadata: protectedInput.bindings } : {}) }, {
          parentRunId: executionContext?.parentRunId || traceLogger?.runId,
          toolCallId: action.toolCallId,
          telemetry: executionContext?.telemetry || null,
          traceContext: executionContext?.telemetry?.traceContextForTool?.(executionContext?.parentRunId || traceLogger?.runId, action.toolCallId) || executionContext?.traceContext || null,
          abortSignal,
        });
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : 'process_dispatch_failed';
        result = { tool: 'shell_exec', ok: false, command: action.command, cwd: process.cwd, error: code, failureClass: 'tool_dispatch_failed' };
      }
      if (protectedInput.bindings.length) result.protectedBindings = protectedInput.bindings;
      result = withExecutionProvenance(result, target, executionContext, action.toolCallId);
      return { result, finishTrace: () => (traceLogger?.toolEnd || traceLogger?.tool)?.({
        ...traceDetails,
        exitCode: result.exitCode ?? null,
        signal: result.signal || null,
        timedOut: result.timedOut === true,
        cancelled: result.cancelled === true,
        durationMs: result.durationMs,
        stdoutBytes: Buffer.byteLength(result.stdout || ''),
        stderrBytes: Buffer.byteLength(result.stderr || ''),
        stdoutTruncated: result.stdoutTruncated,
        stderrTruncated: result.stderrTruncated,
        artifacts: result.artifacts,
        operationId: result.execution?.operationId || result.operationId || null,
        tool: 'shell_exec',
        ...(started?.payload?.activityId ? { activityId: started.payload.activityId } : {}),
        toolCallId: action.toolCallId || null,
        targetId: target.kind === 'remote' ? target.targetId : null,
        executionTarget: target.kind,
        ok: result.ok,
        error: result.error || null,
      }) };
    }

    if (action.tool === 'files_read') { return { result: await executeFilesystem(action, { filePath: workspacePath(action.filePath, executionRoot, rootDir), workspaceRoot: executionRoot, rootDir, traceLogger, artifactPrefix: `${artifactPrefix || 'proposal'}-${action.index}-read`, reason: action.reason, offsetBytes: action.offsetBytes ?? 0, ...(action.maxBytes ? { maxBytes: action.maxBytes } : {}) }) }; }
    if (action.tool === 'files_list') { return { result: await executeFilesystem(action, { dirPath: action.dirPath || executionRoot, workspaceRoot: executionRoot, maxDepth: action.maxDepth, maxEntries: action.maxEntries, traceLogger, rootDir, artifactPrefix: `${artifactPrefix || 'proposal'}-${action.index}-list`, reason: action.reason }) }; }
    if (action.tool === 'files_find') { return { result: await executeFilesystem(action, { pattern: action.pattern, dirPath: action.dirPath || executionRoot, workspaceRoot: executionRoot, maxDepth: action.maxDepth, maxEntries: action.maxEntries, traceLogger, rootDir, artifactPrefix: `${artifactPrefix || 'proposal'}-${action.index}-files_find`, reason: action.reason }) }; }
    if (action.tool === 'files_inspect') { return { result: await executeFilesystem(action, { path: workspacePath(action.path, executionRoot, rootDir), workspaceRoot: executionRoot, traceLogger, rootDir, artifactPrefix: `${artifactPrefix || 'proposal'}-${action.index}-stat`, reason: action.reason }) }; }
    if (action.tool === 'files_search') { return { result: await executeFilesystem(action, { query: action.query, dirPath: action.dirPath || executionRoot, workspaceRoot: executionRoot, maxDepth: action.maxDepth, maxMatches: action.maxMatches, traceLogger, rootDir, artifactPrefix: `${artifactPrefix || 'proposal'}-${action.index}-search`, reason: action.reason }) }; }
    if (action.tool === 'git_status' || action.tool === 'git_diff') {
      const target = resolveProcessExecutionTarget(executionContext || {});
      const routeProcess = executionContext?.processExecutionRouter || createProcessExecutionRouter({
        localExecute: runExec,
        remoteController: executionContext?.processExecutionController || null,
      });
      const execute = (process) => routeProcess({ target, process }, {
        parentRunId: executionContext?.parentRunId || traceLogger?.runId,
        toolCallId: action.toolCallId,
        telemetry: executionContext?.telemetry || null,
        traceContext: executionContext?.telemetry?.traceContextForTool?.(executionContext?.parentRunId || traceLogger?.runId, action.toolCallId) || executionContext?.traceContext || null,
        abortSignal,
      });
      const envelope = action.tool === 'git_status' ? gitStatusEnvelope : gitDiffEnvelope;
      const result = await envelope({
        dirPath: action.dirPath || executionRoot, workspaceRoot: executionRoot, traceLogger, rootDir,
        artifactPrefix: `${artifactPrefix || 'proposal'}-${action.index}-${action.tool}`, reason: action.reason, execute,
        toolCallId: action.toolCallId || null, executionTarget: target.kind,
        providerId: target.kind === 'remote' ? target.providerId : null,
        targetId: target.kind === 'remote' ? target.targetId : null,
      });
      return { result: withExecutionProvenance(result, target, executionContext, action.toolCallId) };
    }
    if (action.tool === 'files_edit') { return { result: await executeFilesystem(action, { filePath: workspacePath(action.filePath, executionRoot, rootDir), oldText: action.oldText, newText: action.newText, workspaceRoot: executionRoot, traceLogger, rootDir, artifactPrefix: `${artifactPrefix || 'proposal'}-${action.index}-edit`, reason: action.reason }) }; }

    if (action.tool === 'files_write') {
      return { result: await executeFilesystem(action, {
        filePath: workspacePath(action.filePath, executionRoot, rootDir),
        content: action.content,
        workspaceRoot: executionRoot,
        traceLogger,
        artifactPrefix: `${artifactPrefix || 'proposal'}-${action.index}-write`,
      }) };
    }

    if (action.tool === 'files_patch') {
      return { result: await executeFilesystem(action, {
        patch: action.patch,
        workspaceRoot: executionRoot,
        baseRoot: executionRoot,
        rootDir,
        traceLogger,
        artifactPrefix: `${artifactPrefix || 'proposal'}-${action.index}-patch`,
        observedToolResults,
      }) };
    }

    throw new Error('native_tool_unsupported');
  };
}
