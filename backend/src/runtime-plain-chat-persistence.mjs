import { finalizePlainChatRuntimeResult } from './runtime-plain-chat-finalizer.mjs';

export async function persistPlainChatResult({ stores = null, agentId = 'hatchet', sessionRoot, dataRoot, logger, command, message, sessionId, priorSession, route, selectedSkills, prompt, contextEngine, contextCompression, intent, session, workspaceRoot, artifactWorkspaceRoot, subjectScope, backgroundWork, modelTurn, turnPlan, plannerObservability, routeDecision, canonicalTurnEnvelope, runtimeTurn, subagents, structuredSubagents, extraEyesReview, fileDeicticResolution, finalWorkingContext, commitTerminalResult } = {}) {
  return commitTerminalResult({
    branch: 'plain_model',
    workingContext: finalWorkingContext,
    finalize: async () => {
      return finalizePlainChatRuntimeResult({ stores, agentId, sessionRoot, dataRoot, logger, command, message, sessionId, priorSession, route, selectedSkills, prompt, contextEngine, contextCompression, intent, session, workspaceRoot, artifactWorkspaceRoot, subjectScope, backgroundWork, modelTurn, turnPlan, plannerObservability, routeDecision, canonicalTurnEnvelope, runtimeTurn, subagents, structuredSubagents, extraEyesReview, fileDeicticResolution });
    },
  });
}
