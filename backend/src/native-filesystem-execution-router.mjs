import { createHash } from 'node:crypto';
import { localExecutionTarget, remoteExecutionTarget, resolveProcessExecutionTarget } from './process-execution-router.mjs';

const TOOLS = new Set(['files_read', 'files_list', 'files_find', 'files_inspect', 'files_search', 'files_write', 'files_edit']);

function required(value, name) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${name}_required`);
  return text;
}

export function nativeFilesystemOperationId({ parentRunId, toolCallId } = {}) {
  const digest = createHash('sha256').update(`${required(parentRunId, 'parent_run_id')}\0${required(toolCallId, 'tool_call_id')}`).digest('hex').slice(0, 24);
  return `fs-${digest}`;
}

export function resolveNativeFilesystemExecutionTarget(runContext = {}) {
  return resolveProcessExecutionTarget(runContext);
}

/** Route a native filesystem request through the immutable turn target. */
export function createNativeFilesystemExecutionRouter({ localExecute, remoteController = null } = {}) {
  if (typeof localExecute !== 'function') throw new Error('local_execute_required');
  return async function executeNativeFilesystem(request = {}, context = {}) {
    const target = request.target || localExecutionTarget();
    if (target.kind === 'local') return localExecute(request.operation || request, context);
    if (target.kind !== 'remote') throw new Error('execution_target_invalid');
    if (!remoteController || typeof remoteController.executeNativeFilesystem !== 'function') throw new Error('remote_native_filesystem_controller_unavailable');
    const operation = request.operation || {};
    const tool = required(operation.tool, 'tool');
    if (!TOOLS.has(tool)) throw new Error('native_filesystem_tool_unsupported');
    const parentRunId = required(context.parentRunId, 'parent_run_id');
    const toolCallId = required(context.toolCallId, 'tool_call_id');
    const operationId = context.operationId || nativeFilesystemOperationId({ parentRunId, toolCallId });
    return remoteController.executeNativeFilesystem({
      operationId,
      gatewayId: required(target.gatewayId, 'gateway_id'),
      parentRunId,
      toolCallId,
      operation: { tool, arguments: Object.fromEntries(Object.entries(operation.arguments || {}).filter(([key, value]) => !['traceLogger', 'rootDir', 'artifactPrefix', 'runId'].includes(key) && (value == null || ['string', 'number', 'boolean'].includes(typeof value)))) },
    }, { abortSignal: context.abortSignal || null });
  };
}

export const __nativeFilesystemExecutionRouter__ = Object.freeze({ TOOLS, localExecutionTarget, remoteExecutionTarget });
