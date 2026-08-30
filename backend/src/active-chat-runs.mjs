export function activeChatRunKey(agentId, runId) {
  return `${String(agentId)}:${String(runId)}`;
}

export function activeChatRunSummary(record = {}) {
  return {
    runId: record.runId,
    agentId: record.agentId,
    sessionId: record.sessionId,
    status: record.controller?.signal?.aborted ? 'cancelled' : 'running',
    phase: record.phase || 'thinking',
    startedAt: record.startedAt || null,
    latestUserMessage: record.latestUserMessage || null,
    progress: Array.isArray(record.progress) ? record.progress.slice(-50) : [],
    contextUsage: record.contextUsage || null,
    detached: record.detached === true,
    source: record.source || null,
    a2a: record.a2a || null,
    a2aActivities: Array.isArray(record.a2aActivities) ? record.a2aActivities.slice(-12) : [],
  };
}

export function activeChatRunSummaries(activeChatRuns, { agentId = null, sessionId = null } = {}) {
  return [...activeChatRuns.values()]
    .filter((record) => !agentId || record.agentId === agentId)
    .filter((record) => !sessionId || record.sessionId === sessionId)
    .map(activeChatRunSummary);
}

export function registerActiveAgentRun(activeChatRuns, { agentId, sessionId = 'default', runId, message = '', source = 'internal', a2a = null } = {}) {
  if (!agentId || !runId) throw new Error('active_agent_run_identity_required');
  const controller = new AbortController();
  const record = {
    agentId: String(agentId), runId: String(runId), sessionId: String(sessionId || 'default'), controller,
    startedAt: new Date().toISOString(), phase: 'thinking', latestUserMessage: String(message || '').slice(0, 16_000),
    progress: [], contextUsage: null, cancelled: false, reason: null, detached: true, source, a2a, a2aActivities: [],
  };
  const key = activeChatRunKey(record.agentId, record.runId);
  activeChatRuns.set(key, record);
  const parent = a2a?.parentAgentId && a2a?.parentRunId ? activeChatRuns.get(activeChatRunKey(a2a.parentAgentId, a2a.parentRunId)) : null;
  const activity = parent ? { id: `a2a:${record.agentId}:${record.runId}`, status: 'running', startedAt: record.startedAt, updatedAt: record.startedAt, recipient: { agentId: record.agentId, sessionId: record.sessionId, runId: record.runId }, messageMode: a2a.messageMode || 'request_reply', progress: [] } : null;
  if (parent && activity) parent.a2aActivities = [...(parent.a2aActivities || []), activity].slice(-12);
  const updateActivity = (patch = {}) => {
    if (!parent || !activity) return;
    Object.assign(activity, patch, { updatedAt: new Date().toISOString() });
  };
  return {
    record,
    signal: controller.signal,
    onTraceRecord(traceRecord) {
      if (traceRecord?.stream === 'model' || traceRecord?.type === 'model') record.phase = 'streaming';
      const payload = traceRecord?.payload || {};
      const progress = traceRecord?.publicProgress || (traceRecord?.type === 'tool'
        ? { type: payload.phase === 'start' ? 'tool.started' : 'tool.completed', data: { tool: payload.tool || null, activityId: payload.activityId || null, ok: payload.ok ?? null, status: payload.status || null, label: payload.tool || 'Tool activity' } }
        : traceRecord?.type === 'model' && payload.stage === 'model-request' ? { type: 'model.started', data: { provider: payload.provider || null, model: payload.model || null } }
          : traceRecord?.type === 'model' && payload.stage === 'model-response' ? { type: 'model.completed', data: { ok: payload.ok === true, status: payload.status || null } } : null);
      if (progress) {
        const event = { ...progress, runId: record.runId, sessionId: record.sessionId, ts: traceRecord?.ts || new Date().toISOString() };
        record.progress = [...record.progress, event].slice(-50);
        updateActivity({ progress: [...(activity?.progress || []), event].slice(-50) });
      }
    },
    onModelTextDelta() { record.phase = 'streaming'; updateActivity({ status: 'streaming' }); },
    onModelThoughtDelta() { record.phase = 'streaming'; },
    onModelContextUsage(usage) { if (usage && typeof usage === 'object') record.contextUsage = usage; },
    finish() { updateActivity({ status: record.controller.signal.aborted ? 'cancelled' : 'replied', completedAt: new Date().toISOString() }); if (activeChatRuns.get(key) === record) activeChatRuns.delete(key); },
  };
}

export function cancelActiveChatRun(activeChatRuns, runId, { body = {}, agentId = null } = {}) {
  const requestedAgentId = agentId || body.agentId || null;
  let record = requestedAgentId ? activeChatRuns.get(activeChatRunKey(requestedAgentId, runId)) : null;
  if (!record) {
    const matches = [...activeChatRuns.values()].filter((run) => run.runId === runId && !run.controller?.signal?.aborted);
    if (matches.length === 1) record = matches[0];
    else if (matches.length > 1) return { ok: false, error: 'chat_run_ambiguous', runId, matches: matches.map(activeChatRunSummary) };
  }
  if (!record) return { ok: false, error: 'chat_run_not_found', runId, agentId: requestedAgentId };
  const reason = String(body.reason || 'stopped from UI');
  record.cancelled = true;
  record.reason = reason;
  record.controller.abort(new Error(reason));
  return { ok: true, runId, agentId: record.agentId, sessionId: record.sessionId, status: 'cancelled', reason };
}
