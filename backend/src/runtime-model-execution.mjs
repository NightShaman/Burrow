import { runRuntimeTurn } from './runtime-orchestrator.mjs';
import { isSessionContinuityCurrent, readSessionContinuityHead } from './session-store.mjs';
import { applyWorkingContextEvents, verifiedEventsFromToolResults } from './working-context.mjs';
import { compactAskChatResult } from './runtime-result-assembly.mjs';
import { retainedReadEvidenceFromToolResults } from './read-evidence.mjs';

export async function runRuntimeModelExecution({ runtimeTurn, prompt, message, shouldCallModel, modelConfig, logger, resolvedWorkingRoot, rootDir, dataRoot, resolvedSessionId, conversationId, runtimeConfig, executionPolicy, executionContext, normalizedArgs, attachments, sessionRoot, resolvedRunId, continuity, initialWorkingContext, onTextDelta, onThoughtDelta, onContextUsage, command = 'chat', json = false } = {}) {
  const modelTurn = await runRuntimeTurn({
    runtimeTurn,
    branch: 'plain-model',
    plainModelTurn: {
      prompt,
      message,
      shouldCallModel,
      modelConfig,
      contextThreshold: runtimeConfig.contextConfig.contextThreshold,
      traceLogger: logger,
      workspaceRoot: resolvedWorkingRoot,
      rootDir,
      dataRoot,
      sessionId: resolvedSessionId,
      conversationId,
      enableChatToolLoop: Boolean(shouldCallModel),
      stopOnNoProgress: runtimeConfig.chatToolLoopConfig.stopOnNoProgress,
      loopWarningThreshold: runtimeConfig.chatToolLoopConfig.loopWarningThreshold,
      loopBlockThreshold: runtimeConfig.chatToolLoopConfig.loopBlockThreshold,
      executionPolicy,
      executionContext,
      abortSignal: normalizedArgs.abort_signal || normalizedArgs.abortSignal || null,
      onTextDelta,
      onThoughtDelta,
      onContextUsage,
      attachments,
    },
  });
  const stillCurrent = await isSessionContinuityCurrent({ rootDir: sessionRoot, sessionId: resolvedSessionId, runId: resolvedRunId, generation: continuity.generation });
  if (!stillCurrent) {
    const superseded = { ok: false, mode: 'ask', command, decision: 'superseded', runId: resolvedRunId, sessionId: resolvedSessionId, answerText: null, blockers: ['superseded_by_newer_session_run'], continuity: { ...(await readSessionContinuityHead({ rootDir: sessionRoot, sessionId: resolvedSessionId })), current: false } };
    return { superseded: true, result: json ? superseded : compactAskChatResult(superseded) };
  }
  const toolResults = modelTurn.chatToolLoop?.toolResults || [];
  const finalWorkingContext = applyWorkingContextEvents(initialWorkingContext, [
    ...verifiedEventsFromToolResults(toolResults, { workspaceRoot: resolvedWorkingRoot, runId: logger.runId, traceDir: logger.traceDir }),
    { readEvidence: retainedReadEvidenceFromToolResults(toolResults) },
  ]);
  return { superseded: false, modelTurn, finalWorkingContext };
}
