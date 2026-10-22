import { createBackgroundLifecycle } from './background-lifecycle.mjs';

export function publicGeneration(job) {
  return { id: job.id, status: job.status, text: job.text ?? null, error: job.error ?? null,
    createdAt: job.createdAt, updatedAt: job.updatedAt, startedAt: job.startedAt ?? null, completedAt: job.completedAt ?? null };
}

export function createModGenerationDispatcher({ store, generateText, maxConcurrent = 4 } = {}) {
  if (!store || typeof generateText !== 'function') throw new Error('mod_generation_dispatcher_dependencies_required');
  if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1) throw new Error('mod_generation_concurrency_invalid');
  const lifecycle = createBackgroundLifecycle({ name: 'mod_generation_dispatcher' });
  const queue = [];
  let active = 0;
  const interrupt = job => store.complete(job.id, { status: 'interrupted', error: 'service_shutdown' });
  async function run(job) {
    try {
      if (lifecycle.stopped) { await interrupt(job); return; }
      if (!(await store.markRunning(job.id))) return;
      if (lifecycle.stopped) { await interrupt(job); return; }
      const { text } = await generateText(job.payload, { signal: lifecycle.signal });
      await store.complete(job.id, lifecycle.stopped ? { status: 'interrupted', error: 'service_shutdown' } : { status: 'succeeded', text: String(text).slice(0, 64_000) });
    } catch (error) {
      try { await store.complete(job.id, { status: lifecycle.stopped ? 'interrupted' : 'failed', error: lifecycle.stopped ? 'service_shutdown' : (/^[a-z0-9_]+$/.test(String(error?.message || '')) ? error.message : 'mod_model_generation_failed').slice(0, 512) }); }
      catch { /* Startup reconciliation interrupts incomplete receipts. */ }
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
