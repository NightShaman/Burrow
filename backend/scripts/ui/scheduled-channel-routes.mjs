export function createScheduledChannelRoutes({ readJsonBody, sendJson, validateBoundaryBody, withScheduledJobs, scheduler, listGroupChannels, createGroupChannel, readGroupChannelTurns, groupChannelRuns, startGroupChannelMessage, cancelGroupChannelRun, runtimeDataRoot } = {}) {
  return async function handleScheduledChannelRoute({ req, res, url } = {}) {
    if (req.method === 'GET' && url.pathname === '/api/scheduled-jobs') { sendJson(res, 200, await withScheduledJobs((store) => ({ ok: true, jobs: store.listJobs({ agentId: url.searchParams.get('agentId'), enabled: url.searchParams.has('enabled') ? url.searchParams.get('enabled') === 'true' : null }), activeRuns: scheduler().activeRuns() }))); return true; }
    if (req.method === 'POST' && url.pathname === '/api/scheduled-jobs') { const body = validateBoundaryBody('scheduled-job-create', await readJsonBody(req)); sendJson(res, 201, await withScheduledJobs((store) => ({ ok: true, job: store.createJob(body) }))); return true; }
    if (url.pathname.startsWith('/api/scheduled-jobs/')) {
      const parts = url.pathname.slice('/api/scheduled-jobs/'.length).split('/').map(decodeURIComponent); const jobId = parts[0]; const action = parts[1] || null;
      if (req.method === 'GET' && !action) { const job = await withScheduledJobs((store) => store.getJob(jobId)); sendJson(res, job ? 200 : 404, job ? { ok: true, job } : { ok: false, error: 'scheduled_job_not_found' }); return true; }
      if (req.method === 'PATCH' && !action) { const body = await readJsonBody(req); const job = await withScheduledJobs((store) => store.updateJob(jobId, body)); sendJson(res, job ? 200 : 404, job ? { ok: true, job } : { ok: false, error: 'scheduled_job_not_found' }); return true; }
      if (req.method === 'DELETE' && !action) { const job = await withScheduledJobs((store) => store.deleteJob(jobId)); sendJson(res, job ? 200 : 404, job ? { ok: true, job } : { ok: false, error: 'scheduled_job_not_found' }); return true; }
      if (req.method === 'GET' && action === 'runs') { sendJson(res, 200, await withScheduledJobs((store) => ({ ok: true, runs: store.listRuns(jobId, { limit: url.searchParams.get('limit') }) }))); return true; }
      if (req.method === 'POST' && action === 'trigger') { sendJson(res, 202, await scheduler().trigger(jobId)); return true; }
      if (req.method === 'POST' && action === 'runs' && parts[3] === 'cancel') { const body = await readJsonBody(req); const runId = parts[2]; const cancelled = scheduler().cancel(runId, body.reason); if (!cancelled) { sendJson(res, 404, { ok: false, error: 'scheduled_job_run_not_active' }); return true; } sendJson(res, 200, { ok: true, runId, status: 'cancelling' }); return true; }
    }
    if (url.pathname === '/api/group-channels') {
      if (req.method === 'GET') { sendJson(res, 200, { ok: true, channels: await listGroupChannels({ rootDir: await runtimeDataRoot() }) }); return true; }
      if (req.method === 'POST') { const body = await readJsonBody(req); const channel = await createGroupChannel({ rootDir: await runtimeDataRoot(), name: validateBoundaryBody('group-create', body).name, participantAgentIds: body.participantAgentIds }); sendJson(res, 201, { ok: true, channel }); return true; }
    }
    if (url.pathname.startsWith('/api/group-channels/')) {
      const parts = url.pathname.slice('/api/group-channels/'.length).split('/').map(decodeURIComponent); const channelId = parts[0]; const action = parts[1] || null; const rootDir = await runtimeDataRoot();
      if (req.method === 'GET' && !action) { const detail = await readGroupChannelTurns({ rootDir, channelId, limit: 500 }); if (!detail) { sendJson(res, 404, { ok: false, error: 'group_channel_not_found' }); return true; } const runs = [...groupChannelRuns.values()].filter((run) => run.channelId === channelId).map(({ controller, ...run }) => ({ ...run, cancelled: controller.signal.aborted || run.cancelled })); sendJson(res, 200, { ok: true, ...detail, runs }); return true; }
      if (req.method === 'POST' && action === 'messages') { sendJson(res, 202, await startGroupChannelMessage(channelId, validateBoundaryBody('group-message', await readJsonBody(req)))); return true; }
      if (req.method === 'POST' && action === 'runs' && parts[3] === 'cancel') { sendJson(res, 200, await cancelGroupChannelRun(channelId, parts[2], await readJsonBody(req))); return true; }
    }
    return false;
  };
}
