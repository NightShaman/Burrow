export function createChatRoutes({ handleChat, readJsonBody, sendJson, selectedAgentRuntime, cancelChatRun } = {}) {
  return async function handleChatRoute({ req, res, url } = {}) {
    if (req.method === 'POST' && url.pathname === '/api/chat') return await handleChat(req, res) || true;
    if (url.pathname.startsWith('/api/chat/') && url.pathname.endsWith('/cancel') && req.method === 'POST') {
      const runId = decodeURIComponent(url.pathname.slice('/api/chat/'.length, -'/cancel'.length));
      const body = await readJsonBody(req);
      sendJson(res, 200, await cancelChatRun(runId, body, await selectedAgentRuntime(body.agentId)));
      return true;
    }
    return false;
  };
}
