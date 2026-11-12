import { scheduledJobSchedulerForStores } from './scheduled-job-scheduler.mjs';

// Scope-bound keysets: jobs use immutable ID; run history stays newest first.
function requestPage(action, scope, runs = false) {
  const limit = Math.max(1, Math.min(runs ? 200 : 100, Math.floor(Number(action.limit) || 50)));
  let after = null;
  if (action.cursor) {
    let decoded;
    try { decoded = JSON.parse(Buffer.from(action.cursor, 'base64url').toString('utf8')); } catch { throw new Error('cursor_invalid'); }
    after = decoded?.after;
    if (decoded?.scope !== scope || (runs
      ? !Array.isArray(after) || after.length !== 3 || after.some(v => typeof v !== 'string' || !v) || !Number.isFinite(Date.parse(after[0])) || !Number.isFinite(Date.parse(after[1]))
      : typeof after !== 'string' || !after)) throw new Error('cursor_invalid');
  }
  return { limit, after };
}
const runKey = item => [item.scheduledFor, item.createdAt, item.id];
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
function compareRun(a, b) {
  return compare(Date.parse(a[0]), Date.parse(b[0])) || compare(Date.parse(a[1]), Date.parse(b[1])) || compare(a[2], b[2]);
}
// Compatibility for third-party/test stores that implement the original API.
// Production PostgreSQL uses bounded keyset queries, never this full-list path.
function legacyPage(items, { limit, after }, field) {
  const runs = field === 'runs';
  const sorted = items.slice().sort((a, b) => runs ? -compareRun(runKey(a), runKey(b)) : compare(a.id, b.id));
  const remaining = sorted.filter(item => !after || (runs ? compareRun(runKey(item), after) < 0 : item.id > after));
  const values = remaining.slice(0, limit);
  const hasMore = remaining.length > limit;
  return { [field]: values, totalCount: sorted.length, hasMore, nextAfter: hasMore ? (runs ? runKey(values.at(-1)) : values.at(-1).id) : null };
}
function receiptPage(result, scope, field) {
  const { nextAfter, ...value } = result;
  return { ...value, resultCount: value[field].length, nextCursor: value.hasMore ? Buffer.from(JSON.stringify({ scope, after: nextAfter })).toString('base64url') : null };
}

async function owned(store, agentId, jobId) {
  const job = await store.getJob(jobId);
  return job && job.ownerModId === null && job.agentId === agentId ? job : null;
}

function input(action, { sessionId, create = false } = {}) {
  const value = {};
  for (const [from, to = from] of [['jobName','name'], ['timezone'], ['contextMode']]) if (action[from] !== null && action[from] !== undefined) value[to] = action[from];
  if (action.jobPrompt !== undefined) value.prompt = action.jobPrompt;
  // Preserve explicit nulls for nullable fields; omitting an update leaves that field unchanged.
  for (const [from, to = from] of [['jobKind'], ['scheduledTaskId', 'taskId'], ['extraInstructions'], ['scheduleKind'], ['cron'], ['runAt']]) if (action[from] !== undefined) value[to] = action[from];
  if (action.scheduledSessionId) value.sessionId = action.scheduledSessionId;
  else if (create) value.sessionId = sessionId || 'default';
  if (action.enabled !== null) value.enabled = action.enabled;
  if (action.modelConnectionId !== undefined) {
    value.modelConnectionId = action.modelConnectionId ?? null;
    value.model = action.model ?? null;
  }
  return value;
}

export async function executeAgentScheduledJobTool({ action, agentId, sessionId, store, rootDir, stores = null, resolveAgentRuntime } = {}) {
  const fail = (error) => ({ tool: action?.tool || 'scheduled_jobs', ok: false, error });
  if (!agentId) return fail('scheduled_job_agent_required');
  if (!store) return fail('scheduled_job_store_required');
  try {
    if (action.tool === 'scheduled_jobs_list') {
      const scope = JSON.stringify(['jobs', agentId, action.enabled ?? null]);
      const options = { agentId, ownerModId: null, enabled: action.enabled ?? null, ...requestPage(action, scope) };
      const result = store.listJobsPage ? await store.listJobsPage(options) : legacyPage(await store.listJobs({ ...options, limit: null }), options, 'jobs');
      return { tool: action.tool, ok: true, ...receiptPage(result, scope, 'jobs') };
    }
    const job = await owned(store, agentId, action.jobId);
    if (!job) return fail('scheduled_job_not_found');
    if (action.tool === 'scheduled_jobs_read') return { tool: action.tool, ok: true, job };
    if (action.tool === 'scheduled_job_runs') {
      const scope = JSON.stringify(['runs', agentId, job.id]);
      const options = requestPage(action, scope, true);
      const result = store.listRunsPage ? await store.listRunsPage(job.id, options) : legacyPage(await store.listRuns(job.id, { limit: null }), options, 'runs');
      return { tool: action.tool, ok: true, job, ...receiptPage(result, scope, 'runs') };
    }
    if (action.tool === 'scheduled_jobs_update') return { tool: action.tool, ok: true, job: await store.updateJob(job.id, input(action, { sessionId })) };
    if (action.tool === 'scheduled_jobs_delete') return { tool: action.tool, ok: true, job: await store.deleteJob(job.id) };
    if (action.tool === 'scheduled_jobs_run_now') {
      // Load runtime composition only for the non-server/manual fallback.
      const scheduler = scheduledJobSchedulerForStores(stores) || (await import('./scheduled-job-runtime.mjs')).createRuntimeScheduledJobScheduler({ storeFactory: () => store, closeStore: async () => {}, resolveAgentRuntime, rootDir, stores });
      return { tool: action.tool, ...(await scheduler.trigger(job.id)) };
    }
    return fail('scheduled_job_tool_unsupported');
  } catch (error) {
    return fail(String(error?.message || error));
  } finally { /* composed store remains open */ }
}

export async function createAgentScheduledJob({ action, agentId, sessionId, store } = {}) {
  if (!store) return { tool: action?.tool || 'scheduled_jobs_create', ok: false, error: 'scheduled_job_store_required' };
  try {
    return { tool: action.tool, ok: true, job: await store.createJob({ ...input(action, { sessionId, create: true }), agentId }, { ownerModId: null }) };
  } catch (error) {
    return { tool: action?.tool || 'scheduled_jobs_create', ok: false, error: String(error?.message || error) };
  } finally { /* composed store remains open */ }
}
