import { createBackgroundLifecycle } from './background-lifecycle.mjs';
import { classifyRuntimeOutcome } from './runtime-outcome.mjs';

const applicationSchedulers = new WeakMap();
export function scheduledJobSchedulerForStores(stores) { return stores ? applicationSchedulers.get(stores) || null : null; }

function boundedResult(result = {}) {
  return {
    answerText: String(result.answerText || '').slice(0, 12_000) || null,
    blockers: Array.isArray(result.blockers) ? result.blockers.slice(0, 20) : [],
    verification: result.verification ? { required: Boolean(result.verification.required), ok: result.verification.ok ?? null, reason: result.verification.reason || null } : null,
    completionEvidence: result.completionEvidence || null,
  };
}

export function createScheduledJobScheduler({ storeFactory, closeStore: closeStoreOverride, resolveAgentRuntime, rootDir, stores = null, executeTurn, createRunId, telemetry = null, intervalMs = 30_000, retryDelayMs = intervalMs, activeOwnerModIds = () => [], clock = () => new Date().toISOString() } = {}) {
  if (typeof storeFactory !== 'function' || typeof resolveAgentRuntime !== 'function' || typeof executeTurn !== 'function' || typeof createRunId !== 'function') throw new Error('scheduled_job_scheduler_dependencies_required');
  const lifecycle = createBackgroundLifecycle({ name: 'scheduled_job_scheduler', clock });
  const active = new Map();
  const availableOwners = () => { const owners = activeOwnerModIds(); return Array.isArray(owners) ? owners : []; };
  const ownerAvailable = (job) => !job.ownerModId || availableOwners().includes(job.ownerModId);
  const openStore = () => Promise.resolve(storeFactory());
  const closeStore = async (store) => { if (typeof closeStoreOverride === 'function') return closeStoreOverride(store); await store.close(); };
  let timer = null;
  let ticking = false;
  let retryAt = 0;
  let failureCount = 0;
  let lastFailure = null;
  function reportFailure(error, phase, run = null) {
    failureCount += 1;
    lastFailure = { at: clock(), phase, runId: run?.id || null, error: String(error?.message || error).slice(0, 2000) };
    console.error('scheduled_job_scheduler_failure', JSON.stringify(lastFailure));
  }
  function launch(job, run) {
    void lifecycle.track(() => dispatch(job, run), 'dispatch').catch(error => reportFailure(error, 'failure_persistence', run));
  }
  function timerTick() {
    if (Date.now() < retryAt) return;
    void tick().then(() => { retryAt = 0; }, error => {
      retryAt = Date.now() + Math.max(1, retryDelayMs);
      reportFailure(error, 'tick');
    });
  }

  async function dispatch(job, run) {
    const controller = new AbortController();
    const runId = createRunId({ sessionId: job.sessionId, prefix: 'scheduled' });
    const record = { jobId: job.id, runId: run.id, chatRunId: runId, controller, startedAt: clock() };
    active.set(run.id, record);
    try {
      if (lifecycle.stopped) controller.abort(lifecycle.signal.reason);
      controller.signal.throwIfAborted();
      if (!ownerAvailable(job)) throw new Error('scheduled_job_owner_inactive');
      const validationStore = await openStore();
      try { await validationStore.validateModel(job); } finally { await closeStore(validationStore); }
      if (lifecycle.stopped) controller.abort(lifecycle.signal.reason);
      controller.signal.throwIfAborted();
      if (!ownerAvailable(job)) throw new Error('scheduled_job_owner_inactive');
      const agentRuntime = await resolveAgentRuntime(job.agentId);
      if (lifecycle.stopped) controller.abort(lifecycle.signal.reason);
      controller.signal.throwIfAborted();
      if (!ownerAvailable(job)) throw new Error('scheduled_job_owner_inactive');
      const result = await executeTurn({
        body: { message: job.prompt, sessionId: job.sessionId, runId, abortSignal: controller.signal, ...(job.modelConnectionId ? { modelConnectionId: job.modelConnectionId, model: job.model } : {}) },
        rootDir,
        stores,
        agentRuntime,
        resolveAgentRuntime,
        turnSource: 'scheduled',
        telemetry,
        runSource: 'scheduled',
      });
      const outcome = classifyRuntimeOutcome(result, { cancelled: controller.signal.aborted });
      const store = await openStore();
      try { await store.completeRun(run.id, { ...outcome, runId: result.runId || runId, dispatchedAt: record.startedAt, traceDir: result.traceDir || null, decision: result.decision || null, error: outcome.ok ? null : (result.error || result.blockedReason || result.decision || outcome.status), result: boundedResult(result) }); } finally { await closeStore(store); }
    } catch (error) {
      reportFailure(error, 'dispatch', run);
      const store = await openStore();
      try { await store.completeRun(run.id, { runId, dispatchedAt: record.startedAt, status: controller.signal.aborted ? 'cancelled' : 'failed', ok: false, error: String(error?.message || error), result: { answerText: null, blockers: [String(error?.message || error)], verification: null, completionEvidence: null } }); } finally { await closeStore(store); }
    } finally { active.delete(run.id); }
  }

  function tick() { return lifecycle.stopped ? Promise.resolve([]) : lifecycle.track(runTick); }
  async function runTick() {
    if (ticking || lifecycle.stopped) return [];
    ticking = true;
    try {
      const store = await openStore();
      let claims;
      try { if (lifecycle.stopped) return []; claims = await store.claimDueJobs({ at: clock(), activeOwnerModIds: availableOwners() }); } finally { await closeStore(store); }
      for (const claim of claims) if (claim.run.status === 'running') launch(claim.job, claim.run);
      return claims;
    } finally { ticking = false; }
  }

  function trigger(jobId, options = {}) {
    if (lifecycle.stopped) return Promise.resolve({ ok: false, error: 'scheduled_job_scheduler_stopped' });
    return lifecycle.track(() => runTrigger(jobId, options), 'trigger');
  }
  async function runTrigger(jobId, { ownerModId = undefined } = {}) {
    const store = await openStore();
    let job; let run;
    try {
      job = ownerModId === undefined ? await store.getJob(jobId) : await store.getOwnedJob(ownerModId, jobId);
      if (!job) return { ok: false, error: 'scheduled_job_not_found' };
      if (!ownerAvailable(job)) return { ok: false, error: 'scheduled_job_owner_inactive' };
      if (lifecycle.stopped) return { ok: false, error: 'scheduled_job_scheduler_stopped' };
      run = await store.createManualRun(job.id, { at: clock() });
      if (!run) return { ok: false, error: 'scheduled_job_not_found' };
      if (run.overlap) return { ok: false, error: 'scheduled_job_already_running', job, run };
    } finally { await closeStore(store); }
    launch(job, run);
    return { ok: true, job, run };
  }

  function cancel(runId, reason) {
    const record = active.get(runId);
    if (!record) return false;
    record.controller.abort(reason || 'cancelled by operator');
    return true;
  }
  function start() { if (lifecycle.stopped) return Promise.resolve([]); if (!timer) { timer = setInterval(timerTick, intervalMs); timer.unref?.(); } return tick(); }
  function stop() {
    lifecycle.stop();
    if (timer) clearInterval(timer); timer = null;
    for (const record of active.values()) record.controller.abort(lifecycle.signal.reason);
  }
  function close() { stop(); return lifecycle.close(); }
  const scheduler = { start, stop, close, tick, trigger, cancel, health: () => ({ stopped: lifecycle.stopped, pending: lifecycle.health().pending, failureCount, lastFailure: lastFailure && { ...lastFailure }, retryAt }), activeRuns: () => [...active.values()].map(({ controller, ...record }) => ({ ...record, cancelled: controller.signal.aborted })) };
  if (stores) applicationSchedulers.set(stores, scheduler);
  return scheduler;
}
