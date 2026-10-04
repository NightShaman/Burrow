import { createChatTurnRunId, runChatTurnFromBody } from './chat-turn-controller.mjs';

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

export function createScheduledJobScheduler({ storeFactory, closeStore: closeStoreOverride, resolveAgentRuntime, rootDir, stores = null, executeTurn = runChatTurnFromBody, intervalMs = 30_000, retryDelayMs = intervalMs, activeOwnerModIds = () => [], clock = () => new Date().toISOString() } = {}) {
  if (typeof storeFactory !== 'function' || typeof resolveAgentRuntime !== 'function') throw new Error('scheduled_job_scheduler_dependencies_required');
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
    void dispatch(job, run).catch(error => reportFailure(error, 'failure_persistence', run));
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
    const runId = createChatTurnRunId({ sessionId: job.sessionId, prefix: 'scheduled' });
    const record = { jobId: job.id, runId: run.id, chatRunId: runId, controller, startedAt: clock() };
    active.set(run.id, record);
    try {
      if (!ownerAvailable(job)) throw new Error('scheduled_job_owner_inactive');
      const validationStore = await openStore();
      try { await validationStore.validateModel(job); } finally { await closeStore(validationStore); }
      if (!ownerAvailable(job)) throw new Error('scheduled_job_owner_inactive');
      const agentRuntime = await resolveAgentRuntime(job.agentId);
      if (!ownerAvailable(job)) throw new Error('scheduled_job_owner_inactive');
      const result = await executeTurn({
        body: { message: job.prompt, sessionId: job.sessionId, runId, abortSignal: controller.signal, ...(job.modelConnectionId ? { modelConnectionId: job.modelConnectionId, model: job.model } : {}) },
        rootDir,
        stores,
        agentRuntime,
        resolveAgentRuntime,
        turnSource: 'scheduled',
      });
      const store = await openStore();
      try { await store.completeRun(run.id, { runId: result.runId || runId, dispatchedAt: record.startedAt, traceDir: result.traceDir || null, decision: result.decision || null, ok: Boolean(result.ok), error: result.ok ? null : (result.error || null), result: boundedResult(result) }); } finally { await closeStore(store); }
    } catch (error) {
      reportFailure(error, 'dispatch', run);
      const store = await openStore();
      try { await store.completeRun(run.id, { runId, dispatchedAt: record.startedAt, status: controller.signal.aborted ? 'cancelled' : 'failed', ok: false, error: String(error?.message || error), result: { answerText: null, blockers: [String(error?.message || error)], verification: null, completionEvidence: null } }); } finally { await closeStore(store); }
    } finally { active.delete(run.id); }
  }

  async function tick() {
    if (ticking) return [];
    ticking = true;
    try {
      const store = await openStore();
      let claims;
      try { claims = await store.claimDueJobs({ at: clock(), activeOwnerModIds: availableOwners() }); } finally { await closeStore(store); }
      for (const claim of claims) if (claim.run.status === 'running') launch(claim.job, claim.run);
      return claims;
    } finally { ticking = false; }
  }

  async function trigger(jobId, { ownerModId = undefined } = {}) {
    const store = await openStore();
    let job; let run;
    try {
      job = ownerModId === undefined ? await store.getJob(jobId) : await store.getOwnedJob(ownerModId, jobId);
      if (!job) return { ok: false, error: 'scheduled_job_not_found' };
      if (!ownerAvailable(job)) return { ok: false, error: 'scheduled_job_owner_inactive' };
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
  function start() { if (!timer) { timer = setInterval(timerTick, intervalMs); timer.unref?.(); } return tick(); }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  const scheduler = { start, stop, tick, trigger, cancel, health: () => ({ failureCount, lastFailure: lastFailure && { ...lastFailure }, retryAt }), activeRuns: () => [...active.values()].map(({ controller, ...record }) => ({ ...record, cancelled: controller.signal.aborted })) };
  if (stores) applicationSchedulers.set(stores, scheduler);
  return scheduler;
}
