import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { classifyModelFailure, classifyRecoveryFailure, modelFailureResult, withModelFailureScope } from './model-failure.mjs';
import { projectModelFailure, projectModelRecoveryRecord, projectModelRecoverySummary } from './model-recovery-projection.mjs';

const MAX_RETAINED_REQUESTS = 32;
function copyResult(result, fields = {}) {
  const copy = { ...result, ...fields };
  for (const key of ['cause', 'originalResult']) if (result && Object.hasOwn(result, key)) Object.defineProperty(copy, key, { value: result[key] });
  return copy;
}

// The same live turn owns recovery. Only model dispatch is repeated: no tool,
// planner, turn ingress or completed action is executed by this helper.
export function createModelRequestRecovery(adapter, {
  maxAttempts = 3, maxRetriesPerRun = 4, delays = [1000, 3000],
  wait = (ms, signal) => sleep(ms, undefined, { signal }), beforeAttempt = null, onAttempt = null,
} = {}) {
  maxAttempts = Math.min(3, Math.max(1, Number.isSafeInteger(maxAttempts) ? maxAttempts : 3));
  maxRetriesPerRun = Math.min(4, Math.max(0, Number.isSafeInteger(maxRetriesPerRun) ? maxRetriesPerRun : 4));
  let retryCount = 0;
  const requests = [];
  const summary = () => requests.length ? projectModelRecoverySummary({ version: 1, retryCount, requests }) : null;
  const attach = result => summary() ? copyResult(result, { modelRecovery: summary() }) : result;
  const invoke = async (method, args = {}) => {
    const { signal, traceLogger } = args;
    const logicalRequestId = randomUUID();
    let originalFailure = null, lastFailure = null, originalResult = null, lastResult = null;
    let failover = null, partialOutput = null, currentRecord = null, recoveryRoute = null;
    let physicalAttempts = 0, invocationActive = false, currentModelCall = args.modelCall;
    const guard = async () => { signal?.throwIfAborted(); await beforeAttempt?.({ method, args }); signal?.throwIfAborted(); };
    const publish = async (state, extra = {}) => {
      const record = projectModelRecoveryRecord({ state, logicalRequestId, method, attempt: Math.max(1, physicalAttempts), maxAttempts,
        originalFailure, lastFailure, ...(failover ? { failover } : {}), ...(partialOutput ? { partialOutput } : {}), ...extra });
      if (currentRecord) Object.assign(currentRecord, record);
      else { currentRecord = record; requests.push(record); if (requests.length > MAX_RETAINED_REQUESTS) requests.shift(); }
      await traceLogger?.event?.('model-recovery', { ...record });
    };
    const exhausted = () => physicalAttempts >= maxAttempts || physicalAttempts > 0 && retryCount >= maxRetriesPerRun;
    // Inner LB failover and provider-owned repair share the same PHYSICAL
    // dispatch budget. Native ownership/replay decisions stay with the adapter.
    const recoveryContext = {
      logicalRequestId,
      beforeDispatch: async () => {
        await guard();
        if (exhausted()) throw new Error('model_recovery_attempts_exhausted');
        if (physicalAttempts > 0) retryCount++;
        physicalAttempts++;
        return currentModelCall;
      },
      nextModelCall: async () => {
        await guard();
        currentModelCall = onAttempt ? await onAttempt({ method, attempt: physicalAttempts + 1, args }) : (args.modelCall ?? 0) + physicalAttempts;
        return currentModelCall;
      },
      finalizers: new Map(),
    };
    const finish = async result => {
      invocationActive = false;
      let correction = null;
      const recordFault = error => {
        const fault = modelFailureResult(error, { signal });
        lastFailure = signal?.aborted ? fault.modelFailure : classifyRecoveryFailure(error);
        if (!originalFailure) { originalFailure = result.modelFailure || lastFailure; originalResult = result; }
        result = result?.ok === false && !signal?.aborted
          ? copyResult(result, { recoveryFailure: lastFailure })
          : copyResult(fault, { recoveryFailure: lastFailure });
        correction = lastFailure.origin === 'cancelled' ? 'cancelled'
          : lastFailure.origin === 'unknown' ? 'requires_investigation' : 'blocked';
      };
      for (const finalize of recoveryContext.finalizers.values()) {
        try { await finalize(result); } catch (error) { recordFault(error); }
      }
      try { await guard(); } catch (error) { recordFault(error); }
      // Completion bookkeeping can fail or be cancelled after a successful
      // generation. Correct both durable summary AND transition consumers;
      // an earlier resumed event cannot remain the final observed state.
      if (correction) {
        try { await publish(correction); }
        catch (error) {
          if (!signal?.aborted) {
            lastFailure = classifyRecoveryFailure(error);
            if (currentRecord) Object.assign(currentRecord, { state: lastFailure.origin === 'unknown' ? 'requires_investigation' : 'blocked', lastFailure });
          }
        }
      }
      // Once correction is needed the result is already inert. Do not put
      // another asynchronous ownership read AFTER that publication and silently
      // revise it again. Cancellation may arrive during the correction write;
      // upgrade it once to the terminal cancellation state, then return failure.
      if (correction && correction !== 'cancelled' && signal?.aborted) {
        recordFault(signal.reason);
        try { await publish('cancelled'); } catch {}
      }
      return attach(result);
    };
    const stopped = async error => {
      return finish(modelFailureResult(error || signal?.reason || new DOMException('Aborted', 'AbortError'), { signal }));
    };
    while (true) {
      if (signal?.aborted) return stopped();
      let textChars = 0, thoughtChars = 0, response;
      const priorAttempts = physicalAttempts;
      try {
        await guard();
        const outputOnly = ['image', 'audio'].includes(adapter.outputKind);
        const callArgs = { ...args, ...(!outputOnly ? { recoveryContext, ...(recoveryRoute ? { recoveryRoute } : {}) } : {}) };
        invocationActive = true;
        let thisInvocationActive = true;
        for (const [name, kind] of [['onTextDelta', 'text'], ['onThoughtDelta', 'thought']]) {
          if (typeof args[name] !== 'function') continue;
          callArgs[name] = async event => {
            if (!thisInvocationActive || !invocationActive || signal?.aborted) return;
            const delta = typeof event === 'string' ? event : event?.delta;
            if (kind === 'text') textChars += String(delta || '').length; else thoughtChars += String(delta || '').length;
            return args[name]({ ...(typeof event === 'string' ? { delta: event } : event), modelCall: currentModelCall });
          };
        }
        // Test/custom adapters may not use the fetch gate. Give them the same
        // bounded attempt contract without adding fields to media requests.
        if (!adapter.url && !adapter.logicalConnectionId) {
          await recoveryContext.nextModelCall();
          await recoveryContext.beforeDispatch();
          if (!outputOnly) callArgs.modelCall = currentModelCall;
        }
        try {
          response = await withModelFailureScope(async () => {
            try { return await adapter[method](callArgs); }
            catch (error) { return modelFailureResult(error, { signal }); }
          });
        } finally { thisInvocationActive = false; invocationActive = false; }
        await guard(); // Settlement fence, before this result may reach tools.
        if (response?.ok === true) {
          if (originalFailure) await publish('resumed');
          await guard(); // Stop/reset can race the persisted resumed receipt.
          return finish(response);
        }
        if (!response || response.ok !== false) response = modelFailureResult(new Error('model_result_invalid'));
      } catch (error) {
        const fault = modelFailureResult(error, { signal });
        response = response?.ok === false && !signal?.aborted ? copyResult(response, { recoveryFailure: fault.modelFailure }) : fault;
      }
      // A malformed/config-only adapter may never cross a physical boundary.
      if (physicalAttempts === priorAttempts) {
        if (physicalAttempts > 0) retryCount++;
        physicalAttempts++;
      }
      const failure = classifyModelFailure(response, { signal });
      response = copyResult(response, { modelFailure: failure });
      lastResult = response;
      lastFailure = response.recoveryFailure ? projectModelFailure(response.recoveryFailure) : failure;
      if (!originalFailure) { originalFailure = failure; originalResult = response; }
      failover = response.providerPool?.failover || failover;
      recoveryRoute = response.providerPool || recoveryRoute;
      partialOutput = { textChars, thoughtChars };
      if (failure.origin === 'cancelled' || signal?.aborted) return stopped();
      const state = lastFailure.origin === 'unknown' ? 'requires_investigation'
        : lastFailure.origin === 'burrow' || !lastFailure.retryable || ['image', 'audio'].includes(adapter.outputKind) ? 'blocked'
          : exhausted() ? 'exhausted' : 'recovering';
      try {
        const delayMs = state === 'recovering' ? Math.min(30_000, Math.max(0, Number(delays[Math.max(0, physicalAttempts - 1)] ?? 3000) || 0)) : 0;
        await publish(state, { delayMs });
        await guard();
        if (state !== 'recovering') return finish(lastFailure.origin !== 'upstream' && originalFailure.origin === 'upstream' ? copyResult(originalResult, { recoveryFailure: lastFailure }) : lastResult);
        await wait(delayMs, signal);
        await guard();
      } catch (error) {
        if (signal?.aborted || error?.name === 'AbortError') return stopped(error);
        lastFailure = classifyRecoveryFailure(error);
        if (currentRecord) Object.assign(currentRecord, { state: lastFailure.origin === 'unknown' ? 'requires_investigation' : 'blocked', lastFailure });
        return finish(copyResult(originalResult, { recoveryFailure: lastFailure }));
      }
    }
  };
  return { ...adapter, complete: args => invoke('complete', args),
    ...(typeof adapter.continueWithToolResults === 'function' ? { continueWithToolResults: args => invoke('continueWithToolResults', args) } : {}),
    recoverySummary: summary,
  };
}
