export function createSessionRoutes({
  rootDir: projectRoot,
  readJsonBody,
  sendJson,
  resolveAgentRuntime,
  runtimeAgentWorkspaceRoot,
  runtimeDataRoot,
  runtimeSessionRoot,
  runtimeConfig,
  activeConversationLimits,
  inspectSessionContext,
  inspectSessionContextStatus,
  activeChatRuns,
  searchSessionEvidence,
  searchBurrowSessionEvidence,
  agentsStore,
  agentRuntimeContext,
  archiveSessions,
  archiveSessionDetail,
  archiveRuns,
  archiveRunDetail,
  archiveDreams,
  archiveDreamDetail,
  archiveContinuityCards,
  archiveContinuityCardDetail,
  listSessions,
  sessionDetail,
  exportSessionTranscript,
  writeSessionMetadata,
  resetSession,
  renameSession,
  archiveSession,
  forkSession,
  sessionWriteHandoff,
  sessionContinuityScope,
  setSessionContinuityScope,
  clearSessionContinuityScope,
  sessionReadHandoff,
  sessionWriteHandoffCandidate,
  archiveSummaryForReset,
  archiveSummaryForSession,
  latestAuthorityExplanationForSession,
  listAuthorityExplanationsForSession,
} = {}) {
  const resultResponse = (res, result, success = 200) => {
    sendJson(res, result.ok === false ? (result.status || 500) : success, result);
    return true;
  };
  return async function handleSessionRoute({ req, res, url } = {}) {
    if (req.method === 'GET' && url.pathname === '/api/session/context') {
      const sessionId = url.searchParams.get('sessionId') || 'default';
      const agentRuntime = await resolveAgentRuntime(url.searchParams.get('agentId'));
      const runtime = await runtimeConfig(agentRuntime.agentId);
      const limits = activeConversationLimits({ modelConfig: runtime.modelConfig, contextConfig: runtime.contextConfig });
      sendJson(res, 200, { ok: true, context: await inspectSessionContext({ rootDir: projectRoot, dataRoot: agentRuntime.agentWorkspaceRoot, sessionId, limits, contextWindow: runtime.modelConfig?.contextWindow, contextTokens: runtime.modelConfig?.contextTokens }) });
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/session/context-status') {
      const sessionId = url.searchParams.get('sessionId') || 'default';
      const agentRuntime = await resolveAgentRuntime(url.searchParams.get('agentId'));
      const runtime = await runtimeConfig(agentRuntime.agentId);
      const active = [...activeChatRuns.values()].find((run) => run.agentId === agentRuntime.agentId && run.sessionId === sessionId && !run.controller.signal.aborted) || null;
      const limits = activeConversationLimits({ modelConfig: runtime.modelConfig, contextConfig: runtime.contextConfig });
      sendJson(res, 200, { ok: true, status: await inspectSessionContextStatus({ rootDir: projectRoot, dataRoot: agentRuntime.agentWorkspaceRoot, sessionId, limits, contextConfig: runtime.contextConfig, contextWindow: runtime.modelConfig?.contextWindow, contextTokens: runtime.modelConfig?.contextTokens, liveContext: active?.contextUsage || null }) });
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/session/search') {
      const query = url.searchParams.get('q') || '';
      const role = url.searchParams.get('role') || 'any';
      const limit = url.searchParams.get('limit') || 50;
      const sourceId = url.searchParams.get('sourceId') || null;
      const since = url.searchParams.get('since') || null;
      const until = url.searchParams.get('until') || null;
      const agentId = url.searchParams.get('agentId');
      const sessionId = url.searchParams.get('sessionId');
      const scope = url.searchParams.get('scope') || (agentId || sessionId || sourceId ? 'session' : 'burrow');
      if (scope === 'session') {
        const agentRuntime = await resolveAgentRuntime(agentId);
        sendJson(res, 200, await searchSessionEvidence({ rootDir: agentRuntime.agentWorkspaceRoot, sessionId: sessionId || 'default', query, role, sourceId, since, until, limit }));
        return true;
      }
      const runtime = await runtimeConfig();
      const agents = agentsStore().list({ includeDisabled: false }).map((agent) => {
        const context = agentRuntimeContext({ runtimeState: runtime.runtimeState, agent });
        return { agentId: agent.id, agentName: agent.name, rootDir: context.agentWorkspaceRoot, dataRoot: context.agentDataRoot };
      });
      sendJson(res, 200, await searchBurrowSessionEvidence({ agents, query, role, since, until, limit, includeArchived: url.searchParams.get('archived') !== 'false' }));
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/context') {
      const sessionId = url.searchParams.get('sessionId') || 'default';
      const agentRuntime = await resolveAgentRuntime(url.searchParams.get('agentId'));
      const runtime = await runtimeConfig(agentRuntime.agentId);
      const limits = activeConversationLimits({ modelConfig: runtime.modelConfig, contextConfig: runtime.contextConfig });
      sendJson(res, 200, { ok: true, context: await inspectSessionContext({ rootDir: projectRoot, dataRoot: agentRuntime.agentWorkspaceRoot, sessionId, limits, contextWindow: runtime.modelConfig?.contextWindow, contextTokens: runtime.modelConfig?.contextTokens }) });
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/archive/dreams') {
      sendJson(res, 200, await archiveDreams({ agentId: url.searchParams.get('agentId'), date: url.searchParams.get('date'), phase: url.searchParams.get('phase'), limit: url.searchParams.get('limit') || 200 }));
      return true;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/archive/dreams/')) {
      const parts = url.pathname.slice('/api/archive/dreams/'.length).split('/').map(decodeURIComponent);
      const [agentId, entryId] = parts;
      if (!agentId || !entryId) { sendJson(res, 400, { ok: false, error: 'archive_dream_target_required' }); return true; }
      const result = await archiveDreamDetail(agentId, entryId);
      sendJson(res, result.ok ? 200 : (result.status || 500), result);
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/archive/continuity/cards') {
      sendJson(res, 200, await archiveContinuityCards({ agentId: url.searchParams.get('agentId'), scope: url.searchParams.get('scope'), limit: url.searchParams.get('limit') || 200 }));
      return true;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/archive/continuity/cards/')) {
      const parts = url.pathname.slice('/api/archive/continuity/cards/'.length).split('/').map(decodeURIComponent);
      const [agentId, cardId] = parts;
      if (!agentId || !cardId) { sendJson(res, 400, { ok: false, error: 'archive_continuity_card_target_required' }); return true; }
      const result = await archiveContinuityCardDetail({ agentId, cardId, limit: url.searchParams.get('limit') || 200 });
      sendJson(res, result.ok ? 200 : (result.status || 500), result);
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/archive/runs') {
      const agentRuntime = await resolveAgentRuntime(url.searchParams.get('agentId'));
      const result = await archiveRuns({ agentRuntime, sessionId: url.searchParams.get('sessionId'), limit: url.searchParams.get('limit') || 100 });
      sendJson(res, 200, { ok: true, runs: result });
      return true;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/archive/runs/')) {
      const runId = decodeURIComponent(url.pathname.slice('/api/archive/runs/'.length));
      if (!runId) { sendJson(res, 400, { ok: false, error: 'archive_run_target_required' }); return true; }
      const agentRuntime = await resolveAgentRuntime(url.searchParams.get('agentId'));
      const run = await archiveRunDetail({ agentRuntime, runId });
      sendJson(res, run ? 200 : 404, run ? { ok: true, run } : { ok: false, error: 'archive_run_not_found' });
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/archive/sessions') {
      sendJson(res, 200, { ok: true, sessions: await archiveSessions({ includeArchived: url.searchParams.get('archived') !== 'false', query: url.searchParams.get('q') || '', limit: url.searchParams.get('limit') || 200 }) });
      return true;
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/archive/sessions/')) {
      const parts = url.pathname.slice('/api/archive/sessions/'.length).split('/').map(decodeURIComponent);
      const [agentId, sessionId] = parts;
      if (!agentId || !sessionId) { sendJson(res, 400, { ok: false, error: 'archive_session_target_required' }); return true; }
      const detail = await archiveSessionDetail(agentId, sessionId);
      sendJson(res, detail ? 200 : 404, detail ? { ok: true, ...detail } : { ok: false, error: 'not_found' });
      return true;
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      const agentId = url.searchParams.get('agentId');
      const options = { includeArchived: url.searchParams.get('archived') === 'true', query: url.searchParams.get('q') || '', updatedSince: url.searchParams.get('updatedSince'), limit: url.searchParams.get('limit') || 100 };
      if (agentId) {
        const agent = await resolveAgentRuntime(agentId);
        await writeSessionMetadata({ rootDir: agent.agentWorkspaceRoot, sessionId: 'default' });
        sendJson(res, 200, { ok: true, sessions: await listSessions({ rootDir: agent.agentWorkspaceRoot, agentId: agent.agentId, ...options }) });
        return true;
      }
      const agents = agentsStore().list({ includeDisabled: false });
      const sessions = (await Promise.all(agents.map(async (agent) => {
        const runtime = await resolveAgentRuntime(agent.id);
        return listSessions({ rootDir: runtime.agentWorkspaceRoot, agentId: runtime.agentId, ...options });
      }))).flat().sort((left, right) => String(right.updatedAt || '').localeCompare(String(left.updatedAt || ''))).slice(0, Number(options.limit) || 100);
      sendJson(res, 200, { ok: true, sessions });
      return true;
    }
    if (url.pathname.startsWith('/api/sessions/')) {
      const parts = url.pathname.slice('/api/sessions/'.length).split('/').map(decodeURIComponent);
      const sessionId = parts[0]; const action = parts[1] || null; const agentId = url.searchParams.get('agentId');
      const rootDir = await runtimeSessionRoot(sessionId, agentId);
      if (req.method === 'GET' && action === 'authority' && parts[2] === 'latest') { sendJson(res, 200, { ok: true, ...(await latestAuthorityExplanationForSession({ rootDir, sessionId })) }); return true; }
      if (req.method === 'GET' && action === 'authority' && !parts[2]) { sendJson(res, 200, { ok: true, ...(await listAuthorityExplanationsForSession({ rootDir, sessionId, limit: url.searchParams.get('limit') || 20 })) }); return true; }
      if (req.method === 'GET' && action === 'export' && !parts[2]) {
        const exported = await exportSessionTranscript({ rootDir, sessionId });
        sendJson(res, exported ? 200 : 404, exported ? { ok: true, ...exported } : { ok: false, error: 'not_found' });
        return true;
      }
      if (req.method === 'GET' && !action) { const session = await sessionDetail(sessionId, { rootDir }); sendJson(res, session ? 200 : 404, session ? { ok: true, session } : { ok: false, error: 'not_found' }); return true; }
      if (req.method === 'POST' && action === 'reset') { const agentRuntime = await resolveAgentRuntime(agentId); await sessionWriteHandoff({ agentId: agentRuntime.agentId, sessionId, title: `Boundary checkpoint before session reset: ${sessionId}`, runId: `session-reset-${Date.now()}`, message: `Preserve the useful state from session ${sessionId} before resetting it.` }); const result = await resetSession({ rootDir: agentRuntime.agentWorkspaceRoot, sessionId }); await archiveSummaryForReset?.({ agentId: agentRuntime.agentId, rootDir: agentRuntime.agentWorkspaceRoot, archivedPath: result.archivedPath }); sendJson(res, 200, result); return true; }
      if (req.method === 'POST' && action === 'rename') { const body = await readJsonBody(req); sendJson(res, 200, await renameSession({ rootDir, sessionId, targetSessionId: body.targetSessionId })); return true; }
      if (req.method === 'POST' && action === 'archive') { const body = await readJsonBody(req); const result = await archiveSession({ rootDir, sessionId, archived: body.archived !== false }); if (result.archived) await archiveSummaryForSession?.({ agentId: agentId || (await resolveAgentRuntime()).agentId, rootDir, sessionId }); sendJson(res, 200, result); return true; }
      if (req.method === 'POST' && action === 'unarchive') { sendJson(res, 200, await archiveSession({ rootDir, sessionId, archived: false })); return true; }
      if (req.method === 'POST' && action === 'fork') { const body = await readJsonBody(req); sendJson(res, 200, await forkSession({ rootDir, sourceSessionId: sessionId, targetSessionId: body.targetSessionId || `${sessionId}-fork` })); return true; }
    }
    if (req.method === 'GET' && url.pathname === '/api/session/continuity-scope') { sendJson(res, 200, await sessionContinuityScope(Object.fromEntries(url.searchParams))); return true; }
    if (req.method === 'PUT' && url.pathname === '/api/session/continuity-scope') return resultResponse(res, await setSessionContinuityScope(await readJsonBody(req)));
    if (req.method === 'DELETE' && url.pathname === '/api/session/continuity-scope') { sendJson(res, 200, await clearSessionContinuityScope(Object.fromEntries(url.searchParams))); return true; }
    if (req.method === 'GET' && url.pathname === '/api/session/handoff') { sendJson(res, 200, await sessionReadHandoff(Object.fromEntries(url.searchParams))); return true; }
    if (req.method === 'POST' && url.pathname === '/api/session/handoff') { sendJson(res, 200, await sessionWriteHandoff(await readJsonBody(req))); return true; }
    if (req.method === 'POST' && url.pathname === '/api/session/handoff-candidate') { sendJson(res, 200, await sessionWriteHandoffCandidate(await readJsonBody(req))); return true; }
    return false;
  };
}
