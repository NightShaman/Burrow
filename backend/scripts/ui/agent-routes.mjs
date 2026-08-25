export function createAgentRoutes({ readJsonBody, sendJson, validateBoundaryBody, agentsStore, createAgent, updateAgent, deleteAgent, agentProfileDocuments, selectedAgentRuntime, agentStatusForSession } = {}) {
  const resultResponse = (res, result, success = 200) => {
    sendJson(res, result.ok ? success : (result.status || 500), result);
    return true;
  };
  return async function handleAgentRoute({ req, res, url } = {}) {
    if (req.method === 'GET' && url.pathname === '/api/agents') {
      sendJson(res, 200, { ok: true, agents: agentsStore().list({ includeDisabled: url.searchParams.get('includeDisabled') !== 'false' }) });
      return true;
    }
    if (req.method === 'POST' && url.pathname === '/api/agents') return resultResponse(res, await createAgent(validateBoundaryBody('agent-create', await readJsonBody(req))), 201);
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/agents/') && !url.pathname.endsWith('/mcp-tools') && !url.pathname.endsWith('/model-selection')) {
      const id = decodeURIComponent(url.pathname.slice('/api/agents/'.length));
      return resultResponse(res, await updateAgent(id, validateBoundaryBody('agent-patch', await readJsonBody(req))));
    }
    if (url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/profile-documents')) {
      const agentId = decodeURIComponent(url.pathname.slice('/api/agents/'.length, -'/profile-documents'.length));
      if (req.method === 'GET') return resultResponse(res, await agentProfileDocuments(agentId));
      if (req.method === 'PUT') return resultResponse(res, await agentProfileDocuments(agentId, await readJsonBody(req)));
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/agents/') && !url.pathname.endsWith('/mcp-tools') && !url.pathname.endsWith('/model-selection')) {
      const id = decodeURIComponent(url.pathname.slice('/api/agents/'.length));
      return resultResponse(res, await deleteAgent(id));
    }
    if (req.method === 'GET' && url.pathname === '/api/agent-status') {
      const agentRuntime = await selectedAgentRuntime(url.searchParams.get('agentId'));
      sendJson(res, 200, { ok: true, ...(await agentStatusForSession(url.searchParams.get('sessionId') || 'default', agentRuntime)) });
      return true;
    }
    return false;
  };
}
