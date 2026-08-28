import { runRuntimeTurn } from './runtime-orchestrator.mjs';
import { isSessionContinuityCurrent, readSessionContinuityHead } from './session-store.mjs';
import { applyWorkingContextEvents, verifiedEventsFromToolResults } from './working-context.mjs';
import { compactAskChatResult } from './runtime-result-assembly.mjs';
import { retainedReadEvidenceFromToolResults } from './read-evidence.mjs';

async function supersededModelExecutionResult({ command, json, resolvedRunId, resolvedSessionId, sessionRoot } = {}) {
  const superseded = { ok: false, mode: 'ask', command, decision: 'superseded', runId: resolvedRunId, sessionId: resolvedSessionId, answerText: null, blockers: ['superseded_by_newer_session_run'], continuity: { ...(await readSessionContinuityHead({ rootDir: sessionRoot, sessionId: resolvedSessionId })), current: false } };
  return { superseded: true, result: json ? superseded : compactAskChatResult(superseded) };
}

export async function runRuntimeModelExecution({ runtimeTurn, prompt, message, shouldCallModel, modelConfig, logger, resolvedWorkingRoot, rootDir, dataRoot, resolvedSessionId, conversationId, runtimeConfig, executionPolicy, executionContext, normalizedArgs, attachments, sessionRoot, resolvedRunId, continuity, initialWorkingContext, onTextDelta, onThoughtDelta, onContextUsage, command = 'chat', json = false } = {}) {
  // Planning and prompt preparation can be substantial. Do not begin model/tool
  // execution if a newer turn already owns this session; this is particularly
  // important for nested A2A replies, which otherwise spend work only to be
  // discarded after the turn completes.
  const currentBeforeExecution = await isSessionContinuityCurrent({ rootDir: sessionRoot, sessionId: resolvedSessionId, runId: resolvedRunId, generation: continuity.generation });
  if (!currentBeforeExecution) return supersededModelExecutionResult({ command, json, resolvedRunId, resolvedSessionId, sessionRoot });

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
  if (!stillCurrent) return supersededModelExecutionResult({ command, json, resolvedRunId, resolvedSessionId, sessionRoot });
  const toolResults = modelTurn.chatToolLoop?.toolResults || [];
  const finalWorkingContext = applyWorkingContextEvents(initialWorkingContext, [
    ...verifiedEventsFromToolResults(toolResults, { workspaceRoot: resolvedWorkingRoot, runId: logger.runId, traceDir: logger.traceDir }),
    { readEvidence: retainedReadEvidenceFromToolResults(toolResults) },
  ]);
  return { superseded: false, modelTurn, finalWorkingContext };
}
