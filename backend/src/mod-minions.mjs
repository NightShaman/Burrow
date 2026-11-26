import { isDeepStrictEqual } from 'node:util';
import { createBackgroundLifecycle } from './background-lifecycle.mjs';
import { boundaryDiagnostic } from './diagnostic-boundary.mjs';

const TERMINAL = new Set(['succeeded', 'failed', 'interrupted', 'cancelled']);
const EXECUTION_ERRORS = new Set([
  'mod_minion_selection_unavailable', 'mod_minion_execution_host_unavailable',
  'mod_minion_reasoning_effort_unsupported', 'mod_minion_service_identity_store_required',
  'mod_minion_session_identity_mismatch', 'mod_minion_runtime_dependencies_required',
]);
function executionFailureCode(error) {
  if (EXECUTION_ERRORS.has(error?.message)) return error.message;
  const diagnostic = boundaryDiagnostic(error, 'mod_minion_execute');
  return diagnostic.errorCode === 'operation_failed' ? 'mod_minion_execution_failed' : diagnostic.errorCode;
}

export function publicMinionJob(job) {
  const payload = job.payload || {};
  return {
    id: job.id, status: job.status, harness: payload.harness,
    connectionId: payload.connectionId, model: payload.model,
    reasoningEffort: payload.reasoningEffort ?? null,
    executionHostId: payload.executionHostId || 'local', target: payload.target,
    createdAt: job.createdAt, updatedAt: job.updatedAt,
    startedAt: job.startedAt, completedAt: job.completedAt,
    result: job.result ?? null, error: job.error ?? null,
  };
}

export function createModMinionDispatcher({ store, resolveCatalog, execute, maxConcurrent = null, logger = console } = {}) {
  if (!store || typeof resolveCatalog !== 'function' || typeof execute !== 'function') {
    throw new Error('mod_minion_dispatcher_dependencies_required');
  }
  if (maxConcurrent !== null && (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1)) {
    throw new Error('mod_minion_concurrency_invalid');
  }
  // No new implicit worker cap: deployments may explicitly bound admission;
  // provider quota and the existing harness policies remain authoritative.
  const concurrency = maxConcurrent ?? Infinity;
  const lifecycle = createBackgroundLifecycle({ name: 'mod_minion_dispatcher', logger });
  const queue = [];
  const active = new Map();
  const drainFailures = [];
  let running = 0;

  async function run(job) {
    const controller = new AbortController();
    active.set(job.id, controller);
    try {
      if (lifecycle.stopped) {
        await store.completeQueued(job.id, { status: 'interrupted', error: 'service_shutdown' });
        return;
      }
      const claimed = await store.markRunning(job.id);
      if (!claimed) return; // An atomic queued cancellation/shutdown won.
      if (lifecycle.stopped || controller.signal.aborted) {
        await store.complete(job.id, { status: lifecycle.stopped ? 'interrupted' : 'cancelled',
          error: lifecycle.stopped ? 'service_shutdown' : 'cancelled' });
        return;
      }
      let result;
      let executionError;
      try {
        result = await execute(claimed.payload, {
          signal: AbortSignal.any([controller.signal, lifecycle.signal]),
          jobId: job.id, ownerModId: claimed.ownerModId,
        });
      } catch (error) {
        executionError = error;
      }
      const status = lifecycle.stopped ? 'interrupted' : controller.signal.aborted ? 'cancelled'
        : !executionError && result?.ok === true ? 'succeeded' : 'failed';
      // Store failures propagate to the lifecycle owner and shutdown health;
      // never report a terminal receipt when it was not durably written.
      await store.complete(job.id, { status, result: result ?? null,
        error: status === 'interrupted' ? 'service_shutdown' : status === 'cancelled' ? 'cancelled'
          : executionError ? executionFailureCode(executionError) : null });
    } finally {
      active.delete(job.id);
    }
  }

  function launch() {
    while (!lifecycle.stopped && running < concurrency && queue.length) {
      const job = queue.shift();
      running += 1;
      const work = lifecycle.track(() => run(job), 'dispatch');
      // Both settlements are handled: .finally() on a detached rejection would
      // create a second unhandled promise during database outages.
      void work.then(
        () => { running -= 1; launch(); },
        error => { drainFailures.push(error); running -= 1; launch(); },
      );
    }
  }

  function stop() {
    if (lifecycle.stopped) return;
    lifecycle.stop(new Error('service_shutdown'));
    for (const controller of active.values()) controller.abort(new Error('service_shutdown'));
    for (const job of queue.splice(0)) {
      const work = lifecycle.track(() => store.completeQueued(job.id,
        { status: 'interrupted', error: 'service_shutdown' }), 'queued-interrupt');
      void work.then(undefined, error => { drainFailures.push(error); });
    }
  }

  return Object.freeze({
    catalog: input => resolveCatalog(input),
    async submit({ ownerModId, idempotencyKey, payload }) {
      if (lifecycle.stopped) throw new Error('mod_minion_dispatcher_stopped');
      // The persisted owner/key identity is authoritative. A completed retry
      // must remain readable after its provider or host was removed.
      const existing = await store.getByKey(ownerModId, idempotencyKey);
      if (existing) {
        if (store.assertSamePayload) store.assertSamePayload(existing, payload);
        else if (!isDeepStrictEqual(existing.payload, payload)) throw new Error('mod_minion_idempotency_conflict');
        return { job: publicMinionJob(existing), replayed: true };
      }
      return lifecycle.track(async () => {
        const current = await resolveCatalog({ executionHostIds: [payload.executionHostId] });
        const eligible = await execute.validate?.(payload, current);
        if (eligible === false) throw new Error('mod_minion_selection_unavailable');
        const created = await store.create({ ownerModId, idempotencyKey, payload });
        if (!created.replayed) {
          if (lifecycle.stopped) {
            const interrupted = await store.completeQueued(created.job.id,
              { status: 'interrupted', error: 'service_shutdown' });
            return { job: publicMinionJob(interrupted || created.job), replayed: false };
          }
          queue.push(created.job);
          launch();
        }
        return { job: publicMinionJob(created.job), replayed: created.replayed };
      }, 'admission');
    },
    async read(owner, id) {
      const job = await store.getOwned(owner, id);
      return job ? publicMinionJob(job) : null;
    },
    async cancel(owner, id) {
      const job = await store.getOwned(owner, id);
      if (!job) return null;
      if (!TERMINAL.has(job.status)) {
        active.get(id)?.abort(new Error('cancelled'));
        const cancelled = await store.completeQueued(id, { status: 'cancelled', error: 'cancelled' });
        if (cancelled) {
          const index = queue.findIndex(candidate => candidate.id === id);
          if (index !== -1) queue.splice(index, 1);
        }
      }
      const current = await store.getOwned(owner, id);
      return current ? publicMinionJob(current) : publicMinionJob(job);
    },
    stop,
    async close() {
      stop();
      await lifecycle.close();
      if (drainFailures.length) throw new AggregateError(drainFailures, 'mod_minion_dispatcher_drain_failed');
    },
    health: () => ({ ...lifecycle.health(), active: running, queued: queue.length }),
  });
}
