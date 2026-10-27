import { operationalEvent, infrastructureErrorCode, operationalId } from './operational-log.mjs';
import { createBackgroundLifecycle } from './background-lifecycle.mjs';

export function publicGeneration(job) {
  return { id: job.id, status: job.status, text: job.text ?? null, error: job.error ?? null,
    createdAt: job.createdAt, updatedAt: job.updatedAt, startedAt: job.startedAt ?? null, completedAt: job.completedAt ?? null };
}

export function createModGenerationDispatcher({ store, generateText, maxConcurrent = 4, logger = console } = {}) {
  if (!store || typeof generateText !== 'function') throw new Error('mod_generation_dispatcher_dependencies_required');
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('mod_generation_concurrency_invalid');
  const lifecycle = createBackgroundLifecycle({ name: 'mod_generation_dispatcher', logger: {
    event(type, fields, options) {
      // Queued interruption only writes a receipt, whose writer owns its
      // diagnostic. Keep the rejection in health without logging it twice.
      if (fields.phase !== 'queued-interrupt') operationalEvent(logger, type, fields, options);
    },
  } });
  const report = (type, job, error) => operationalEvent(logger, type, { jobId: operationalId(job.id), ownerModId: operationalId(job.ownerModId), errorCode: infrastructureErrorCode(error, 'receipt_storage_failed') }, { level: 'error', component: 'mod-generation' });
  function receiptWriter(job) {
    let persistenceReported = false;
    async function complete(patch) {
      try { return await store.complete(job.id, patch); }
      catch (error) {
        // The failed terminal write may be retried by run()'s catch. It is the
        // same receipt operation, not a second incident. Claims log separately.
        if (!persistenceReported) { persistenceReported = true; report('mod_generation_receipt_persistence_failed', job, error); }
        throw error;
      }
    }
    return { complete, interrupt: () => complete({ status: 'interrupted', error: 'service_shutdown' }) };
  }
  const queue = [];
  let active = 0;
  const interrupt = job => receiptWriter(job).interrupt();
  async function run(job) {
    const receipt = receiptWriter(job);
    try {
      if (lifecycle.stopped) { await receipt.interrupt(); return; }
      let claimed;
      try { claimed = await store.markRunning(job.id); } catch (error) { report('mod_generation_receipt_claim_failed', job, error); throw error; }
      if (!claimed) return;
      if (lifecycle.stopped) { await receipt.interrupt(); return; }
      const { text } = await generateText(job.payload, { signal: lifecycle.signal });
      await receipt.complete(lifecycle.stopped ? { status: 'interrupted', error: 'service_shutdown' } : { status: 'succeeded', text: String(text).slice(0, 64_000) });
    } catch (error) {
      try { await receipt.complete({ status: lifecycle.stopped ? 'interrupted' : 'failed', error: lifecycle.stopped ? 'service_shutdown' : (/^[a-z0-9_]+$/.test(String(error?.message || '')) ? error.message : 'mod_model_generation_failed').slice(0, 512) }); }
      catch { /* The receipt writer reported once; startup reconciliation repairs it. */ }
    } finally {
      active -= 1;
      launchQueued();
    }
  }
  function launchQueued() {
    while (!lifecycle.stopped && active < maxConcurrent && queue.length) {
      const job = queue.shift();
      active += 1;
      void lifecycle.track(() => run(job), 'dispatch').catch(() => {});
    }
    if (lifecycle.stopped && queue.length) {
      const abandoned = queue.splice(0);
      for (const job of abandoned) void lifecycle.track(() => interrupt(job), 'queued-interrupt').catch(() => {});
    }
  }
  return Object.freeze({
    async submit(input) {
      if (lifecycle.stopped) throw new Error('mod_generation_dispatcher_stopped');
      // Admission is owned through persistence, including shutdown racing the INSERT.
      const outcome = await lifecycle.track(async () => {
        try {
          const created = await store.create(input);
          if (!created.replayed && created.job.status === 'queued') {
            if (lifecycle.stopped) return { ok: true, value: { job: publicGeneration(await interrupt(created.job) || created.job), replayed: false } };
            queue.push(created.job);
            launchQueued();
          }
          return { ok: true, value: { job: publicGeneration(created.job), replayed: created.replayed } };
        } catch (error) {
          // Caller validation/idempotency failures are ordinary request outcomes,
          // not background-worker failures. Keep them out of lifecycle health.
          return { ok: false, error };
        }
      }, 'admission');
      if (!outcome.ok) throw outcome.error;
      return outcome.value;
    },
    async read(owner, id) { const job = await store.getOwned(owner, id); return job ? publicGeneration(job) : null; },
    stop(reason) { lifecycle.stop(reason); launchQueued(); },
    close(reason) { lifecycle.stop(reason); launchQueued(); return lifecycle.close(reason); },
    health: () => ({ ...lifecycle.health(), active, queued: queue.length, maxConcurrent }), pendingCount: () => lifecycle.health().pending,
  });
}
