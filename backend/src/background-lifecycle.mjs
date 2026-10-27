import { operationalEvent, infrastructureErrorCode, operationalId } from './operational-log.mjs';

// A producer owns every promise it starts, including admission/claim reads.
// stop() is synchronous; close() shares one drain and never closes borrowed stores.
export function createBackgroundLifecycle({ name, clock = () => new Date().toISOString(), logger = null } = {}) {
  const controller = new AbortController();
  const pending = new Set();
  let closePromise = null;
  let failureCount = 0;
  let lastFailure = null;
  function reportFailure(error, phase = 'tick') {
    failureCount += 1;
    lastFailure = { at: clock(), phase, error: String(error?.message || error).slice(0, 2000) };
    if (logger) operationalEvent(logger, `${name}_failure`, { phase: operationalId(phase), errorCode: infrastructureErrorCode(error, 'background_operation_failed') }, { level: 'error', component: 'background' });
    else console.error(`${name}_failure`, JSON.stringify(lastFailure));
  }
  function track(operation, phase = 'tick') {
    const promise = Promise.resolve().then(operation);
    pending.add(promise);
    // This handler owns detached failures without changing the caller's result.
    promise.then(() => pending.delete(promise), error => { pending.delete(promise); reportFailure(error, phase); });
    return promise;
  }
  function stop(reason = new Error('service_shutdown')) { if (!controller.signal.aborted) controller.abort(reason); }
  function close(reason) {
    stop(reason);
    closePromise ||= (async () => {
      // Work admitted before stop may still finish claims and persist cancellation.
      while (pending.size) await Promise.allSettled([...pending]);
    })();
    return closePromise;
  }
  return {
    track, stop, close, reportFailure, signal: controller.signal,
    get stopped() { return controller.signal.aborted; },
    health: () => ({ stopped: controller.signal.aborted, pending: pending.size, failureCount, lastFailure: lastFailure && { ...lastFailure } }),
  };
}

// Attempt every closer in dependency order, retaining all failures.
export async function attemptResourceClosers(closers) {
  const errors = [];
  for (const close of closers) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length) throw new AggregateError(errors, 'runtime_resource_close_failed');
}

// The existing server shutdown deadline bounds waiting, not producer ownership.
// On timeout stores stay open until process exit: no producer can write through
// a closed pool or falsely persist completion during forced shutdown.
export function createCoordinatedShutdown({ stopAdmission, producers = () => [], beforeDrain = async () => {}, drainAdmission = async () => {}, closers = () => [], drainMs, onTimeout = () => {} } = {}) {
  let closing = null;
  return function close() {
    if (closing) return closing;
    stopAdmission();
    const owners = producers().filter(Boolean);
    const errors = [];
    for (const owner of owners) {
      try { owner.stop(); } catch (error) { errors.push(error); }
    }
    closing = (async () => {
      let timer;
      const work = (async () => {
        try { await beforeDrain(); } catch (error) { errors.push(error); }
        const settled = await Promise.allSettled([drainAdmission(), ...owners.map(owner => Promise.resolve().then(() => owner.close()))]);
        errors.push(...settled.filter(item => item.status === 'rejected').map(item => item.reason));
      })();
      const timedOut = await Promise.race([
        work.then(() => false),
        new Promise(resolve => { timer = setTimeout(() => resolve(true), drainMs); }),
      ]);
      clearTimeout(timer);
      if (timedOut) { onTimeout(); return { forced: true, errors }; }
      try { await attemptResourceClosers(closers()); } catch (error) { errors.push(...error.errors); }
      return { forced: false, errors };
    })();
    return closing;
  };
}
