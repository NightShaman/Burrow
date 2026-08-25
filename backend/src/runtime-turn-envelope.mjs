import { createCanonicalTurnEnvelope, createRuntimeTurnContract } from './chat-runtime-contracts.mjs';

export async function buildRuntimeTurnEnvelope({ logger, resolvedSessionId, conversationId, message, command, resolvedWorkingRoot, resolvedTarget, attachments, session, intent, routeDecision, turnPlan, turnContext, ambientWorkingContext, agentContextConfig = {}, route, executionPolicy, subagents, structuredSubagents, extraEyesReview, resolvedRunId, childEvidence, plannerObservability, priorSession, deicticFiles, trackedBackgroundWork, runtimeHeapStage } = {}) {
  const canonicalTurnEnvelope = createCanonicalTurnEnvelope({
    sessionId: resolvedSessionId,
    conversationId,
    message,
    input: { command, workspaceRoot: resolvedWorkingRoot || null, target: resolvedTarget || null, attachments },
    route: { kind: session.kind, action: session.actionRoute || null, intent: intent?.intent || null },
    routeDecision,
    planner: turnPlan,
    context: {
      rawRecentTurnCount: turnContext?.stats?.rawRecentTurnCount ?? turnContext?.rawRecentTurnCount ?? null,
      priorSummaryTurnCount: turnContext?.stats?.priorSummaryTurnCount ?? turnContext?.priorSummaryTurnCount ?? null,
      support: { selectedSkills: route.promptPlan.promptSkills.map((skill) => skill.id) },
    },
    executionPolicy,
    support: { memory: turnPlan.support?.memory || null, skills: route.skills?.snapshot || { selected: route.promptPlan.selectedSkills.map((skill) => ({ id: skill.id })) }, workspace: turnPlan.support?.workspace || null, workingContext: ambientWorkingContext, uiTarget: agentContextConfig.uiTarget || null, subagents, structuredSubagents, extraEyesReview },
    trace: { runId: resolvedRunId, sessionId: resolvedSessionId },
  });
  const runtimeTurn = createRuntimeTurnContract({ envelope: canonicalTurnEnvelope });
  await runtimeHeapStage?.(logger, 'after-canonical-turn-envelope', { canonicalTurnEnvelope, runtimeTurn, subagents, childEvidence });
  const routerPayload = { stage: 'ask-chat-turn', route, intent, turnPlan, plannerObservability, routeDecision, runtimeTurn, canonicalTurnEnvelope, subagents, structuredSubagents, priorSession: { sessionId: priorSession.sessionId, turnCount: priorSession.turnCount }, fileDeicticResolution: deicticFiles, workingContext: ambientWorkingContext, backgroundWork: trackedBackgroundWork };
  await runtimeHeapStage?.(logger, 'before-router-serialization', { routerPayload, canonicalTurnEnvelope, runtimeTurn });
  await logger.router(routerPayload);
  await runtimeHeapStage?.(logger, 'after-router-serialization', { routerPayload, canonicalTurnEnvelope, runtimeTurn });
  return { canonicalTurnEnvelope, runtimeTurn, routerPayload };
}
