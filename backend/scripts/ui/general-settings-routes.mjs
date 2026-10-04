import { normalizeRetentionPolicy } from '../../src/retention-settings.mjs';
export function createGeneralSettingsRoutes({ readJsonBody, sendJson, chatIdentities, saveChatIdentity, curatorSettings, saveCuratorSettings, tiddleSettings, tiddleCards, tiddleHistory, uiAuthSettings, saveUiAuthSettings, executionBoundarySettings, saveExecutionBoundarySettings, retentionPolicySettings, saveRetentionPolicySettings, retentionCleanup } = {}) {
  const resultResponse = (res, result, success = 200) => {
    sendJson(res, result.ok === false ? (result.status || 500) : success, result);
    return true;
  };
  return async function handleGeneralSettingsRoute({ req, res, url } = {}) {
    if (url.pathname === '/api/settings/identities') {
      if (req.method === 'GET') { sendJson(res, 200, await chatIdentities()); return true; }
      if (req.method === 'PUT') return resultResponse(res, await saveChatIdentity(await readJsonBody(req)));
    }
    if (url.pathname === '/api/settings/curator') {
      if (req.method === 'GET') { sendJson(res, 200, await curatorSettings()); return true; }
      if (req.method === 'PUT') return resultResponse(res, await saveCuratorSettings(await readJsonBody(req)));
    }
    if (req.method === 'GET' && url.pathname === '/api/settings/tiddle') {
      sendJson(res, 200, await tiddleSettings(url.searchParams.get('agentId')));
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/tiddle/cards') {
      sendJson(res, 200, await tiddleCards({ agentId: url.searchParams.get('agentId'), scope: url.searchParams.get('scope'), limit: url.searchParams.get('limit') }));
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/tiddle/history') {
      sendJson(res, 200, await tiddleHistory({ agentId: url.searchParams.get('agentId'), cardId: url.searchParams.get('cardId'), since: url.searchParams.get('since'), limit: url.searchParams.get('limit') }));
      return true;
    }
    if (url.pathname === '/api/settings/ui-auth') {
      if (req.method === 'GET') { sendJson(res, 200, await uiAuthSettings()); return true; }
      if (req.method === 'PUT') return resultResponse(res, await saveUiAuthSettings(await readJsonBody(req)));
    }
    if (url.pathname === '/api/settings/execution-boundaries') {
      if (req.method === 'GET') { sendJson(res, 200, await executionBoundarySettings()); return true; }
      if (req.method === 'PUT') return resultResponse(res, await saveExecutionBoundarySettings(await readJsonBody(req)));
    }
    if (url.pathname === '/api/settings/retention') {
      if (req.method === 'GET') { sendJson(res, 200, await retentionPolicySettings()); return true; }
      if (req.method === 'PUT') return resultResponse(res, await saveRetentionPolicySettings(await readJsonBody(req)));
    }
    if (req.method === 'POST' && ['/api/settings/retention/preview', '/api/settings/retention/run'].includes(url.pathname)) {
      const body = await readJsonBody(req);
      const saved = await retentionPolicySettings();
      let policy;
      try { policy = normalizeRetentionPolicy(body.policy, saved.policy); }
      catch (error) { return resultResponse(res, { ok: false, status: 400, error: error.message }); }
      if (!body.policy || JSON.stringify(policy) !== JSON.stringify(normalizeRetentionPolicy(saved.policy))) {
        return resultResponse(res, { ok: false, status: 409, error: 'retention_policy_changed', policy: saved.policy });
      }
      return resultResponse(res, await retentionCleanup({ confirm: url.pathname.endsWith('/run'), requireEnabled: false, policy }));
    }
    // Compatibility aliases for existing callers. New clients use /api/settings/retention/*.
    if (req.method === 'GET' && url.pathname === '/api/retention') { sendJson(res, 200, await retentionPolicySettings()); return true; }
    if (req.method === 'POST' && url.pathname === '/api/retention/cleanup') return resultResponse(res, await retentionCleanup(await readJsonBody(req)));
    return false;
  };
}
