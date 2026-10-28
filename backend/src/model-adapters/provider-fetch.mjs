import { performance } from 'node:perf_hooks';
import { wireFingerprint } from './wire-fingerprint.mjs';
import { markProviderTransportError, markModelInternalError, markModelCallbackError, modelFailureResult, retainModelFailure } from '../model-failure.mjs';

const pending = new WeakMap();
// Observe failures immediately, but surface them at the mandatory flush boundary.
// Never retain/log exception text: provider and persistence errors may contain secrets.
export function deferProviderDiagnostic(traceLogger, operation) {
  if (!traceLogger) return;
  let state = pending.get(traceLogger);
  if (!state) { state = { tasks: new Set(), failed: false }; pending.set(traceLogger, state); }
  const track = (task) => {
    task = Promise.resolve(task).catch(() => { state.failed = true; });
    state.tasks.add(task);
    void task.then(() => state.tasks.delete(task));
  };
  try {
    // Existing loggers own the lifetime of their deferred task. A custom
    // logger may also return a promise or throw synchronously while scheduling.
    if (traceLogger.deferDiagnostic) {
      const scheduled = traceLogger.deferDiagnostic(operation);
      if (scheduled && typeof scheduled.then === 'function') track(scheduled);
    } else track(Promise.resolve().then(operation));
  } catch { state.failed = true; }
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
export async function settleProviderDiagnostics(traceLogger, operation) {
  let result, primary, failed = false;
  try { result = await operation(value => { result = value; return value; }); }
  catch (error) { failed = true; primary = error; }
  // Snapshot before flush: even a logger rethrowing the identical Error object
  // cannot replace the provider's scoped provenance with local provenance.
  const original = failed ? (result ?? modelFailureResult(primary)) : result;
  // A local result-callback exception may be the exact same object later
  // thrown by flush; capture its classification before that can be overwritten.
  const recordedError = failed && result !== undefined ? retainModelFailure(primary, result) : primary;
  try { await flushProviderDiagnostics(traceLogger); }
  catch (secondary) {
    if (failed && result !== undefined) throw recordedError;
    throw retainModelFailure(secondary, original);
  }
  if (failed) throw recordedError;
  return result;
}

export function providerTiming({ traceLogger, requestId, provider, api, model, modelCall = null, clock = () => new Date().toISOString(), monotonicClock = () => performance.now() } = {}) {
  const ownership = { runId: traceLogger?.runId || null, requestId, provider, api, model, modelCall };
  let firstUseful = false;
  const mark = (type, extra = {}) => {
    const payload = { ...ownership, observedAt: clock(), monotonicMs: monotonicClock(), clockDomain: 'server-process', ...extra };
    deferProviderDiagnostic(traceLogger, () => traceLogger.event?.(type, payload));
    return payload;
  };
  return {
    mark,
    useful(kind) { if (!firstUseful) { firstUseful = true; mark('provider-first-useful-delta', { kind }); } },
    wrap(callback, kind) { return async (delta) => { if (delta?.delta) this.useful(kind); return providerCallback(() => callback?.(delta)); }; },
  };
}

// Local invocation is NOT provider acceptance. Persistence never gates headers
// or response reads; all scheduled receipts must flush before trace shutdown.
export async function invokeProviderFetch(fetchImpl, url, options, { traceLogger, requestId, provider, api, model, modelCall = null, recoveryContext = null, clock = () => new Date().toISOString(), timing = providerTiming({ traceLogger, requestId, provider, api, model, modelCall, clock }) } = {}) {
  // This gate belongs to local recovery and MUST not acquire fetch provenance.
  await recoveryContext?.beforeDispatch?.();
  const invokedAt = clock();
  const monotonicMs = performance.now();
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
