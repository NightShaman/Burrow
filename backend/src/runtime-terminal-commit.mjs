import { commitSessionContinuityHead } from './session-store.mjs';
import { compactAskChatResult } from './runtime-result-assembly.mjs';
import { persistSessionWorkingContext } from './working-context.mjs';

export function createTerminalCommitter({ rootDir, sessionRoot, sessionId, runId, generation, command, json, initialWorkingContext, testHooks } = {}) {
  return async function commitTerminalResult({ workingContext = initialWorkingContext, finalize, branch = 'terminal' } = {}) {
    await testHooks?.beforeTerminalCommit?.({ branch, sessionId, runId, generation });
    const completion = await commitSessionContinuityHead({
      rootDir: sessionRoot,
      sessionId,
      runId,
      generation,
      commit: async () => {
        const result = await finalize();
        await persistSessionWorkingContext({ rootDir: sessionRoot, sessionId, workingContext });
        return result;
      },
    });
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
      return json ? superseded : compactAskChatResult(superseded);
    }
    const result = completion.value;
    void testHooks?.afterTerminalResponse?.({ branch, sessionId, runId, postTerminalCuration: null });
    return json ? { ...result, continuity: { ...completion.head, current: true } } : compactAskChatResult(result);
  };
}
