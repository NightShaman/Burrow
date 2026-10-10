export function createChatRoutes({ handleChat, readJsonBody, sendJson, selectedAgentRuntime, cancelChatRun, steerChatRun, listChatSteering } = {}) {
  return async function handleChatRoute({ req, res, url } = {}) {
    if (req.method === 'POST' && url.pathname === '/api/chat') return await handleChat(req, res) || true;
    const steeringRoute = url.pathname.match(/^\/api\/chat\/([^/]+)\/(steer|steering)$/);
    if (steeringRoute && ((req.method === 'POST' && steeringRoute[2] === 'steer') || (req.method === 'GET' && steeringRoute[2] === 'steering'))) {
      const runId = decodeURIComponent(steeringRoute[1]);
      const body = req.method === 'POST' ? await readJsonBody(req) : Object.fromEntries(url.searchParams);
      try {
        const runtime = await selectedAgentRuntime(body.agentId);
        const response = req.method === 'POST' ? await steerChatRun(runId, body, runtime) : await listChatSteering(runId, body, runtime);
        sendJson(res, 200, response);
      } catch (error) { sendJson(res, error.statusCode || 500, { ok: false, error: String(error.message || error) }); }
      return true;
    }
    if (url.pathname.startsWith('/api/chat/') && url.pathname.endsWith('/cancel') && req.method === 'POST') {
      const runId = decodeURIComponent(url.pathname.slice('/api/chat/'.length, -'/cancel'.length));
      const body = await readJsonBody(req);
      sendJson(res, 200, await cancelChatRun(runId, body, await selectedAgentRuntime(body.agentId)));
      return true;
    }
    return false;
  };
}
