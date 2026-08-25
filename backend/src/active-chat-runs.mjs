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
  };
}

export function activeChatRunSummaries(activeChatRuns, { agentId = null, sessionId = null } = {}) {
  return [...activeChatRuns.values()]
    .filter((record) => !agentId || record.agentId === agentId)
    .filter((record) => !sessionId || record.sessionId === sessionId)
    .map(activeChatRunSummary);
}

export function registerActiveAgentRun(activeChatRuns, { agentId, sessionId = 'default', runId, message = '', source = 'internal' } = {}) {
  if (!agentId || !runId) throw new Error('active_agent_run_identity_required');
  const controller = new AbortController();
  const record = {
    agentId: String(agentId), runId: String(runId), sessionId: String(sessionId || 'default'), controller,
    startedAt: new Date().toISOString(), phase: 'thinking', latestUserMessage: String(message || '').slice(0, 16_000),
    progress: [], contextUsage: null, cancelled: false, reason: null, detached: true, source,
  };
  const key = activeChatRunKey(record.agentId, record.runId);
  activeChatRuns.set(key, record);
  return {
    record,
    signal: controller.signal,
    onTraceRecord(traceRecord) {
      if (traceRecord?.stream === 'model' || traceRecord?.type === 'model') record.phase = 'streaming';
    },
    onModelTextDelta() { record.phase = 'streaming'; },
    onModelThoughtDelta() { record.phase = 'streaming'; },
    onModelContextUsage(usage) { if (usage && typeof usage === 'object') record.contextUsage = usage; },
    finish() { if (activeChatRuns.get(key) === record) activeChatRuns.delete(key); },
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
