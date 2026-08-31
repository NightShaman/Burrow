import { createHash } from 'node:crypto';

function requiredId(value, name) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${name}_required`);
  return text;
}

export function processOperationId({ parentRunId, toolCallId } = {}) {
  const run = requiredId(parentRunId, 'parent_run_id');
  const call = requiredId(toolCallId, 'tool_call_id');
  const digest = createHash('sha256').update(`${run}\0${call}`).digest('hex').slice(0, 24);
  return `shell-${digest}`;
}

export function localExecutionTarget() {
  return Object.freeze({ kind: 'local' });
}

export function remoteExecutionTarget(gatewayId) {
  return Object.freeze({ kind: 'remote', gatewayId: requiredId(gatewayId, 'gateway_id') });
}

/** Resolve the controller-owned target frozen into this run's context. */
export function resolveProcessExecutionTarget(runContext = {}) {
  const configured = runContext.processExecutionTarget || runContext.executionEnvironment || null;
  if (!configured) return localExecutionTarget();
  if (configured.kind === 'local') return localExecutionTarget();
  if (configured.kind === 'remote') return remoteExecutionTarget(configured.gatewayId);
  if (configured.kind === 'gateway') return remoteExecutionTarget(configured.gatewayId || configured.hostId);
  throw new Error('execution_target_invalid');
}

/**
 * Routes a structured process request without changing the agent's tool set.
 * Controllers receive stable correlation identifiers. Resolved protected values
 * remain isolated in their dedicated transient field for authenticated delivery.
 */
export function createProcessExecutionRouter({ localExecute, remoteController = null } = {}) {
  if (typeof localExecute !== 'function') throw new Error('local_execute_required');
  return async function executeProcess(request = {}, context = {}) {
    const target = request.target || localExecutionTarget();
    if (target.kind === 'local') return localExecute(request.process || request, context);
    if (target.kind !== 'remote') throw new Error('execution_target_invalid');
    if (!remoteController || typeof remoteController.executeProcess !== 'function') throw new Error('remote_process_controller_unavailable');
    const gatewayId = requiredId(target.gatewayId, 'gateway_id');
    const parentRunId = requiredId(context.parentRunId, 'parent_run_id');
    const toolCallId = requiredId(context.toolCallId, 'tool_call_id');
    const operationId = context.operationId || processOperationId({ parentRunId, toolCallId });
    const process = request.process || {};
    return remoteController.executeProcess({
      operationId,
      gatewayId,
      parentRunId,
      toolCallId,
      process: {
        command: requiredId(process.command, 'command'),
        ...(process.cwd ? { cwd: String(process.cwd) } : {}),
        // Ordinary env remains compatible; protected values use a distinct,
        // operation-scoped field so controllers cannot accidentally journal it.
        ...(process.env && !request.protectedValues ? { env: { ...process.env } } : {}),
        ...(process.timeoutMs != null ? { timeoutMs: Number(process.timeoutMs) } : {}),
      },
      ...(request.protectedValues ? { protectedValues: { ...request.protectedValues } } : {}),
      ...(request.protectedBindingMetadata ? { protectedBindingMetadata: request.protectedBindingMetadata.map((entry) => ({ ...entry })) } : {}),
    }, { abortSignal: context.abortSignal || null });
  };
}

export function createProcessControllerRegistry() {
  const controllers = new Map();
  return Object.freeze({
    register(modId, controller) {
      const id = requiredId(modId, 'mod_id');
      if (!controller || typeof controller.executeProcess !== 'function') throw new Error('process_controller_invalid');
      if (controllers.has(id)) throw new Error(`process_controller_duplicate:${id}`);
      controllers.set(id, controller);
      return () => controllers.delete(id);
    },
    get(modId) { return controllers.get(String(modId || '')) || null; },
  });
}
