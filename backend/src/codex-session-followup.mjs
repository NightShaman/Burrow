import { conversationAuthority } from './conversation-authority.mjs';
import { runCodexMinion } from './codex-minion-runner.mjs';

/** Called inside ordinary session serialization and PostgreSQL continuity ownership.
 * Only server-owned metadata selects the harness, target and native identity.
 */
export async function runCodexSessionFollowup({ stores, executionContext, agentId, sessionId,
  runId, message, dataRoot, traceDir, signal, attachments = [], noCallModel = false,
  runner = runCodexMinion } = {}) {
  const authority = conversationAuthority({ store: stores.conversations, agentId });
  const metadata = await authority.metadata(sessionId);
  if (metadata?.harness !== 'codex') return null;
  const native = metadata.codexSession;
  await authority.append({ sessionId, runId, traceDir, type: 'message', role: 'user', content: message,
    metadata: { kind: 'codex-minion-followup' } });
  let result;
  const blocker = !native?.threadId ? 'codex_session_unavailable'
    : native.state === 'running' ? 'codex_session_reconciliation_required'
    : attachments.length ? 'codex_followup_attachments_unsupported'
    : noCallModel ? 'codex_model_call_disabled' : null;
  if (blocker) {
    result = { ok: false, summary: 'Codex follow-up cannot run in this session.', blockers: [blocker], warnings: [] };
  } else {
    result = await runner({ id: runId, task: message, target: native.target, modelConfig: native.modelConfig,
      executionPolicy: native.executionPolicy, continuation: native, dataRoot, childSessionId: sessionId,
      owner: { agentId }, traceDir, signal, parentExecutionContext: executionContext });
  }
  // Successful native responses are already durably appended by the runner.
  if (!result.ok) await authority.append({ sessionId, runId, traceDir, type: 'message', role: 'assistant',
    content: result.summary, metadata: { kind: 'codex-minion-followup-failure', blockers: result.blockers } });
  return { ...result, answerText: result.summary,
    decision: result.cancelled ? 'cancelled' : result.ok ? 'answered' : 'failed',
    session: { kind: 'subagent', harness: 'codex' } };
}
