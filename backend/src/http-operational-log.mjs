import { randomUUID } from 'node:crypto';
import { safeOperationalError } from './runtime-server-log.mjs';
import { modelSettingsFailureDiagnostic } from './model-settings-store.mjs';
import { modelRecoveryProgress, projectModelRecoveryMetadata } from './model-recovery-projection.mjs';

const responses = new WeakMap();
const recoveryTransitions = new WeakMap();
const id = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
const routine = new Set(['cancelled', 'canceled', 'superseded', 'stopped', 'aborted']);
const routeSegments = new Set('api auth oidc login callback logout health discovery session validate settings ui-auth chat inputs cancel resume steer steering runs active agents profiles sessions context context-status diagnostics inventory postgres brains memories embedding-jobs forge jobs mods pending status metrics provider-pools traces archive calendar workbench task-board projects tasks memory'.split(' '));
const decisions = new Set(['blocked', 'failed', 'model_failed', 'error', 'rejected', 'requires_review', 'continuity_uncertain', 'incomplete']);

function emit(logger, event, fields, options) {
  try { logger?.event?.(event, fields, options)?.catch?.(() => {}); } catch { /* Observational only. */ }
}
function route(req) {
  // Never retain a query (notably authorization codes/state) or absolute-form
  // authority/userinfo. Route parameters are not operational diagnostics either.
  try {
    const pathname = new URL(req.url || '/', 'http://localhost').pathname;
    if (/^\/(?:api|auth)\/[A-Za-z0-9/_-]{0,240}$/.test(pathname)) {
      return pathname.split('/').map(part => !part || routeSegments.has(part) ? part : ':id').join('/');
    }
    return pathname === '/' ? '/' : '/:resource';
  } catch { return '/:invalid'; }
}
function fields(state) {
  return {
    requestId: state.req.requestId,
    method: /^(GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS|CONNECT|TRACE)$/.test(state.req.method) ? state.req.method : 'OTHER',
    route: route(state.req), ...state.correlation,
    durationMs: Math.max(0, Date.now() - state.startedAt),
  };
}
function suppressed(state) { return state.logged || state.req.operationalFailureLogged === true; }

/** Install before admission/routing so even shutdown and internally caught 5xx
 * responses have a correlation ID and one actionable diagnostic. */
export function instrumentHttpResponse({ req, res, logger } = {}) {
  if (responses.has(res)) return;
  req.requestId = id(req.headers?.['x-request-id']) || randomUUID();
  res.requestId = req.requestId;
  try { res.setHeader('x-request-id', req.requestId); } catch { /* Already closed. */ }
  const state = { req, res, logger, startedAt: Date.now(), correlation: {}, logged: false };
  responses.set(res, state);
  res.once('finish', () => {
    if (res.statusCode >= 500) recordHttpFailure(res, { status: res.statusCode, errorCode: 'http_response_failed', classification: 'http_5xx' });
    emit(logger, 'http_request', { ...fields(state), status: res.statusCode }, { level: 'debug', component: 'http' });
  });
  req.once('aborted', () => emit(logger, 'client_disconnect', { ...fields(state), phase: 'request_aborted' }, { level: 'debug', component: 'http' }));
}

export function correlateHttpRun(res, context = {}) {
  const state = responses.get(res);
  if (!state) return;
  if (context.cancelled === true) state.cancelled = true;
  for (const key of ['runId', 'sessionId', 'agentId', 'taskId']) {
    const value = id(context[key]);
    if (value) state.correlation[key] = value;
  }
  // Only an existing runtime-owned carrier is accepted; never mint trace IDs
  // or take a caller's traceparent as proof of an active runtime span.
  const match = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(context.traceContext?.traceparent || '');
  if (match && !/^0+$/.test(match[1]) && !/^0+$/.test(match[2])) {
    state.correlation.traceId = match[1]; state.correlation.spanId = match[2];
  }
}

// Strings in legacy result.error fields are accepted only as complete known
// stable codes by producer-owned allowlists and the safe exception helper. No prefix scans,
// generic parser messages or provider prose become operational text.
const RESULT_CODES = new Set([
  'model_response_malformed_envelope', 'model_response_provider_error', 'model_response_empty',
  'model_response_incomplete', 'model_response_malformed_json', 'model_response_failed',
  'model_response_missing_status', 'model_response_missing_finish_reason',
  'model_response_length', 'model_response_content_filter', 'model_response_budget_exhausted',
  'invalid_model_response_budget',
]);
function resultDiagnostic(body, result, fallback) {
  const model = result.model && typeof result.model === 'object' ? result.model : null;
  for (const candidate of [body.error, result.error, model?.error]) {
    if (candidate === undefined || candidate === null) continue;
    const diagnostic = modelSettingsFailureDiagnostic(typeof candidate === 'string' ? { message: candidate } : candidate, fallback);
    if (RESULT_CODES.has(candidate)) diagnostic.errorCode = candidate;
    if (diagnostic.errorCode !== fallback) return diagnostic;
  }
  return undefined;
}
function taskExecutionFailure(error) {
  if (safeOperationalError(error).errorCode !== 'task_execution_pre_dispatch_recovery_failed') return {};
  const context = error?.taskExecutionDiagnostics;
  if (!context || typeof context !== 'object') return {};
  const correlation = {};
  for (const key of ['taskId', 'runId', 'agentId', 'sessionId']) {
    const value = id(context[key]);
    if (value) correlation[key] = value;
  }
  return { ...correlation, taskExecution: {
    ...correlation,
    projectReadError: safeOperationalError(context.projectReadError),
    recoveryWriteError: safeOperationalError(context.recoveryWriteError),
  } };
}

export function recordHttpFailure(res, { error, status = res.statusCode, event = 'request_error', errorCode = 'http_request_failed', classification = 'exception', resultStatus, upstreamStatus, failureCategory, modelFailure, modelRecovery } = {}) {
  const state = responses.get(res);
  if (!state || suppressed(state) || (status >= 400 && status < 500)) return;
  state.logged = true;
  const recoveryMetadata = projectModelRecoveryMetadata({ modelFailure, modelRecovery });
  const lastRecovery = recoveryMetadata.modelRecovery?.requests.at(-1);
  emit(state.logger, event, {
    ...fields(state), ...taskExecutionFailure(error), status: res.headersSent ? res.statusCode : status,
    ...(Number.isInteger(resultStatus) && resultStatus >= 400 && resultStatus <= 599 ? { resultStatus }
      : res.headersSent && status !== res.statusCode ? { resultStatus: status } : {}),
    ...(Number.isInteger(upstreamStatus) && upstreamStatus >= 100 && upstreamStatus <= 599 ? { upstreamStatus } : {}),
    ...(RESULT_CODES.has(failureCategory) || (failureCategory && modelSettingsFailureDiagnostic({ errorCode: failureCategory }).errorCode === failureCategory) || (failureCategory && failureCategory === recoveryMetadata.modelFailure?.code) ? { failureCategory } : {}),
    ...(recoveryMetadata.modelFailure ? { modelFailureOrigin: recoveryMetadata.modelFailure.origin, modelFailureCode: recoveryMetadata.modelFailure.code } : {}),
    ...(lastRecovery?.failover ? { failoverCode: lastRecovery.failover.code, failoverAction: lastRecovery.failover.action } : {}),
    classification, ...(error === undefined ? { errorCode } : { error: safeOperationalError(error, errorCode) }),
  }, { level: 'error', component: event === 'run_failed' ? 'run' : 'http' });
}

/** Only project status/decision/IDs and known error codes. Never serialize the
 * response, messages, prompts, tool arguments, provider diagnostics or receipts. */
export function observeHttpResult(res, status, body, { event } = {}) {
  const state = responses.get(res);
  if (!state || !body || typeof body !== 'object') return;
  const result = body.result && typeof body.result === 'object' ? body.result : body;
  correlateHttpRun(res, { runId: result.runId, sessionId: result.sessionId, agentId: result.agentId });
  const metadata = projectModelRecoveryMetadata(result);
  const requests = metadata.modelRecovery?.requests || [];
  const original = requests.findLast(request => request.originalFailure?.origin === 'upstream' && Number.isInteger(request.originalFailure.status))?.originalFailure;
  const failureStatus = original?.status ?? (metadata.modelFailure?.origin === 'upstream' ? metadata.modelFailure.status : undefined);
  const diagnostic = resultDiagnostic(body, result, status >= 500 ? 'http_response_failed' : 'operation_result_failed');
  if (status >= 500) return recordHttpFailure(res, {
    status, errorCode: 'http_response_failed', classification: 'http_5xx', event,
    error: diagnostic, failureCategory: metadata.modelFailure?.code ?? diagnostic?.errorCode, upstreamStatus: failureStatus ?? diagnostic?.upstreamStatus, ...metadata,
  });
  if (status >= 400 || body.ok !== false || state.cancelled || metadata.modelFailure?.origin === 'cancelled') return;
  if (routine.has(result.decision) || routine.has(result.status)) return;
  const resultStatus = Number(body.status ?? result.status);
  if (resultStatus >= 400 && resultStatus < 500) return;
  const upstreamStatus = failureStatus ?? result.model?.status ?? diagnostic?.upstreamStatus;
  recordHttpFailure(res, {
    status, event: event || (state.correlation.runId ? 'run_failed' : 'request_error'),
    errorCode: 'operation_result_failed', error: diagnostic, failureCategory: metadata.modelFailure?.code ?? diagnostic?.errorCode, ...metadata,
    ...(Number.isInteger(resultStatus) && resultStatus >= 500 && resultStatus <= 599 ? { resultStatus } : {}),
    ...(Number.isInteger(upstreamStatus) ? { upstreamStatus } : {}),
    classification: resultStatus >= 500 && resultStatus <= 599 ? 'result_5xx'
      : upstreamStatus >= 500 && upstreamStatus <= 599 ? 'upstream_5xx'
        : upstreamStatus >= 400 && upstreamStatus < 500 ? 'upstream_4xx'
          : decisions.has(result.decision) ? result.decision : 'result_not_ok',
  });
}

/** Emit transition diagnostics from safe recovery facts only, including the
 * original upstream status even when a later physical attempt succeeds. Use
 * phase/failureCode rather than the logger's reserved OAuth state/code keys. */
export function observeModelRecovery(logger, traceRecord, context = {}) {
  const recovery = modelRecoveryProgress(traceRecord)?.data;
  if (!recovery || !logger || !['object', 'function'].includes(typeof logger)) return;
  let transitions = recoveryTransitions.get(logger);
  if (!transitions) { transitions = new Map(); recoveryTransitions.set(logger, transitions); }
  const correlation = {};
  for (const key of ['requestId', 'runId', 'sessionId', 'agentId', 'taskId', 'traceId', 'spanId']) {
    const value = id(context[key]);
    if (value) correlation[key] = value;
  }
  const key = `${correlation.runId || ''}:${recovery.logicalRequestId || ''}:${recovery.method || ''}`;
  const signature = JSON.stringify(recovery);
  if (transitions.get(key) === signature) return;
  if (transitions.size >= 256 && !transitions.has(key)) transitions.delete(transitions.keys().next().value);
  transitions.set(key, signature);
  const original = recovery.originalFailure, last = recovery.lastFailure;
  const upstreamStatus = (original?.origin === 'upstream' ? original.status : undefined)
    ?? (last?.origin === 'upstream' ? last.status : undefined);
  emit(logger, 'model_recovery', {
    ...correlation,
    phase: recovery.state,
    ...(recovery.logicalRequestId ? { logicalRequestId: recovery.logicalRequestId } : {}),
    ...(recovery.method ? { modelMethod: recovery.method } : {}),
    ...Object.fromEntries(['attempt', 'maxAttempts', 'delayMs', 'retryCount'].filter(key => recovery[key] !== undefined).map(key => [key, recovery[key]])),
    ...(original ? { originalFailureOrigin: original.origin, originalFailureCode: original.code } : {}),
    ...(last ? { failureOrigin: last.origin, failureCategory: last.code, retryable: last.retryable } : {}),
    ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
    ...(last?.origin === 'upstream' && last.status !== undefined && last.status !== upstreamStatus ? { lastUpstreamStatus: last.status } : {}),
    ...(recovery.failover ? { failoverCode: recovery.failover.code, failoverAction: recovery.failover.action } : {}),
    ...(recovery.partialOutput ? { partialOutput: recovery.partialOutput } : {}),
  }, { level: ['resumed', 'cancelled'].includes(recovery.state) ? 'info' : 'warn', component: 'model' });
}

export function observeHttpRunEvent(res, event, { status = res.statusCode } = {}) {
  if (event?.type === 'model.recovery' || event?.type === 'model-recovery') {
    correlateHttpRun(res, event);
    const state = responses.get(res);
    if (state) observeModelRecovery(state.logger, event, { ...fields(state), ...event });
    return;
  }
  if (!['run.failed', 'run.completed'].includes(event?.type)) return;
  correlateHttpRun(res, event);
  const response = event.data?.response;
  const result = response?.result || response;
  if (routine.has(result?.decision) || routine.has(result?.status)) return;
  if (event.type === 'run.failed' && response?.ok !== false) {
    return recordHttpFailure(res, { status, event: 'run_failed', errorCode: 'run_failed', classification: 'terminal_failure' });
  }
  observeHttpResult(res, status, response, { event: 'run_failed' });
}

/** Transition-only dependency state for UI-owned refreshers whose APIs return
 * failure results rather than throwing. Keys and state retention are bounded. */
export function createCatalogRefreshDiagnostics(logger, component) {
  const failed = new Set();
  return (dependency, ok, { connectionId, error } = {}) => {
    const safeId = id(connectionId);
    const key = `${dependency}:${safeId || ''}`;
    if (ok) {
      if (!failed.delete(key)) return;
      emit(logger, `${dependency}_restored`, { ...(safeId ? { connectionId: safeId } : {}) }, { level: 'info', component });
    } else {
      if (failed.has(key)) return;
      if (failed.size >= 256) failed.delete(failed.values().next().value);
      failed.add(key);
      const diagnostic = error == null ? undefined
        : modelSettingsFailureDiagnostic(typeof error === 'string' ? { message: error } : error, `${dependency}_failed`);
      emit(logger, `${dependency}_failed`, {
        ...(safeId ? { connectionId: safeId } : {}), errorCode: `${dependency}_failed`,
        ...(diagnostic ? {
          // Retain the producer-owned category alongside the generic
          // dependency event and sanitized Error projection.
          failureCategory: diagnostic.errorCode,
          classification: diagnostic.classification,
          ...(diagnostic.upstreamStatus === undefined ? {} : { upstreamStatus: diagnostic.upstreamStatus }),
          error: diagnostic,
        } : {}),
      }, { level: 'warn', component });
    }
  };
}
