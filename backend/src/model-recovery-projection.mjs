import { classifyModelFailure } from './model-failure.mjs';

// These projections are wire/persistence schemas, not error serializers. Keep
// provider envelopes, messages, causes, credentials and arbitrary extra fields
// out even when a caller accidentally supplies an unsanitized trace record.
const STATES = new Set(['recovering', 'resumed', 'exhausted', 'blocked', 'requires_investigation', 'cancelled']);
const METHODS = new Set(['complete', 'continueWithToolResults']);
const FAILOVER_CODES = new Set([
  'provider_pool_replay_incomplete_history', 'provider_pool_replay_nonportable_history',
  'provider_pool_replay_unavailable', 'provider_pool_alternate_selection_failed',
  'provider_pool_alternate_resolution_failed', 'provider_pool_continuation_owner_missing',
  'provider_pool_continuation_owner_unavailable', 'provider_pool_signed_history_owner_missing',
]);
const FAILOVER_ACTIONS = new Set(['blocked', 'retry', 'requires_investigation', 'cancelled']);
const MAX_REQUESTS = 32;
const read = (value, key) => { try { return value?.[key]; } catch { return undefined; } };
const object = value => value !== null && typeof value === 'object';
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value) ? value : undefined;
const integer = (value, max, min = 0) => Number.isSafeInteger(value) && value >= min ? Math.min(value, max) : undefined;

export function projectModelFailure(value) {
  if (!object(value)) return null;
  // Reuse the classifier's exact producer-owned code allowlist; a token-shaped
  // provider error is not automatically a safe operational classification.
  const failure = classifyModelFailure({ ok: false, modelFailure: value });
  if (!/^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(failure.code)) {
    return { origin: 'unknown', code: 'model_failure_unknown', retryable: false };
  }
  return failure;
}

export function projectModelRecoveryRecord(value) {
  if (!object(value) || !STATES.has(read(value, 'state'))) return null;
  const record = { state: read(value, 'state') };
  const logicalRequestId = safeId(read(value, 'logicalRequestId'));
  if (logicalRequestId) record.logicalRequestId = logicalRequestId;
  if (METHODS.has(read(value, 'method'))) record.method = read(value, 'method');
  for (const [key, max, min] of [['attempt', 1_000, 1], ['maxAttempts', 1_000, 1], ['delayMs', 3_600_000, 0], ['retryCount', 1_000_000, 0]]) {
    const count = integer(read(value, key), max, min);
    if (count !== undefined) record[key] = count;
  }
  for (const key of ['originalFailure', 'lastFailure']) {
    const failure = projectModelFailure(read(value, key));
    if (failure) record[key] = failure;
  }
  const failover = read(value, 'failover');
  if (object(failover)) {
    record.failover = {
      code: FAILOVER_CODES.has(read(failover, 'code')) ? read(failover, 'code') : 'model_failover_blocked',
      action: FAILOVER_ACTIONS.has(read(failover, 'action')) ? read(failover, 'action') : 'blocked',
    };
  }
  const partial = read(value, 'partialOutput');
  if (object(partial)) {
    const textChars = integer(read(partial, 'textChars'), 1_000_000_000);
    const thoughtChars = integer(read(partial, 'thoughtChars'), 1_000_000_000);
    if (textChars !== undefined || thoughtChars !== undefined) record.partialOutput = {
      ...(textChars === undefined ? {} : { textChars }),
      ...(thoughtChars === undefined ? {} : { thoughtChars }),
    };
  }
  return record;
}

export function projectModelRecoverySummary(value) {
  if (!object(value) || read(value, 'version') !== 1) return null;
  const requests = read(value, 'requests');
  return {
    version: 1,
    retryCount: integer(read(value, 'retryCount'), 1_000_000) ?? 0,
    requests: Array.isArray(requests) ? requests.slice(-MAX_REQUESTS).map(projectModelRecoveryRecord).filter(Boolean) : [],
  };
}

export function projectModelRecoveryMetadata(source = {}) {
  const model = read(source, 'model');
  const modelFailure = projectModelFailure(read(source, 'modelFailure') ?? read(model, 'modelFailure'));
  const modelRecovery = projectModelRecoverySummary(read(source, 'modelRecovery') ?? read(model, 'modelRecovery'));
  return {
    ...(modelFailure ? { modelFailure } : {}),
    ...(modelRecovery ? { modelRecovery } : {}),
  };
}

export function modelRecoveryProgress(trace = {}) {
  const publicProgress = read(trace, 'publicProgress');
  const value = read(trace, 'type') === 'model-recovery' ? read(trace, 'payload')
    : read(trace, 'type') === 'model.recovery' ? read(trace, 'data')
      : read(publicProgress, 'type') === 'model.recovery' ? read(publicProgress, 'data') : null;
  const data = projectModelRecoveryRecord(value);
  return data ? { type: 'model.recovery', data } : null;
}

/** Recovery is activity within a turn, never a run terminal. Cancellation is
 * authoritative even if a late recovery/response callback races with Stop. */
export function applyModelRecoveryProgress(record, progress) {
  if (progress?.type !== 'model.recovery') return false;
  if (record.controller?.signal?.aborted || record.cancelled === true || record.phase === 'cancelling' || progress.data?.state === 'cancelled') {
    record.phase = 'cancelling';
    record.steeringReady = false;
    return true;
  }
  record.phase = progress.data?.state === 'recovering' ? 'recovering' : 'thinking';
  if (progress.data?.state === 'recovering') {
    record.answerText = '';
    delete record.answerModelCall;
  }
  return true;
}
