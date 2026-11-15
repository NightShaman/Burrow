import { conversationAuthority } from './conversation-authority.mjs';
import { runCodexMinion } from './codex-minion-runner.mjs';
import { runClaudeMinion } from './claude-minion-runner.mjs';

/** Called inside ordinary session serialization and PostgreSQL continuity ownership.
 * Only server-owned metadata selects the harness, target and native identity.
 */
export async function runCodexSessionFollowup({ stores, executionContext, agentId, sessionId,
  runId, message, dataRoot, traceDir, signal, attachments = [], noCallModel = false,
  runner = runCodexMinion } = {}) {
  const authority = conversationAuthority({ store: stores.conversations, agentId });
  const metadata = await authority.metadata(sessionId);
  const harness = metadata?.harness;
  if (!['codex','claude'].includes(harness)) return null;
  const native = harness === 'claude' ? metadata.claudeSession : metadata.codexSession;
  await authority.append({ sessionId, runId, traceDir, type: 'message', role: 'user', content: message,
    metadata: { kind: `${harness}-minion-followup` } });
  let result;
  const blocker = harness === 'codex' && !native?.threadId ? 'codex_session_unavailable'
    : harness === 'claude' && !native?.sessionId ? 'claude_session_unavailable'
    : native?.state === 'running' ? `${harness}_session_reconciliation_required`
    : attachments.length ? `${harness}_followup_attachments_unsupported`
    : noCallModel ? `${harness}_model_call_disabled` : null;
  if (blocker) {
    result = { ok: false, summary: `${harness === 'claude' ? 'Claude' : 'Codex'} follow-up cannot run in this session.`, blockers: [blocker], warnings: [] };
  } else {
    const execute = runner === runCodexMinion && harness === 'claude' ? runClaudeMinion : runner;
    result = await execute({ id: runId, task: message, target: native.target, modelConfig: native.modelConfig || { connectionId: native.connectionId, model: native.model },
      executionPolicy: native.executionPolicy, continuation: native, dataRoot, childSessionId: sessionId,
      owner: { agentId }, traceDir, signal, parentExecutionContext: executionContext });
  }
  // Successful native responses are already durably appended by the runner.
  if (!result.ok) await authority.append({ sessionId, runId, traceDir, type: 'message', role: 'assistant',
    content: result.summary, metadata: { kind: `${harness}-minion-followup-failure`, blockers: result.blockers } });
  return { ...result, answerText: result.summary,
    decision: result.cancelled ? 'cancelled' : result.ok ? 'answered' : 'failed',
    session: { kind: 'subagent', harness } };
}
