import { appendRuntimeSessionTurn } from './runtime-session-writer.mjs';

export async function finalizeBlockedRuntimeResult({
  sessionRoot,
  dataRoot,
  logger,
  command,
  sessionId,
  priorSession = null,
  route = null,
  selectedSkills = [],
  intent = null,
  session = null,
  workbenchStatus = null,
  debug = {},
  backgroundWork = null,
  blockedReason,
  blockers = [],
  content,
  question = null,
  userTurn = null,
  assistantTurn = null,
  memoryStage = null,
  subjectScope = null,
} = {}) {
  if (userTurn?.role && userTurn?.content) {
    await appendRuntimeSessionTurn({
      sessionRoot,
      sessionId,
      role: userTurn.role,
      content: userTurn.content,
      runId: logger?.runId,
      traceDir: logger?.traceDir,
      metadata: { ...(subjectScope ? { subjectScope } : {}), ...(userTurn.metadata || {}) },
    });
  }
  if (assistantTurn?.role && assistantTurn?.content) {
    await appendRuntimeSessionTurn({
      sessionRoot,
      sessionId,
      role: assistantTurn.role,
      content: assistantTurn.content,
      runId: logger?.runId,
      traceDir: logger?.traceDir,
      metadata: { ...(subjectScope ? { subjectScope } : {}), ...(assistantTurn.metadata || {}) },
    });
  }
  return {
    ok: true,
    mode: 'ask',
    command,
    decision: 'blocked',
    runId: logger?.runId,
    dataRoot,
    traceDir: logger?.traceDir,
    selectedSkills,
    intent,
    route,
    sessionId,
    sessionContext: { sessionId: priorSession?.sessionId, priorTurns: priorSession?.turnCount },
    session,
    workbenchStatus,
    chatSupport: null,
    debug,
    backgroundWork,
    blockers,
    blockedReason,
    answerText: content,
    question,
    proposedActions: [],
    proposedActionCount: 0,
    modelUsage: null,
    memoryStage,
    memory: null,
    handoffCandidate: null,
    memoryWrite: { written: false, reason: 'not_applicable' },
  };
}
