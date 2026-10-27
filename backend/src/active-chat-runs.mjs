export function activeChatRunKey(agentId, runId) {
  return `${String(agentId)}:${String(runId)}`;
}

export function activeChatRunSummary(record = {}) {
  const cancelling = record.controller?.signal?.aborted === true;
  return {
    runId: record.runId,
    agentId: record.agentId,
    sessionId: record.sessionId,
    lane: record.lane || 'main',
    ...(record.inputId ? { inputId: record.inputId } : {}),
    // Records remain registered until their execution promise settles. An
    // aborted registered record is therefore still draining, not terminal.
    status: cancelling ? 'cancelling' : 'running',
    phase: cancelling ? 'cancelling' : (record.phase || 'thinking'),
    startedAt: record.startedAt || null,
    latestUserMessage: record.latestUserMessage || null,
    answerText: record.answerText || null,
    progress: Array.isArray(record.progress) ? record.progress.slice(-50) : [],
    contextUsage: record.contextUsage || null,
    detached: record.detached === true,
    steeringReady: !cancelling && record.steeringReady === true,
    source: record.source || null,
    ...(record.completionEvent ? { completionEvent: record.completionEvent, latestUserMessageMetadata: { source: 'workflow-event', completionEvent: record.completionEvent } } : {}),
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

export function registerActiveAgentRun(activeChatRuns, { agentId, sessionId = 'default', runId, message = '', objective = null, source = 'internal', a2a = null, completionEvent = null, lane = 'main', inputId = null, parentSignal = null } = {}) {
  if (!agentId || !runId) throw new Error('active_agent_run_identity_required');
  if (activeChatRuns.has(activeChatRunKey(agentId, runId))) throw Object.assign(new Error('chat_run_id_already_used'), { statusCode: 409 });
  const controller = new AbortController();
  const record = {
    agentId: String(agentId), runId: String(runId), sessionId: String(sessionId || 'default'), controller,
    startedAt: new Date().toISOString(), phase: 'thinking', latestUserMessage: String(message || '').slice(0, 16_000),
    objective: objective == null ? null : String(objective).slice(0, 16_000),
    progress: [], contextUsage: null, cancelled: false, reason: null, detached: true, steeringReady: false, lane, inputId, source, a2a, completionEvent, a2aActivities: [],
  };
  const key = activeChatRunKey(record.agentId, record.runId);
  activeChatRuns.set(key, record);
  const parent = a2a?.parentAgentId && a2a?.parentRunId ? activeChatRuns.get(activeChatRunKey(a2a.parentAgentId, a2a.parentRunId)) : null;
  // The explicit dependency survives removal of the parent from the active map.
  const inheritedSignal = parentSignal || a2a?.parentSignal || parent?.controller?.signal;
  const abortFromParent = () => {
    record.cancelled = true;
    record.reason = String(inheritedSignal.reason?.message || inheritedSignal.reason || 'parent cancelled');
    controller.abort(inheritedSignal.reason);
  };
  if (inheritedSignal?.aborted) abortFromParent();
  else inheritedSignal?.addEventListener('abort', abortFromParent, { once: true });
  const activity = parent ? { id: `a2a:${record.agentId}:${record.runId}`, status: controller.signal.aborted ? 'cancelled' : 'running', startedAt: record.startedAt, updatedAt: record.startedAt, recipient: { agentId: record.agentId, sessionId: record.sessionId, runId: record.runId }, messageMode: a2a.messageMode || 'request_reply', progress: [] } : null;
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
    onModelTextDelta(input) {
      const { delta, modelCall } = typeof input === 'string' ? {delta:input,modelCall:0} : input || {};
      if (record.answerModelCall !== modelCall) { record.answerModelCall = modelCall; record.answerText = ''; }
      record.answerText = (record.answerText || '') + String(delta || '');
      record.phase = 'streaming'; updateActivity({ status: 'streaming' });
    },
    onModelThoughtDelta() { record.phase = 'streaming'; },
    onModelContextUsage(usage) { if (usage && typeof usage === 'object') record.contextUsage = usage; },
    onSteeringReady() { record.steeringReady = true; },
    finish() { inheritedSignal?.removeEventListener('abort', abortFromParent); updateActivity({ status: record.controller.signal.aborted ? 'cancelled' : 'replied', completedAt: new Date().toISOString() }); if (activeChatRuns.get(key) === record) activeChatRuns.delete(key); },
  };
}

export function cancelActiveChatRun(activeChatRuns, runId, { body = {}, agentId = null } = {}) {
  const requestedAgentId = agentId || body.agentId || null;
  let record = requestedAgentId ? activeChatRuns.get(activeChatRunKey(requestedAgentId, runId)) : null;
  // Legacy run-only lookup is allowed only when no agent was requested.
  if (!requestedAgentId) {
    const matches = [...activeChatRuns.values()].filter((run) => run.runId === runId && !run.controller?.signal?.aborted);
    if (matches.length === 1) record = matches[0];
    else if (matches.length > 1) return { ok: false, error: 'chat_run_ambiguous', runId, matches: matches.map(activeChatRunSummary) };
  }
  if (!record) return { ok: false, error: 'chat_run_not_found', runId, agentId: requestedAgentId };
  const reason = String(body.reason || 'stopped from UI');
  const cancelledRuns = [];
  const cancelTree = (candidate) => {
    if (!candidate || candidate.controller?.signal?.aborted) return;
    candidate.cancelled = true;
    candidate.reason = reason;
    candidate.phase = 'cancelling';
    candidate.steeringReady = false;
    cancelledRuns.push({ runId: candidate.runId, agentId: candidate.agentId, sessionId: candidate.sessionId });
    for (const child of activeChatRuns.values()) {
      if (child.a2a?.parentAgentId === candidate.agentId && child.a2a?.parentRunId === candidate.runId) cancelTree(child);
    }
    candidate.cancelledAt ||= new Date().toISOString();
    candidate.controller.abort(new Error(reason));
  };
  cancelTree(record);
  return { ok: true, runId, agentId: record.agentId, sessionId: record.sessionId, status: 'cancelling', reason, cancelledRuns };
}
