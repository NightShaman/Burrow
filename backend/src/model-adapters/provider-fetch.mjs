import { performance } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';
import { hasProviderDelta, providerCompletion, providerUsageValues, capturedProviderUsage, providerTokenCount } from './provider-responsiveness.mjs';
import { wireFingerprint } from './wire-fingerprint.mjs';
import { poolAttemptUsage } from '../postgres-provider-pool-metrics.mjs';
import { markProviderTransportError, markModelInternalError, markModelCallbackError, modelFailureResult, retainModelFailure } from '../model-failure.mjs';

const pending = new WeakMap();
const routing = new AsyncLocalStorage();
// Optional responsiveness must not hold routing or trace shutdown hostage to a
// custom observer that never settles. Mandatory pre-existing receipts keep
// their durable flush/failure contract.
const OPTIONAL_DIAGNOSTIC_TIMEOUT_MS = 100;
function optionalDiagnostic(operation) {
  return new Promise(resolve => {
    const timer = setTimeout(resolve, OPTIONAL_DIAGNOSTIC_TIMEOUT_MS);
    Promise.resolve().then(operation).catch(() => {}).finally(() => { clearTimeout(timer); resolve(); });
  });
}
export const withProviderRoute = (route, operation) => routing.run(route, operation);
// Standard loggers expose an observer-only path for new optional observations.
// Legacy custom loggers retain their explicit callback contract; their optional
// callback is bounded, but Core never starts a detachable standard file write.
export function providerObservation(logger, type, payload) {
  if (typeof logger?.observeOptional === 'function') return logger.observeOptional(type,payload);
  return type === 'model' ? logger?.model?.(payload) : logger?.event?.(type,payload);
}

// Observe failures immediately, but surface them at the mandatory flush boundary.
// Never retain/log exception text: provider and persistence errors may contain secrets.
export function deferProviderDiagnostic(traceLogger, operation, { optional = false, bounded = optional } = {}) {
  if (!traceLogger) return;
  let state = pending.get(traceLogger);
  if (!state) { state = { tasks: new Set(), failed: false }; pending.set(traceLogger, state); }
  const track = (scheduled) => {
    const task = (bounded ? optionalDiagnostic(() => scheduled) : Promise.resolve(scheduled)).catch(() => { if (!optional) state.failed = true; });
    state.tasks.add(task);
    void task.then(() => state.tasks.delete(task));
  };
  try {
    // Existing loggers own the lifetime of their deferred task. A custom
    // logger may also return a promise or throw synchronously while scheduling.
    // Optional responsiveness receipts must not poison the logger's own
    // diagnostic failure flag. Existing mandatory receipts remain mandatory.
    const invoke = bounded ? () => optionalDiagnostic(operation) : operation;
    if (traceLogger.deferDiagnostic) {
      const scheduled = traceLogger.deferDiagnostic(invoke);
      if (scheduled && typeof scheduled.then === 'function') track(scheduled);
    } else track(Promise.resolve().then(invoke));
  } catch { if (!optional) state.failed = true; }
}

export async function flushProviderDiagnostics(traceLogger) {
  const state = traceLogger && pending.get(traceLogger);
  try {
    await traceLogger?.flushDiagnostics?.();
    if (state) {
      while (state.tasks.size) await Promise.all([...state.tasks]);
      if (state.failed) throw new Error('provider_diagnostic_persistence_failed');
    }
  } catch (error) { throw markModelInternalError(error); }
}

// These boundaries are intentionally explicit: arbitrary callback failures
// are unknown, while direct trace persistence failures are Burrow-owned.
export async function providerDiagnostic(operation) {
  try { return await operation(); }
  catch (error) { throw markModelInternalError(error); }
}
export async function providerCallback(operation) {
  try { return await operation(); }
  catch (error) { markModelCallbackError(error); throw error; }
}

// Flush without allowing a later diagnostics error to replace the response or
// transport failure. Finished provider results are registered BEFORE response
// callbacks/logging; a success plus persistence failure is still a failure.
export async function settleProviderDiagnostics(traceLogger, operation, { timing = null, signal = null } = {}) {
  let result, primary, failed = false;
  try { result = await operation(value => { result = value; try { timing?.received?.(value); } catch {} return value; }); }
  catch (error) { failed = true; primary = error; }
  // Snapshot before flush: even a logger rethrowing the identical Error object
  // cannot replace the provider's scoped provenance with local provenance.
  const original = failed ? (result ?? modelFailureResult(primary)) : result;
  // A local result-callback exception may be the exact same object later
  // thrown by flush; capture its classification before that can be overwritten.
  const recordedError = failed && result !== undefined ? retainModelFailure(primary, result) : primary;
  try { timing?.finish(original, { error: failed ? primary : null, signal }); } catch { /* Optional projection must not replace a provider result. */ }
  try { await flushProviderDiagnostics(traceLogger); }
  catch (secondary) {
    if (failed && result !== undefined) throw recordedError;
    throw retainModelFailure(secondary, original);
  }
  if (failed) throw recordedError;
  return result;
}

export function providerTiming({ traceLogger, requestId, provider, api, model, modelCall = null, identity = {}, contextBudgetTokens = null, clock = () => new Date().toISOString(), monotonicClock = () => performance.now() } = {}) {
  const route = routing.getStore();
  const ownership = { runId: traceLogger?.runId || null, requestId, provider, api, model, modelCall, ...identity,
    ...(route ? { poolId: route.poolId, poolName: route.poolName, poolRequestId: route.poolRequestId, accountId: route.accountId, accountName: route.accountName } : {}) };
  let firstUseful = false, dispatchedAt = null, responseStatus = null, receivedAt = null, finished = false;
  let receipts = null, physical = null;
  const channels = new Set();
  const mark = (type, extra = {}) => {
    const payload = { ...ownership, ...(route?.attempt ? { attempt: route.attempt } : {}), observedAt: clock(), monotonicMs: monotonicClock(), clockDomain: 'server-process', ...extra };
    // Capture per-dispatch token receipts in memory for nested signed-history
    // repair: an outer member return alone describes only its last fetch.
    try { route?.observe?.(type, payload); } catch { /* Observation is never a provider failure. */ }
    if (type === 'provider-dispatched') dispatchedAt = payload.monotonicMs;
    if (type === 'provider-response-headers' && Number.isInteger(payload.status) && payload.status >= 100 && payload.status <= 599) responseStatus = payload.status;
    const optional = type === 'provider-first-content' || type === 'provider-completed' || (type === 'provider-first-useful-delta' && extra.kind === 'tool');
    // Bound the invocation, not time queued behind mandatory dispatch/header
    // receipts: slow durable writes must not let completion escape the flush.
    deferProviderDiagnostic(traceLogger, () => {
      // Persistence remains off the provider read path, but a later completion
      // must not overtake its own dispatch/content receipt at the observer.
      // Start the first receipt immediately when its deferred task runs, so it
      // retains the pre-existing order ahead of provider-fetch-invoked.
      const observe = () => optional ? optionalDiagnostic(() => providerObservation(traceLogger,type,payload)) : traceLogger.event?.(type, payload);
      const task = receipts ? receipts.then(observe) : Promise.resolve(observe());
      receipts = task.catch(() => {});
      return task;
    }, { optional, bounded:false });
    return payload;
  };
  const capture = (result, options = {}) => {
    const normalizedUsage = result?.normalizedUsage
      ? capturedProviderUsage(result.normalizedUsage) : providerUsageValues(result?.usage, { provider, api });
    const completion = providerCompletion(result, { ...options, observedStatus:responseStatus });
    const context = result?.contextUsage, estimatedTokens = providerTokenCount(context?.estimatedTokens);
    const receipt = { ok:result?.ok === true, requestId, ...completion,
      normalizedUsage,
      ...(estimatedTokens !== null ? { contextUsage:{ estimatedTokens, source:context?.source === 'provider-input-tokens' ? 'provider-input-tokens' : 'provider-request-estimate' }, contextBudgetTokens:providerTokenCount(contextBudgetTokens) } : {}) };
    try { route?.complete?.(requestId, receipt, {
      // Keep the older durable pool error/outcome enums independent of the
      // richer physical OTel outcome (for example timeout vs cancellation).
      usage:poolAttemptUsage(result?.usage),
      errorKind:result?.ok === true ? null : options.error && !result?.status
        ? options.signal?.aborted ? 'cancelled' : 'exception' : 'provider_failure',
      cancelled:options.signal?.aborted === true || options.error?.name === 'AbortError' || result?.cancelled === true,
    }); } catch { /* Best effort accounting only. */ }
    return receipt;
  };
  return {
    mark, ownership, now: monotonicClock,
    // The standard logger persists these events; legacy custom loggers may
    // intentionally discard provider events altogether.
    // Explicit opt-in is available to custom event-capable loggers.
    projected: typeof traceLogger?.deferDiagnostic === 'function' || traceLogger?.providerTiming === true,
    received(result) { receivedAt ??= monotonicClock(); physical ||= capture(result); },
    useful(kind) { if (!firstUseful) { firstUseful = true; mark('provider-first-useful-delta', { kind }); } },
    stream(kind) {
      if (dispatchedAt === null || !['text', 'thought', 'tool'].includes(kind) || channels.has(kind)) return;
      const monotonicMs = monotonicClock(), ttftMs = monotonicMs - dispatchedAt;
      if (!Number.isFinite(ttftMs) || ttftMs < 0) return;
      const first = channels.size === 0;
      channels.add(kind);
      mark('provider-first-content', { kind, first, ttftMs, monotonicMs, boundary: 'parsed-stream-content' });
      if (kind === 'tool' && !firstUseful) { firstUseful = true; mark('provider-first-useful-delta', { kind }); }
    },
    // Terminal snapshots are still delivered to callers, but are not deltas.
    wrap(callback, kind) { return async (delta, terminalSnapshot = false) => { if (hasProviderDelta(delta?.delta)) { if (!terminalSnapshot) { try { this.stream(kind); } catch {} } this.useful(kind); } return providerCallback(() => callback?.(delta)); }; },
    finish(result, options) {
      if (finished || dispatchedAt === null) return;
      finished = true;
      // A parsed receipt is the physical provider outcome. Later callback or
      // persistence errors still fail the caller/recovery, not this provider.
      const receipt = physical || capture(result, options);
      const { outcome, status, failureCategory } = receipt;
      mark('provider-completed', { outcome, ...(status !== undefined ? { status } : {}), ...(failureCategory ? { failureCategory } : {}),
        result:receipt, durationMs: Math.max(0, (receivedAt ?? monotonicClock()) - dispatchedAt) });
    },
  };
}

// Local invocation is NOT provider acceptance. Persistence never gates headers
// or response reads; all scheduled receipts must flush before trace shutdown.
export async function invokeProviderFetch(fetchImpl, url, options, { traceLogger, requestId, provider, api, model, modelCall = null, recoveryContext = null, clock = () => new Date().toISOString(), timing = providerTiming({ traceLogger, requestId, provider, api, model, modelCall, clock }) } = {}) {
  // This gate belongs to local recovery and MUST not acquire fetch provenance.
  await recoveryContext?.beforeDispatch?.();
  const invokedAt = clock();
  const monotonicMs = timing.now?.() ?? performance.now();
  // Observe only the fetch rejection, not diagnostics or the code following it.
  // Resolve the outcome immediately so a synchronous diagnostic exception
  // cannot leave the fetch rejection unhandled.
  const response = (async () => {
    try { return { value: await fetchImpl(url, options) }; }
    catch (error) {
      // Fetch reports malformed/unsupported URLs as TypeErrors too. Validate
      // the attempted endpoint only when fetch failed, not on the hot path.
      let validEndpoint = false;
      try { validEndpoint = ['http:', 'https:'].includes(new URL(url).protocol); } catch {}
      markProviderTransportError(error, { stage: validEndpoint ? 'fetch' : 'configuration' });
      return { failed: true, error };
    }
  })();
  timing.mark('provider-dispatched', { invokedAt, monotonicMs, boundary: 'local-fetch-invocation', providerAcceptance: 'unknown' });
  deferProviderDiagnostic(traceLogger, async () => {
    const wire = traceLogger?.artifact ? wireFingerprint(options?.body) : null;
    const wireFingerprintArtifact = wire ? await traceLogger.artifact(`provider-wire-${requestId}.json`, JSON.stringify({ requestId, provider, api, model, modelCall, invokedAt, ...wire })) : null;
    await traceLogger?.event?.('provider-fetch-invoked', {
      runId: traceLogger?.runId || null, requestId, provider, api, model, modelCall, invokedAt, monotonicMs, clockDomain: 'server-process',
      boundary: 'local-fetch-invocation', providerAcceptance: 'unknown', wireFingerprintArtifact,
    });
  });
  const outcome = await response;
  if (outcome.failed) throw outcome.error;
  const result = outcome.value;
  timing.mark('provider-response-headers', { status: result.status });
  return result;
}

// These wrappers contain only the provider read itself. Parsing, callbacks,
// logging, decoding and cancellation stay outside the provenance boundary.
export async function readProviderChunk(reader) {
  const read = reader.read;
  if (typeof read !== 'function') throw new TypeError('provider_response_read_method_invalid');
  try { return await read.call(reader); }
  catch (error) { markProviderTransportError(error, { stage: 'read' }); throw error; }
}

export async function readProviderText(response, { method = 'text' } = {}) {
  // Missing methods or property getters are local programming errors, not a
  // failed read. Invoke only an existing method within the read boundary.
  const read = response[method];
  if (typeof read !== 'function') throw new TypeError('provider_response_read_method_invalid');
  try { return await read.call(response); }
  catch (error) { markProviderTransportError(error, { stage: 'read' }); throw error; }
}
