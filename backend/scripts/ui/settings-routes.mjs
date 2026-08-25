export function createSettingsRoutes({ readJsonBody, sendJson, modelConnections, claudeCliCredentialStatus, importClaudeCliCredential, startOpenAiOAuthLoginApi, openAiOAuthLoginStatus, submitOpenAiOAuthLoginApi, cancelOpenAiOAuthLoginApi, startClaudeCodeLoginApi, claudeCodeLoginStatus, submitClaudeCodeLoginApi, cancelClaudeCodeLoginApi, importClaudeCodeLoginApi, mcpConnections, discoverMcpConnection, diagnoseMcpConnection, saveMcpConnection, removeMcpConnection, agentMcpTools, saveAgentMcpTools, agentModelSelection, saveAgentModelSelection, archiveSummaryModelSelection, saveArchiveSummaryModelSelection, discoverModelConnection, saveModelConnection, removeModelConnection, setupStatus, completeSetup } = {}) {
  const resultResponse = (res, result, success = 200) => {
    sendJson(res, result.ok ? success : (result.status || 500), result);
    return true;
  };
  return async function handleSettingsRoute({ req, res, url } = {}) {
    if (req.method === 'GET' && url.pathname === '/api/setup/status') { sendJson(res, 200, await setupStatus()); return true; }
    if (req.method === 'POST' && url.pathname === '/api/setup/complete') return resultResponse(res, await completeSetup(await readJsonBody(req)));
    if (req.method === 'GET' && url.pathname === '/api/settings/model-connections') { sendJson(res, 200, await modelConnections()); return true; }
    if (req.method === 'GET' && url.pathname === '/api/settings/model-connections/claude-cli-credential') { sendJson(res, 200, await claudeCliCredentialStatus()); return true; }
    if (req.method === 'POST' && url.pathname === '/api/settings/model-connections/import-claude-cli-credential') { return resultResponse(res, await importClaudeCliCredential(await readJsonBody(req))); }
    if (req.method === 'POST' && url.pathname === '/api/settings/model-connections/openai-oauth/start') { return resultResponse(res, await startOpenAiOAuthLoginApi(await readJsonBody(req))); }
    if (url.pathname.startsWith('/api/settings/model-connections/openai-oauth/')) {
      const rest = url.pathname.slice('/api/settings/model-connections/openai-oauth/'.length).split('/').map(decodeURIComponent);
      const id = rest[0]; const action = rest[1] || '';
      if (req.method === 'GET' && !action) { sendJson(res, 200, openAiOAuthLoginStatus(id)); return true; }
      if (req.method === 'POST' && action === 'submit-code') return resultResponse(res, await submitOpenAiOAuthLoginApi(id, await readJsonBody(req)));
      if (req.method === 'POST' && action === 'cancel') return resultResponse(res, await cancelOpenAiOAuthLoginApi(id));
    }
    if (req.method === 'POST' && url.pathname === '/api/settings/model-connections/claude-code-login/start') return resultResponse(res, await startClaudeCodeLoginApi(await readJsonBody(req)));
    if (url.pathname.startsWith('/api/settings/model-connections/claude-code-login/')) {
      const rest = url.pathname.slice('/api/settings/model-connections/claude-code-login/'.length).split('/').map(decodeURIComponent);
      const id = rest[0]; const action = rest[1] || '';
      if (req.method === 'GET' && !action) { sendJson(res, 200, claudeCodeLoginStatus(id)); return true; }
      if (req.method === 'POST' && action === 'submit-code') return resultResponse(res, submitClaudeCodeLoginApi(id, await readJsonBody(req)));
      if (req.method === 'POST' && action === 'cancel') return resultResponse(res, await cancelClaudeCodeLoginApi(id));
      if (req.method === 'POST' && action === 'import') return resultResponse(res, await importClaudeCodeLoginApi(id, await readJsonBody(req)));
    }
    if (req.method === 'GET' && url.pathname === '/api/settings/mcp-connections') { sendJson(res, 200, await mcpConnections()); return true; }
    if (req.method === 'POST' && url.pathname === '/api/settings/mcp-connections/discover') return resultResponse(res, await discoverMcpConnection(await readJsonBody(req)));
    if (req.method === 'POST' && url.pathname === '/api/settings/mcp-connections/diagnose') return resultResponse(res, await diagnoseMcpConnection(await readJsonBody(req)));
    if (req.method === 'POST' && url.pathname === '/api/settings/mcp-connections') return resultResponse(res, await saveMcpConnection(await readJsonBody(req)));
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/settings/mcp-connections/')) { const id = decodeURIComponent(url.pathname.slice('/api/settings/mcp-connections/'.length)); sendJson(res, 200, { ok: removeMcpConnection(id) }); return true; }
    if (url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/mcp-tools')) {
      const agentId = decodeURIComponent(url.pathname.slice('/api/agents/'.length, -'/mcp-tools'.length));
      if (req.method === 'GET') return resultResponse(res, await agentMcpTools(agentId));
      if (req.method === 'PUT') return resultResponse(res, await saveAgentMcpTools(agentId, await readJsonBody(req)));
    }
    if (url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/archive-summary-model-selection')) {
      const agentId = decodeURIComponent(url.pathname.slice('/api/agents/'.length, -'/archive-summary-model-selection'.length));
      if (req.method === 'GET') { sendJson(res, 200, await archiveSummaryModelSelection(agentId)); return true; }
      if (req.method === 'PUT') return resultResponse(res, await saveArchiveSummaryModelSelection(agentId, await readJsonBody(req)));
    }
    if (url.pathname.startsWith('/api/agents/') && url.pathname.endsWith('/model-selection')) {
      const agentId = decodeURIComponent(url.pathname.slice('/api/agents/'.length, -'/model-selection'.length));
      if (req.method === 'GET') { sendJson(res, 200, await agentModelSelection(agentId)); return true; }
      if (req.method === 'PUT') return resultResponse(res, await saveAgentModelSelection(agentId, await readJsonBody(req)));
    }
    if (req.method === 'POST' && url.pathname === '/api/settings/model-connections/discover') return resultResponse(res, await discoverModelConnection(await readJsonBody(req)));
    if (req.method === 'POST' && url.pathname === '/api/settings/model-connections') return resultResponse(res, await saveModelConnection(await readJsonBody(req)));
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/settings/model-connections/')) { const id = decodeURIComponent(url.pathname.slice('/api/settings/model-connections/'.length)); sendJson(res, 200, { ok: removeModelConnection(id) }); return true; }
    return false;
  };
}
