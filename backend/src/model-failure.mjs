import { AsyncLocalStorage } from 'node:async_hooks';

const failureScopes = new AsyncLocalStorage();
export const withModelFailureScope = operation => failureScopes.run({}, operation);
// Failure metadata is a bounded decision aid, never a copy of provider/error
// text. Thrown-error provenance belongs to the exact object that crossed a
// transport boundary; a TypeError name or a status property is not proof.
// Provenance and retained results are scoped to a single invocation. A frozen
// error (or the same error object used by overlapping calls) stays safe.
const provenance = new WeakMap();
const retainedFailures = new WeakMap();
const unscoped = {};
const scopeKey = () => failureScopes.getStore() || unscoped;
const scopeSet = (map, value, data) => {
  let scoped = map.get(value);
  if (!scoped) { scoped = new WeakMap(); map.set(value, scoped); }
  scoped.set(scopeKey(), data);
};
const scopeGet = (map, value) => map.get(value)?.get(scopeKey());
const isObject = (value) => value !== null && (typeof value === 'object' || typeof value === 'function');
const get = (value, key) => { try { return value?.[key]; } catch { return undefined; } };

const TRANSIENT_TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ECONNABORTED', 'ETIMEDOUT', 'EPIPE',
  'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'ERR_STREAM_PREMATURE_CLOSE',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_RES_CONTENT_LENGTH_MISMATCH',
]);
const INVALID_CONFIGURATION_CODES = new Set([
  'ERR_INVALID_URL', 'ERR_INVALID_ARG_TYPE', 'ERR_INVALID_ARG_VALUE', 'ERR_INVALID_STATE',
  'ERR_MISSING_ARGS', 'UND_ERR_INVALID_ARG',
]);
// These are exact application-owned guard codes, not vendor messages matched
// by substring. Unknown thrown exceptions remain unknown and non-retryable.
const BURROW_CODES = new Set([
  'model_result_invalid', 'superseded_by_newer_session_run',
  'provider_diagnostic_persistence_failed', 'runtime_database_ownership_lost',
  'provider_pool_signed_history_owner_missing', 'provider_pool_continuation_owner_missing',
  'provider_pool_continuation_owner_unavailable', 'provider_pool_member_resolver_required',
  'provider_pool_invalid_member_config', 'provider_pool_replay_incomplete_history',
  'provider_pool_replay_nonportable_history', 'provider_pool_retry_exhausted',
  'native_continuation_preparation_required', 'native_continuation_preparation_invalid',
  'continuation_evidence_preservation_budget_exceeded', 'continuation_evidence_prompt_builder_required',
  'context_preparation_prompt_over_budget', 'context_preparation_uncovered_history',
  'context_compression_unavailable', 'CONTEXT_BOUNDARY_VIOLATION',
  'prepared_context_invalid', 'prepared_context_version_invalid', 'prepared_context_source_invalid',
  'prepared_context_turn_context_invalid', 'prepared_context_prepared_invalid',
  'context_engine_retired_use_prepared_context', 'initial_context_preparation_retired_use_prepared_context',
  'google_content_part_unsupported', 'google_tool_result_unpaired', 'google_tool_arguments_invalid',
  'google_chat_method_unsupported', 'google_developer_api_endpoint_unsupported',
  'google_developer_api_version_unsupported', 'google_developer_api_auth_unsupported',
  'google_developer_api_key_required', 'ERR_INVALID_URL', 'provider_tool_result_budget_required',
  'invalid_model_response_budget', 'model_response_budget_exhausted', 'provider_response_too_large',
  'model_request_serialization_failed', 'model_serialization_failed',
  'model baseUrl is required', 'model is required', 'fetch implementation is required',
  'prompt or messages are required',
]);
const BURROW_FIXED_CODE = new Map([
  ['model baseUrl is required', 'model_configuration_invalid'],
  ['model is required', 'model_configuration_invalid'],
  ['fetch implementation is required', 'model_configuration_invalid'],
  ['prompt or messages are required', 'model_request_invalid'],
]);
const cancelled = (value, signal) => Boolean(get(signal, 'aborted')) || get(value, 'cancelled') === true
  || get(value, 'name') === 'AbortError' || ['ABORT_ERR', 'ERR_CANCELED'].includes(get(value, 'code'));
const cancellation = () => ({ origin: 'cancelled', code: 'model_cancelled', retryable: false });
const unknown = () => ({ origin: 'unknown', code: 'model_failure_unknown', retryable: false });
const transientStatus = (status) => status === 408 || status === 429 || (status >= 500 && status <= 599);
const failureHttpStatus = (status) => Number.isInteger(status) && status >= 100 && status <= 599 && (status < 200 || status >= 300);
const httpFailure = (status) => ({ origin: 'upstream', code: `provider_http_${status}`, retryable: transientStatus(status), status });

// Keep cause traversal bounded and never return cause text in metadata.
function errorChain(error) {
  const seen = new Set();
  const chain = [];
  while (isObject(error) && !seen.has(error) && chain.length < 5) {
    chain.push(error); seen.add(error); error = get(error, 'cause');
  }
  return chain;
}

/** Called only around the actual fetch or response-read operation. */
export function markProviderTransportError(error, { stage } = {}) {
  if (!isObject(error) || !['fetch', 'read', 'configuration'].includes(stage) || cancelled(error)) return error;
  if (stage === 'configuration') {
    scopeSet(provenance, error, { origin: 'burrow', code: 'provider_transport_configuration_invalid', retryable: false });
    return error;
  }
  const chain = errorChain(error);
  if (chain.some((item) => INVALID_CONFIGURATION_CODES.has(get(item, 'code')))) {
    scopeSet(provenance, error, { origin: 'burrow', code: 'provider_transport_configuration_invalid', retryable: false });
    return error;
  }
  const recognized = chain.some((item) => TRANSIENT_TRANSPORT_CODES.has(get(item, 'code')));
  const fetchFailed = stage === 'fetch' && get(error, 'name') === 'TypeError'
    && ['fetch failed', 'Failed to fetch'].includes(get(error, 'message'));
  // A failed body read is itself a transport boundary. No parser, decoder,
  // callback, diagnostics or response processing runs within this boundary.
  if (recognized || fetchFailed || stage === 'read') {
    scopeSet(provenance, error, { origin: 'upstream', code: stage === 'read' ? 'provider_read_failed' : 'provider_transport_failed', retryable: true });
  }
  return error;
}

// Only stream parsers that actually reach EOF without their required terminal
// should call this; vendor error messages must never be matched as proof.
export function markProviderStreamTruncated(value) {
  if (isObject(value)) scopeSet(provenance, value, { origin: 'upstream', code: 'provider_stream_truncated', retryable: true });
  return value;
}

// Only parsers/adapters that actually observed a provider error envelope call
// this. Structured types/codes, not exception prose, establish retry semantics.
export function markProviderEnvelopeFailure(value, error = {}) {
  if (!isObject(value)) return value;
  const status = get(error, 'status') ?? (Number.isInteger(get(error, 'code')) ? get(error, 'code') : undefined);
  const type = get(error, 'type'), code = get(error, 'code');
  const transient = new Set(['overloaded_error', 'api_error', 'server_error', 'internal_error', 'upstream_error', 'UNAVAILABLE', 'INTERNAL']);
  const limited = new Set(['rate_limit_error', 'rate_limit_exceeded', 'RESOURCE_EXHAUSTED']);
  const modelFailure = failureHttpStatus(status) ? httpFailure(status)
    : limited.has(type) || limited.has(code) ? { origin: 'upstream', code: 'provider_rate_limited', retryable: true }
      : transient.has(type) || transient.has(code) ? { origin: 'upstream', code: 'provider_unavailable', retryable: true }
        : { origin: 'upstream', code: 'provider_generation_failed', retryable: false };
  scopeSet(provenance, value, modelFailure);
  return value;
}

function safeMetadata(value) {
  if (!isObject(value)) return null;
  const origin = get(value, 'origin'), code = get(value, 'code'), retryable = get(value, 'retryable'), status = get(value, 'status');
  if (origin === 'upstream' && failureHttpStatus(status) && code === `provider_http_${status}` && retryable === transientStatus(status)) return httpFailure(status);
  if (origin === 'upstream' && code === 'provider_generation_failed' && retryable === false) return { origin, code, retryable };
  if (origin === 'upstream' && ['provider_unavailable', 'provider_rate_limited', 'provider_stream_truncated', 'provider_read_failed', 'provider_transport_failed'].includes(code) && retryable === true) return { origin, code, retryable };
  if (origin === 'cancelled' && code === 'model_cancelled' && retryable === false) return cancellation();
  if (origin === 'unknown' && code === 'model_failure_unknown' && retryable === false) return unknown();
  if (origin === 'burrow' && retryable === false && (BURROW_CODES.has(code) || ['model_configuration_invalid', 'model_request_invalid', 'provider_transport_configuration_invalid'].includes(code))) return { origin, code, retryable };
  return null;
}

export function classifyModelFailure(value, { signal } = {}) {
  if (cancelled(value, signal)) return cancellation();
  const marked = isObject(value) ? scopeGet(provenance, value) : null;
  if (marked) return { ...marked };
  // Annotated envelopes can be copied by a provider pool. Only accept the
  // bounded metadata schema, never a bare error.status or arbitrary code.
  if (get(value, 'ok') === false) {
    const metadata = safeMetadata(get(value, 'modelFailure'));
    if (metadata) return metadata;
  }
  const code = get(value, 'code');
  const message = get(value, 'message') ?? (get(value, 'ok') === false ? get(value, 'error') : undefined);
  const internal = BURROW_CODES.has(code) ? code : BURROW_CODES.has(message) ? message : null;
  if (internal) return { origin: 'burrow', code: BURROW_FIXED_CODE.get(internal) || internal, retryable: false };
  return unknown();
}

// Callbacks may be arbitrary user code; they are local but not necessarily a
// persistence fault. Clear any stale transport provenance in this scope.
export function markModelCallbackError(error) {
  if (isObject(error)) scopeSet(provenance, error, unknown());
  return error;
}

// Mark only a known local operation boundary. Arbitrary logger exception text
// and cause chains are never evidence of a provider failure (or a safe code).
export function markModelInternalError(error, code = 'provider_diagnostic_persistence_failed') {
  const safeCode = BURROW_CODES.has(code) ? BURROW_FIXED_CODE.get(code) || code : 'provider_diagnostic_persistence_failed';
  if (!isObject(error)) error = new Error(safeCode);
  scopeSet(provenance, error, { origin: 'burrow', code: safeCode, retryable: false });
  return error;
}

/** A secondary fault must never authorize another provider dispatch. */
export function classifyRecoveryFailure(error) {
  const failure = classifyModelFailure(error);
  return failure.origin === 'burrow' ? failure : unknown();
}

/** Keep the original receipt only in process, attached to this failure scope. */
export function retainModelFailure(error, result) {
  if (!isObject(error)) error = new Error('model_failure_unknown');
  scopeSet(retainedFailures, error, { originalResult: result, recoveryFailure: classifyRecoveryFailure(error) });
  return error;
}

/** Called by an adapter only once it has an actual failed HTTP/stream result. */
export function providerFailureResult(result) {
  if (!isObject(result) || get(result, 'ok') !== false) return result;
  const status = get(result, 'status');
  const modelFailure = cancelled(result) ? cancellation()
    : failureHttpStatus(status) ? httpFailure(status)
      : classifyModelFailure(result);
  return { ...result, modelFailure };
}

function originalErrorText(error) {
  const message = get(error, 'message');
  if (typeof message === 'string') return message;
  try { return String(error); } catch { return 'model_failure_unknown'; }
}

/** Convert a caught dispatch exception without losing its original receipt. */
export function modelFailureResult(error, { signal } = {}) {
  const retained = isObject(error) ? scopeGet(retainedFailures, error) : null;
  const originalResult = retained?.originalResult;
  if (isObject(originalResult) && typeof get(originalResult, 'ok') === 'boolean') {
    const originalFailed = get(originalResult, 'ok') === false;
    const modelFailure = cancelled(originalResult, signal) ? cancellation()
      : originalFailed ? classifyModelFailure(originalResult) : retained.recoveryFailure;
    // A successful answer is retained for local investigation but must not
    // escape as executable success after persistence or a callback fails.
    const result = { ...originalResult, ok: false,
      // Keep the complete successful receipt only on originalResult; expose an
      // inert choice so no downstream JSON/proposal/tool path can execute it.
      ...(originalFailed ? {} : { error: modelFailure.code, choice: { text: '' } }),
      ...(modelFailure.origin === 'cancelled' ? { cancelled: true } : {}),
      modelFailure, recoveryFailure: retained.recoveryFailure };
    Object.defineProperty(result, 'cause', { value: error });
    Object.defineProperty(result, 'originalResult', { value: originalResult });
    return result;
  }
  const modelFailure = classifyModelFailure(error, { signal });
  const status = get(error, 'status');
  const providerPool = get(error, 'providerPool');
  const result = {
    // The original thrown value remains available for investigation; decision
    // metadata is separate and contains no message, cause, or provider text.
    ok: false, error: originalErrorText(error), usage: null, choice: { text: '' },
    ...(status !== undefined ? { status } : {}),
    ...(providerPool !== undefined ? { providerPool } : {}),
    ...(modelFailure.origin === 'cancelled' ? { cancelled: true } : {}),
    modelFailure,
  };
  // Preserve identity for local investigation without serializing causes into
  // the legacy JSON result or a broad spread into a durable receipt.
  Object.defineProperty(result, 'cause', { value: error });
  return result;
}
