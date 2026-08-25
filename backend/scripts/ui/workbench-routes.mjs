// Legacy Workbench compatibility routes. Keep this surface isolated until retirement is explicitly approved.
export function createWorkbenchRoutes({
  readJsonBody,
  sendJson,
  selectedAgentRuntime,
  dataRootForAgent,
  listWorkItemSummaries,
  createWorkbenchItem,
  readWorkItem,
  runWorkbenchItemStep,
  continueWorkbenchItem,
  archiveWorkbenchItem,
  workbenchPlan,
  workbenchRun,
} = {}) {
  return async function handleWorkbenchRoute({ req, res, url } = {}) {
    if (req.method === 'GET' && url.pathname === '/api/tasks') {
      const agentRuntime = await selectedAgentRuntime(url.searchParams.get('agentId'));
      sendJson(res, 200, { ok: true, items: await listWorkItemSummaries(agentRuntime) });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/tasks') {
      const body = await readJsonBody(req);
      const agentRuntime = await selectedAgentRuntime(body.agentId);
      sendJson(res, 200, await createWorkbenchItem(body, agentRuntime));
      return true;
    }
    if (url.pathname.startsWith('/api/tasks/')) {
      const parts = url.pathname.slice('/api/tasks/'.length).split('/').map(decodeURIComponent);
      const id = parts[0];
      const action = parts[1] || null;
      const body = req.method === 'POST' ? await readJsonBody(req) : null;
      const agentRuntime = await selectedAgentRuntime(body?.agentId || url.searchParams.get('agentId'));
      const dataRoot = await dataRootForAgent(agentRuntime);
      if (req.method === 'GET' && !action) {
        const item = await readWorkItem({ dataRoot, id });
        sendJson(res, item ? 200 : 404, item ? { ok: true, item } : { ok: false, error: 'work_item_not_found' });
        return true;
      }
      if (req.method === 'POST' && action === 'step') {
        sendJson(res, 200, await runWorkbenchItemStep(id, body, agentRuntime));
        return true;
      }
      if (req.method === 'POST' && action === 'continue') {
        sendJson(res, 200, await continueWorkbenchItem(id, body, agentRuntime));
        return true;
      }
      if (req.method === 'POST' && action === 'archive') {
        sendJson(res, 200, await archiveWorkbenchItem(id, agentRuntime));
        return true;
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/workbench') {
      const body = await readJsonBody(req);
      sendJson(res, 200, await workbenchPlan(body, await selectedAgentRuntime(body.agentId)));
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/workbench/run') {
      const body = await readJsonBody(req);
      sendJson(res, 200, await workbenchRun(body, await selectedAgentRuntime(body.agentId)));
      return true;
    }
    return false;
  };
}
