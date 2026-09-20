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

export function remoteExecutionTarget(providerId, targetId) {
  return Object.freeze({ kind: 'remote', providerId: requiredId(providerId, 'provider_id'), targetId: requiredId(targetId, 'target_id') });
}

/** Resolve the controller-owned target frozen into this run's context. */
export function resolveProcessExecutionTarget(runContext = {}) {
  const configured = runContext.processExecutionTarget || runContext.executionEnvironment || null;
  if (!configured) return localExecutionTarget();
  if (configured.kind === 'local') return localExecutionTarget();
  if (configured.kind === 'remote') return remoteExecutionTarget(configured.providerId, configured.targetId);
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
    const targetId = requiredId(target.targetId, 'target_id');
    const parentRunId = requiredId(context.parentRunId, 'parent_run_id');
    const toolCallId = requiredId(context.toolCallId, 'tool_call_id');
    const operationId = context.operationId || processOperationId({ parentRunId, toolCallId });
    const process = request.process || {};
    if (process.command != null && (typeof process.command !== 'string' || !process.command.trim())) throw new Error('command_invalid');
    if (process.executable != null && (typeof process.executable !== 'string' || !process.executable.trim())) throw new Error('executable_invalid');
    if (process.args != null && (!Array.isArray(process.args) || process.args.some((value) => typeof value !== 'string'))) throw new Error('args_invalid');
    const command = process.command?.trim() || '';
    const executable = process.executable?.trim() || '';
    if (command && executable) throw new Error('command_and_executable_mutually_exclusive');
    if (!command && !executable) throw new Error('command_or_executable_required');
    if (command && process.args?.length) throw new Error('args_with_command_invalid');
    const result = await remoteController.executeProcess({
      operationId,
      targetId,
      parentRunId,
      toolCallId,
      process: {
        ...(command ? { command } : { executable, args: process.args ? [...process.args] : [] }),
        ...(process.cwd ? { cwd: String(process.cwd) } : {}),
        // Ordinary env remains compatible; protected values use a distinct,
        // operation-scoped field so controllers cannot accidentally journal it.
        ...(process.env && !request.protectedValues ? { env: { ...process.env } } : {}),
        timeoutMs: process.timeoutMs != null ? Number(process.timeoutMs) : 30_000,
      },
      ...(request.protectedValues ? { protectedValues: { ...request.protectedValues } } : {}),
      ...(request.protectedBindingMetadata ? { protectedBindingMetadata: request.protectedBindingMetadata.map((entry) => ({ ...entry })) } : {}),
    }, { abortSignal: context.abortSignal || null });
    return result && typeof result === 'object' ? { ...result, operationId: result.operationId || operationId } : result;
  };
}

export function createExecutionProviderRegistry() {
  const controllers = new Map();
  return Object.freeze({
    register(providerId, controller, { replace = false } = {}) {
      const id = requiredId(providerId, 'provider_id');
      if (!controller || typeof controller.executeProcess !== 'function') throw new Error('execution_provider_invalid');
      const previous = controllers.get(id) || null;
      if (previous && !replace) throw new Error(`execution_provider_duplicate:${id}`);
      let committed = !previous;
      if (!previous) controllers.set(id, controller);
      const unregister = () => {
        if (!committed) return;
        if (controllers.get(id) === controller) controllers.delete(id);
      };
      // A replacement remains private until its host has fully activated and the
      // live mod registry is ready to publish it. This prevents work from being
      // routed into a candidate that may still be rolled back.
      unregister.commit = () => {
        if (committed) return;
        if (controllers.get(id) !== previous) throw new Error(`execution_provider_replacement_conflict:${id}`);
        controllers.set(id, controller);
        committed = true;
      };
      return unregister;
    },
    get(providerId) { return controllers.get(String(providerId || '')) || null; },
  });
}
