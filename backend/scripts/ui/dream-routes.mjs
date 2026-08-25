export function createDreamRoutes({ readJsonBody, sendJson, agentDreamSettings, agentDreamDiary, agentDreamMemoryConsolidate, agentDreamCycle } = {}) {
  return async function handleDreamRoute({ req, res, url } = {}) {
    if (url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/dream-settings')) {
      const agentId = decodeURIComponent(url.pathname.slice('/api/agents/'.length, -'/dream-settings'.length));
      if (req.method === 'GET') { const result = await agentDreamSettings(agentId); sendJson(res, result.ok ? 200 : (result.status || 500), result); return true; }
      if (req.method === 'PUT') { const result = await agentDreamSettings(agentId, await readJsonBody(req)); sendJson(res, result.ok ? 200 : (result.status || 500), result); return true; }
    }
    if (url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/dream-diary')) {
      const agentId = decodeURIComponent(url.pathname.slice('/api/agents/'.length, -'/dream-diary'.length));
      if (req.method === 'GET') { const result = await agentDreamDiary(agentId, null, Object.fromEntries(url.searchParams.entries())); sendJson(res, result.ok ? 200 : (result.status || 500), result); return true; }
      if (req.method === 'POST') { const result = await agentDreamDiary(agentId, await readJsonBody(req)); sendJson(res, result.ok ? 201 : (result.status || 500), result); return true; }
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/dream-memory/consolidate')) {
      const agentId = decodeURIComponent(url.pathname.slice('/api/agents/'.length, -'/dream-memory/consolidate'.length));
      const result = await agentDreamMemoryConsolidate(agentId, await readJsonBody(req));
      sendJson(res, result.ok ? 200 : (result.status || 500), result);
      return true;
    }
    if (url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/dream-cycle')) {
      const agentId = decodeURIComponent(url.pathname.slice('/api/agents/'.length, -'/dream-cycle'.length));
      const result = req.method === 'GET'
        ? await agentDreamCycle(agentId, null, Object.fromEntries(url.searchParams.entries()))
        : req.method === 'POST' ? await agentDreamCycle(agentId, await readJsonBody(req)) : null;
      if (result) { sendJson(res, result.ok ? 200 : (result.status || 500), result); return true; }
    }
    return false;
  };
}
