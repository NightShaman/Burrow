import { createHash } from 'node:crypto';
import { remoteTelemetryConfiguration } from './remote-telemetry-configuration.mjs';
import { localExecutionTarget, remoteExecutionTarget, resolveProcessExecutionTarget } from './process-execution-router.mjs';

const TOOLS = new Set(['files_read', 'files_list', 'files_find', 'files_inspect', 'files_search', 'files_write', 'files_edit', 'files_patch']);

function failure(tool, args, error) {
  const code = String(error?.code || error?.message || 'native_filesystem_failed').split(':')[0];
  const base = { tool, ok: false, error: code, diagnostic: { code, message: code }, warnings: [], artifacts: null };
  if (tool === 'files_read' || tool === 'files_write' || tool === 'files_edit') return { ...base, filePath: args?.filePath || null };
  if (tool === 'files_inspect') return { ...base, path: args?.path || null };
  return { ...base, dirPath: args?.dirPath || null };
}

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
    if (target.kind === 'local') {
      const operation = request.operation || request;
      try { return await localExecute(operation, context); }
      catch (error) { return failure(operation?.tool || 'native_filesystem', operation?.arguments || {}, error); }
    }
    if (target.kind !== 'remote') throw new Error('execution_target_invalid');
    const operation = request.operation || {};
    const available = typeof remoteController?.executeNativeFilesystem === 'function';
    // Preserve validation errors for malformed requests when a controller exists.
    const tool = available ? required(operation.tool, 'tool') : operation.tool || 'native_filesystem';
    if (available && !TOOLS.has(tool)) throw new Error('native_filesystem_tool_unsupported');
    const parentRunId = available ? required(context.parentRunId, 'parent_run_id') : context.parentRunId;
    const toolCallId = available ? required(context.toolCallId, 'tool_call_id') : context.toolCallId;
    const logger = context.traceLogger || operation.arguments?.traceLogger;
    const traceDetails = {
      tool, toolCallId: context.toolCallId || null,
      executionTarget: 'remote', providerId: target.providerId, targetId: target.targetId,
    };
    // Local harnesses own their activity. Remote delegation bypasses those
    // harnesses, so the router owns the corresponding Core tool activity.
    const started = await logger?.toolStart?.(traceDetails);
    const activityId = started?.payload?.activityId || null;
    const operationId = available ? context.operationId || nativeFilesystemOperationId({ parentRunId, toolCallId }) : null;
    let result;
    try {
      if (!available) throw new Error('remote_native_filesystem_controller_unavailable');
      // Resolve only after toolStart's observer has opened the Core span; a
      // carrier computed by the proposal before routing would point at the run.
      const traceContext = context.telemetry?.traceContextForTool?.(parentRunId, activityId || toolCallId) || context.traceContext;
      const telemetryConfiguration = remoteTelemetryConfiguration(context.telemetry?.remoteConfiguration?.(parentRunId));
      result = await remoteController.executeNativeFilesystem({
        operationId,
        targetId: required(target.targetId, 'target_id'),
        parentRunId,
        toolCallId,
        ...(traceContext ? { traceContext: { ...traceContext } } : {}),
        ...(telemetryConfiguration ? { telemetryConfiguration } : {}),
        operation: { tool, arguments: Object.fromEntries(Object.entries(operation.arguments || {}).filter(([key, value]) => !['traceLogger', 'rootDir', 'artifactPrefix', 'runId', 'telemetryConfiguration'].includes(key) && (value == null || ['string', 'number', 'boolean'].includes(typeof value)))) },
      }, { abortSignal: context.abortSignal || null });
      if (result && typeof result === 'object') result = { ...result, operationId: result.operationId || operationId };
    } catch (error) {
      result = { ...failure(tool, operation.arguments || {}, error), ...(operationId ? { operationId } : {}) };
    }
    await (logger?.toolEnd || logger?.tool)?.({
      ...traceDetails, ...(activityId ? { activityId } : {}),
      operationId: result?.operationId || operationId,
      ok: result?.ok === true, error: result?.error || null,
      cancelled: result?.cancelled === true, timedOut: result?.timedOut === true,
    });
    return result;
  };
}

export const __nativeFilesystemExecutionRouter__ = Object.freeze({ TOOLS, localExecutionTarget, remoteExecutionTarget });
