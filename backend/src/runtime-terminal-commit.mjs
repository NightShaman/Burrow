import { classifyRuntimeOutcome } from './runtime-outcome.mjs';
import { compactAskChatResult } from './runtime-result-assembly.mjs';
import { persistSessionWorkingContext } from './working-context.mjs';

export function createTerminalCommitter({ stores = null, agentId, continuityAuthority = null, rootDir, sessionRoot, sessionId, runId, generation, command, json, initialWorkingContext, objective = null, traceRef = null, logger = null, onTerminal = null, onCompletionTransaction = null, onCompletionCommitted = null, testHooks } = {}) {
  if (!stores?.conversations) throw new Error('runtime_stores_required');
  if (!continuityAuthority?.commit || !continuityAuthority?.interrupt) throw new Error('runtime_continuity_authority_required');
  return async function commitTerminalResult({ workingContext = initialWorkingContext, finalize, afterCommitBeforeTraceTerminal = null, branch = 'terminal' } = {}) {
    await testHooks?.beforeTerminalCommit?.({ branch, sessionId, runId, generation });
    const completion = await continuityAuthority.commit({
      rootDir: sessionRoot,
      sessionId,
      runId,
      generation,
      onCompleted: onCompletionTransaction,
      commit: async () => {
        const finalized = await finalize();
        const result = { ...finalized, ok: classifyRuntimeOutcome(finalized).ok };
        await persistSessionWorkingContext({ rootDir: sessionRoot, sessionId, workingContext, conversationStore:stores?.conversations,agentId });
        return result;
      },
    });
    if (completion.completionEvent) onCompletionCommitted?.(completion.completionEvent);
    if (completion.stale) {
      const superseded = {
        ...(completion.value || {}),
        ok: false,
        mode: 'ask',
        command,
        decision: 'superseded',
        runId,
        sessionId,
        answerText: null,
        assistantTurn: null,
        blockers: ['superseded_by_newer_session_run'],
        continuity: { ...completion.head, current: false },
      };
      try {
        await continuityAuthority.interrupt({ rootDir: sessionRoot, sessionId, runId, generation, reason: 'superseded_by_newer_session_run', objective, traceRef, lastCompletedStep: 'Terminal result could not be committed because session ownership changed.', pendingVerification: ['Reconcile durable workspace and tool state before continuing.'], workingContext });
        try { await logger?.terminal?.(); } catch { /* A trace write cannot change the superseded receipt. */ }
      } finally {
        try { onTerminal?.(superseded); } catch {}
      }
      return json ? superseded : compactAskChatResult(superseded);
    }
    const result = completion.value;
    try {
      try { await afterCommitBeforeTraceTerminal?.(result); } catch (error) { try { console.warn('postcommit advisory failed', error); } catch {} }
      try { await logger?.terminal?.(); } catch (error) { try { console.warn('postcommit trace cleanup failed', error); } catch {} }
    } finally {
      // Ownership has already reached a genuine terminal. Advisory/trace
      // cleanup failures must not hide that outcome from lifecycle observers.
      try { onTerminal?.(result); } catch {}
    }
    try { Promise.resolve(testHooks?.afterTerminalResponse?.({ branch, sessionId, runId, postTerminalCuration: null })).catch(() => {}); } catch { /* Observer only. */ }
    return json ? { ...result, continuity: { ...completion.head, current: true } } : compactAskChatResult(result);
  };
}
