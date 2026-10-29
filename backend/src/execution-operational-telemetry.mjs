import { performance } from 'node:perf_hooks';
import { operationalTelemetry } from './operational-telemetry.mjs';

// Routers are often constructed per tool call. Keep observations scoped to the
// controller identity, shared by process/filesystem calls, not a global target.
const disconnected = new WeakMap();
const disconnectCodes = new Set(['gateway_disconnected', 'gateway_not_connected']);
const controllerFailureCodes = new Set([
  'remote_process_failed', 'remote_filesystem_failed', 'gateway_not_ready', 'gateway_dispatch_failed',
  'gateway_operation_id_mismatch', 'gateway_terminal_evidence_missing', 'operation_id_conflict',
  'operation_in_progress', 'protected_redelivery_forbidden', 'operation_correlation_conflict', 'operation_correlation_missing',
]);
const timeoutCodes = new Set(['ETIMEDOUT', 'remote_process_cancel_timeout']);
const abortedCodes = new Set(['remote_process_aborted', 'remote_filesystem_aborted']);
function id(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)
    && !/(?:^|[-_.:])(?:secret|password|credential|bearer|token|api[-_]?key)(?:$|[-_.:])/i.test(value)
    && !/^(?:sk-|xox[baprs]-|gh[opsu]_|AIza)/.test(value) ? value : null;
}
function publish(type, fields) {
  try { operationalTelemetry(type, fields); } catch { /* Observation is not dispatch authority. */ }
}

/** One terminal latency observation per actual controller dispatch, no payloads. */
export function startExecutionDispatch({ controller, target, context = {}, operation, operationId } = {}) {
  const startedAt = performance.now();
  let completed = false;
  return (result, error = null) => {
    if (completed) return;
    completed = true;
    try {
      const code = error?.code || error?.message || result?.error;
      const outcome = result?.timedOut === true || error?.name === 'TimeoutError' || timeoutCodes.has(code) ? 'timeout'
        : result?.cancelled === true || context.abortSignal?.aborted || error?.name === 'AbortError' || abortedCodes.has(code) ? 'cancelled'
          : !error && result?.ok === true ? 'success' : 'failure';
      const fields = { operation, outcome, durationMs: Math.max(0, performance.now() - startedAt),
        ...(id(target?.providerId) ? { providerId: target.providerId } : {}),
        ...(id(target?.targetId) ? { targetId: target.targetId } : {}),
        ...(id(context.parentRunId) ? { runId: context.parentRunId } : {}),
        ...(id(context.sessionId) ? { sessionId: context.sessionId } : {}),
      };
      publish('execution-dispatch', fields);
      if (!controller || !target?.targetId) return;
      let states = disconnected.get(controller);
      const key = `${target.providerId}\0${target.targetId}`;
      // Do not turn generic exceptions, timeouts, non-zero exits or filesystem
      // failures into a fabricated disconnection. These two controller codes
      // are explicit gateway-connection evidence on the real bridge path.
      if (disconnectCodes.has(code)) {
        if (!states) { states = new Map(); disconnected.set(controller, states); }
        if (!states.has(key)) {
          // Bound retained unavailable targets on long-lived controllers.
          if (states.size >= 1024) states.delete(states.keys().next().value);
          states.set(key, performance.now());
          publish('execution-host-disconnected', { ...fields, outcome: 'disconnected' });
        }
      } else if (!error && !controllerFailureCodes.has(code) && states?.has(key)
        && result?.operationId === operationId && result?.targetId === target.targetId
        && (result?.ok === true || (operation === 'process' && Number.isInteger(result?.exitCode)))) {
        // A correlated successful receipt (or a real process exit, even nonzero)
        // proves the host answered. A correlated controller rejection, generic
        // !ok response, registration or cached host metadata cannot do that.
        const since = states.get(key);
        states.delete(key);
        publish('execution-host-reconnected', { ...fields, outcome: 'reconnected', durationMs: Math.max(0, performance.now() - since) });
      }
    } catch { /* Untrusted result/error objects cannot break tool completion. */ }
  };
}
