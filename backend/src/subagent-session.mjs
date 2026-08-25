import { appendSessionEntry, readSessionMetadata, writeSessionMetadata } from './session-store.mjs';

function compact(value, fallback = '') {
  return String(value ?? fallback).trim();
}

export function subagentChildSessionId(id) {
  return `subagent-${compact(id, 'worker')}`.replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 140);
}

export async function startSubagentChildSession({ dataRoot, id, workerProfile, purpose, owner = {}, trace = {}, model = null } = {}) {
  if (!dataRoot || !id) return null;
  const sessionId = subagentChildSessionId(id);
  const parentSessionId = compact(owner.sessionId, 'default');
  const parentConversationId = compact(owner.conversationId) || null;
  const parentRunId = compact(owner.parentRunId || owner.turnId || trace.runId);
  await writeSessionMetadata({
    rootDir: dataRoot,
    sessionId,
    extra: {
      sessionKind: 'subagent',
      workerProfile: compact(workerProfile),
      subagentId: compact(id),
      parentSessionId,
      parentConversationId,
      parentRunId: parentRunId || null,
      parentChild: true,
      model: model || null,
    },
  });
  await appendSessionEntry({
    rootDir: dataRoot,
    sessionId,
    type: 'message',
    role: 'user',
    content: purpose || `Run ${workerProfile || 'subagent'}`,
    runId: trace.runId || null,
    parentId: parentRunId || null,
    metadata: { workerProfile, subagentId: id, parentSessionId, parentConversationId, parentRunId: parentRunId || null },
  });
  await appendSessionEntry({
    rootDir: dataRoot,
    sessionId,
    type: 'event',
    content: `${workerProfile || 'Subagent'} started.`,
    runId: trace.runId || null,
    parentId: parentRunId || null,
    metadata: { kind: 'subagent-start', workerProfile, subagentId: id, parentSessionId, parentConversationId },
  });
  await writeSessionMetadata({ rootDir: dataRoot, sessionId, extra: { sessionKind: 'subagent', parentSessionId, parentConversationId, parentRunId: parentRunId || null, parentChild: true, subagentId: id, workerProfile } });
  return sessionId;
}

export async function finishSubagentChildSession({ dataRoot, sessionId, id, workerProfile, owner = {}, result = {}, trace = {}, status = null, model = null } = {}) {
  if (!dataRoot || !sessionId) return null;
  const summary = compact(result.summary, `${workerProfile || 'Subagent'} finished.`);
  await appendSessionEntry({
    rootDir: dataRoot,
    sessionId,
    type: 'message',
    role: 'assistant',
    content: summary,
    runId: trace.runId || null,
    metadata: { kind: 'subagent-result', workerProfile, subagentId: id, status, ok: Boolean(result.ok) },
  });
  const details = {
    status,
    ok: Boolean(result.ok),
    evidence: Array.isArray(result.evidence) ? result.evidence.length : 0,
    changedFiles: Array.isArray(result.changedFiles) ? result.changedFiles : [],
    blockers: Array.isArray(result.blockers) ? result.blockers : [],
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
  };
  await appendSessionEntry({
    rootDir: dataRoot,
    sessionId,
    type: 'event',
    content: JSON.stringify(details),
    runId: trace.runId || null,
    metadata: { kind: 'subagent-receipt', workerProfile, subagentId: id },
  });
  const existing = await readSessionMetadata({ rootDir: dataRoot, sessionId }) || {};
  await writeSessionMetadata({ rootDir: dataRoot, sessionId, extra: {
    sessionKind: existing.sessionKind || 'subagent',
    parentSessionId: existing.parentSessionId || compact(owner.sessionId, 'default'),
    parentConversationId: existing.parentConversationId || compact(owner.conversationId) || null,
    parentRunId: existing.parentRunId || compact(owner.parentRunId || owner.turnId || trace.runId) || null,
    parentChild: true,
    subagentStatus: status,
    subagentOk: Boolean(result.ok),
    subagentId: id,
    workerProfile: existing.workerProfile || workerProfile,
    model: model || existing.model || null,
  } });
  return sessionId;
}
