import { createChatTurnRunId, runChatTurnFromBody } from './chat-turn-controller.mjs';

function boundedResult(result = {}) {
  return {
    answerText: String(result.answerText || '').slice(0, 12_000) || null,
    blockers: Array.isArray(result.blockers) ? result.blockers.slice(0, 20) : [],
    verification: result.verification ? { required: Boolean(result.verification.required), ok: result.verification.ok ?? null, reason: result.verification.reason || null } : null,
    completionEvidence: result.completionEvidence || null,
  };
}

export function createScheduledJobScheduler({ storeFactory, resolveAgentRuntime, rootDir, intervalMs = 30_000, clock = () => new Date().toISOString() } = {}) {
  if (typeof storeFactory !== 'function' || typeof resolveAgentRuntime !== 'function') throw new Error('scheduled_job_scheduler_dependencies_required');
  const active = new Map();
  let timer = null;
  let ticking = false;

  async function dispatch(job, run) {
    const controller = new AbortController();
    const runId = createChatTurnRunId({ sessionId: job.sessionId, prefix: 'scheduled' });
    const record = { jobId: job.id, runId: run.id, chatRunId: runId, controller, startedAt: clock() };
    active.set(run.id, record);
    try {
      const agentRuntime = await resolveAgentRuntime(job.agentId);
      const result = await runChatTurnFromBody({
        body: { message: job.prompt, sessionId: job.sessionId, runId, abortSignal: controller.signal },
        rootDir,
        agentRuntime,
        resolveAgentRuntime,
      });
      const store = storeFactory();
      try { store.completeRun(run.id, { runId: result.runId || runId, dispatchedAt: record.startedAt, traceDir: result.traceDir || null, decision: result.decision || null, ok: Boolean(result.ok), error: result.ok ? null : (result.error || null), result: boundedResult(result) }); } finally { store.close(); }
    } catch (error) {
      const store = storeFactory();
      try { store.completeRun(run.id, { runId, dispatchedAt: record.startedAt, status: controller.signal.aborted ? 'cancelled' : 'failed', ok: false, error: String(error?.message || error), result: { answerText: null, blockers: [String(error?.message || error)], verification: null, completionEvidence: null } }); } finally { store.close(); }
    } finally { active.delete(run.id); }
  }

  async function tick() {
    if (ticking) return [];
    ticking = true;
    try {
      const store = storeFactory();
      let claims;
      try { claims = store.claimDueJobs({ at: clock() }); } finally { store.close(); }
      for (const claim of claims) if (claim.run.status === 'running') void dispatch(claim.job, claim.run);
      return claims;
    } finally { ticking = false; }
  }

  async function trigger(jobId) {
    const store = storeFactory();
    let job; let run;
    try {
      job = store.getJob(jobId);
      if (!job) return { ok: false, error: 'scheduled_job_not_found' };
      const activeRun = store.listRuns(job.id, { limit: 1 }).find((item) => item.status === 'running');
      if (activeRun) return { ok: false, error: 'scheduled_job_already_running', job, run: activeRun };
      run = store.createManualRun(job.id, { at: clock() });
    } finally { store.close(); }
    void dispatch(job, run);
    return { ok: true, job, run };
  }

  function cancel(runId, reason) {
    const record = active.get(runId);
    if (!record) return false;
    record.controller.abort(reason || 'cancelled by operator');
    return true;
  }
  function start() { if (!timer) { timer = setInterval(() => { void tick(); }, intervalMs); timer.unref?.(); } return tick(); }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { start, stop, tick, trigger, cancel, activeRuns: () => [...active.values()].map(({ controller, ...record }) => ({ ...record, cancelled: controller.signal.aborted })) };
}
