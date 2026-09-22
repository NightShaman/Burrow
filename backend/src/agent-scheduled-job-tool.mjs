import { ScheduledJobStore } from './scheduled-job-store.mjs';
import { createScheduledJobScheduler } from './scheduled-job-scheduler.mjs';

function owned(store, agentId, jobId) {
  const job = store.getJob(jobId);
  return job && job.ownerModId === null && job.agentId === agentId ? job : null;
}

function input(action, { sessionId, create = false } = {}) {
  const value = {};
  for (const [from, to = from] of [['jobName','name'], ['jobPrompt','prompt'], ['cron'], ['timezone']]) if (action[from] !== null && action[from] !== undefined) value[to] = action[from];
  if (action.scheduledSessionId) value.sessionId = action.scheduledSessionId;
  else if (create) value.sessionId = sessionId || 'default';
  if (action.enabled !== null) value.enabled = action.enabled;
  if (action.modelConnectionId !== undefined) {
    value.modelConnectionId = action.modelConnectionId ?? null;
    value.model = action.model ?? null;
  }
  return value;
}

export async function executeAgentScheduledJobTool({ action, agentId, sessionId, databasePath, rootDir, resolveAgentRuntime } = {}) {
  const fail = (error) => ({ tool: action?.tool || 'scheduled_jobs', ok: false, error });
  if (!agentId) return fail('scheduled_job_agent_required');
  if (!databasePath) return fail('scheduled_job_database_required');
  const store = new ScheduledJobStore({ databasePath });
  try {
    if (action.tool === 'scheduled_jobs_list') return { tool: action.tool, ok: true, jobs: store.listJobs({ agentId, ownerModId: null, enabled: action.enabled, limit: action.limit || 50 }) };
    const job = owned(store, agentId, action.jobId);
    if (!job) return fail('scheduled_job_not_found');
    if (action.tool === 'scheduled_jobs_read') return { tool: action.tool, ok: true, job };
    if (action.tool === 'scheduled_job_runs') return { tool: action.tool, ok: true, job, runs: store.listRuns(job.id, { limit: action.limit || 50 }) };
    if (action.tool === 'scheduled_jobs_update') return { tool: action.tool, ok: true, job: store.updateJob(job.id, input(action, { sessionId })) };
    if (action.tool === 'scheduled_jobs_delete') return { tool: action.tool, ok: true, job: store.deleteJob(job.id) };
    if (action.tool === 'scheduled_jobs_run_now') {
      store.close();
      const scheduler = createScheduledJobScheduler({ storeFactory: () => new ScheduledJobStore({ databasePath }), resolveAgentRuntime, rootDir });
      return { tool: action.tool, ...(await scheduler.trigger(job.id)) };
    }
    return fail('scheduled_job_tool_unsupported');
  } catch (error) {
    return fail(String(error?.message || error));
  } finally {
    try { store.close(); } catch {}
  }
}

export function createAgentScheduledJob({ action, agentId, sessionId, databasePath } = {}) {
  const store = new ScheduledJobStore({ databasePath });
  try {
    return { tool: action.tool, ok: true, job: store.createJob({ ...input(action, { sessionId, create: true }), agentId }, { ownerModId: null }) };
  } catch (error) {
    return { tool: action?.tool || 'scheduled_jobs_create', ok: false, error: String(error?.message || error) };
  } finally { store.close(); }
}
