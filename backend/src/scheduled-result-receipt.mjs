// Pagination cursors and record IDs are opaque identities, never excerpts.
// Keep the complete producer-bounded page, but not prompts or nested run results.
// Thus advancing nextCursor never skips entries hidden by receipt compaction.
export function scheduledResultReceipt(result = {}) {
  if (!['scheduled_jobs_list', 'scheduled_job_runs'].includes(result.tool)) return null;
  const runs = result.tool === 'scheduled_job_runs';
  const field = runs ? 'runs' : 'jobs';
  const limit = runs ? 200 : 100; // same public page bounds as the producer
  const entries = Array.isArray(result[field]) ? result[field] : [];
  const keys = runs
    ? ['id', 'jobId', 'agentId', 'sessionId', 'runId', 'status', 'ok', 'scheduledFor', 'createdAt', 'dispatchedAt', 'completedAt', 'traceDir']
    : ['id', 'agentId', 'sessionId', 'name', 'enabled', 'jobKind', 'taskId', 'scheduleKind', 'cron', 'runAt', 'nextRunAt', 'lastRunAt', 'contextMode'];
  const values = entries.slice(0, limit).map(item => Object.fromEntries(keys.filter(key => item?.[key] !== undefined).map(key => [key, item[key]])));
  const originalCount = result.pageDelivery?.originalCount ?? result.resultCount ?? entries.length;
  const omittedCount = Math.max(0, originalCount - values.length);
  return {
    [field]: values,
    ...(runs && result.job ? { job: { id: result.job.id, name: result.job.name, agentId: result.job.agentId } } : {}),
    resultCount: result.resultCount ?? originalCount,
    totalCount: result.totalCount,
    hasMore: result.hasMore,
    nextCursor: result.nextCursor ?? null,
    pageDelivery: { originalCount, deliveredCount: values.length, omittedCount, complete: omittedCount === 0,
      detail: 'Summary fields only; scheduled_jobs_read(jobId) retrieves full job details. Run output can be recovered from traceDir when the run has a trace; unfinished/missed runs may have none.',
      ...(omittedCount ? { recovery: 'Do not advance nextCursor: repeat this page with a smaller limit (jobs <=100, runs <=200) and the same request cursor and scope.' } : {}),
    },
  };
}
