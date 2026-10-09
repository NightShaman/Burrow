import { performance } from 'node:perf_hooks';
import { wireFingerprint } from './wire-fingerprint.mjs';

const pending = new WeakMap();
// Observe failures immediately, but surface them at the mandatory flush boundary.
// Never retain/log exception text: provider and persistence errors may contain secrets.
export function deferProviderDiagnostic(traceLogger, operation) {
  if (!traceLogger) return;
  if (traceLogger.deferDiagnostic) return traceLogger.deferDiagnostic(operation);
  let state = pending.get(traceLogger);
  if (!state) { state = { tasks: new Set(), failed: false }; pending.set(traceLogger, state); }
  const task = Promise.resolve().then(operation).catch(() => { state.failed = true; });
  state.tasks.add(task);
  void task.then(() => state.tasks.delete(task));
}

export async function flushProviderDiagnostics(traceLogger) {
  if (traceLogger?.flushDiagnostics) return traceLogger.flushDiagnostics();
  const state = traceLogger && pending.get(traceLogger);
  if (!state) return;
  while (state.tasks.size) await Promise.all([...state.tasks]);
  if (state.failed) throw new Error('provider_diagnostic_persistence_failed');
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
    wrap(callback, kind) { return async (delta) => { if (delta?.delta) this.useful(kind); return callback?.(delta); }; },
  };
}

// Local invocation is NOT provider acceptance. Persistence never gates headers
// or response reads; all scheduled receipts must flush before trace shutdown.
export async function invokeProviderFetch(fetchImpl, url, options, { traceLogger, requestId, provider, api, model, modelCall = null, clock = () => new Date().toISOString(), timing = providerTiming({ traceLogger, requestId, provider, api, model, modelCall, clock }) } = {}) {
  const invokedAt = clock();
  const monotonicMs = performance.now();
  let response;
  try { response = fetchImpl(url, options); }
  catch (error) { response = Promise.reject(error); }
  timing.mark('provider-dispatched', { invokedAt, monotonicMs, boundary: 'local-fetch-invocation', providerAcceptance: 'unknown' });
  deferProviderDiagnostic(traceLogger, async () => {
    const wire = traceLogger?.artifact ? wireFingerprint(options?.body) : null;
    const wireFingerprintArtifact = wire ? await traceLogger.artifact(`provider-wire-${requestId}.json`, JSON.stringify({ requestId, provider, api, model, modelCall, invokedAt, ...wire })) : null;
    await traceLogger?.event?.('provider-fetch-invoked', {
      runId: traceLogger?.runId || null, requestId, provider, api, model, modelCall, invokedAt, monotonicMs, clockDomain: 'server-process',
      boundary: 'local-fetch-invocation', providerAcceptance: 'unknown', wireFingerprintArtifact,
    });
  });
  const result = await response;
  timing.mark('provider-response-headers', { status: result.status });
  return result;
}
