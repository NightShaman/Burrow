import { renderRuntimeRecovery } from './recovery-prompt.mjs';
import { resolveMinionProfileExecutionTarget, minionProfileAction } from './minion-profiles.mjs';
import { conversationAuthority } from './conversation-authority.mjs';
import { runCodexMinion } from './codex-minion-runner.mjs';
import { runClaudeMinion } from './claude-minion-runner.mjs';
import { runGeminiMinion } from './gemini-minion-runner.mjs';

/** Called inside ordinary session serialization and PostgreSQL continuity ownership.
 * Only server-owned metadata selects the harness, target and native identity.
 */
export async function runCodexSessionFollowup({ stores, executionContext, agentId, sessionId,
  runId, message, recoveryManifest = null, dataRoot, traceDir, signal, onTraceRecord = null, attachments = [], noCallModel = false,
  runner = runCodexMinion } = {}) {
  const authority = conversationAuthority({ store: stores.conversations, agentId });
  const metadata = await authority.metadata(sessionId);
  const harness = metadata?.harness;
  if (!['codex','claude','gemini'].includes(harness)) return null;
  const native = harness === 'claude' ? metadata.claudeSession : harness === 'gemini' ? metadata.geminiSession : metadata.codexSession;
  if (!recoveryManifest) await authority.append({ sessionId, runId, traceDir, type: 'message', role: 'user', content: message,
    metadata: { kind: `${harness}-minion-followup` } });
  let result;
  // A pinned profile host belongs to this session, not to the agent's current
  // default profile. Resolve the durable pin without consulting live profiles.
  const frozenHost = metadata.minionProfile ? native?.executionHost : null;
  const hostId = metadata.minionProfile?.executionHostId
    || (frozenHost?.kind === 'remote' ? frozenHost.targetId : frozenHost?.kind === 'local' ? 'local' : null);
  const host = hostId
    ? await resolveMinionProfileExecutionTarget({ executionContext, profile: { executionHostId: hostId } }) : null;
  const followupContext = host?.target ? {
    ...executionContext, stores: executionContext?.stores,
    conversationStore: executionContext?.conversationStore,
    telemetry: executionContext?.telemetry, abortSignal: executionContext?.abortSignal,
    executionProviders: executionContext?.executionProviders,
    processExecutionController: host.controller ?? (host.target.kind === 'remote' ? executionContext?.processExecutionController : null),
    processExecutionRouter: null,
    processExecutionTarget: host.target,
    executionEnvironment: { ...host.target },
  } : executionContext;
  const blocker = host?.blockers?.[0] || (harness === 'codex' && !native?.threadId ? 'codex_session_unavailable'
    : harness !== 'codex' && !native?.sessionId ? `${harness}_session_unavailable`
    : native?.state === 'running' ? `${harness}_session_reconciliation_required`
    : attachments.length ? `${harness}_followup_attachments_unsupported`
    : noCallModel ? `${harness}_model_call_disabled` : null);
  if (blocker) {
    result = { ok: false, summary: minionProfileAction(blocker) || `${harness === 'claude' ? 'Claude' : harness === 'gemini' ? 'Gemini' : 'Codex'} follow-up cannot run in this session.`, blockers: [blocker], warnings: [] };
  } else {
    const execute = runner === runCodexMinion ? (harness === 'claude' ? runClaudeMinion : harness === 'gemini' ? runGeminiMinion : runner) : runner;
    // Native CLIs accept a task string. Keep its runtime origin explicit and
    // never project this transport input as operator dialogue in Burrow.
    const task = recoveryManifest ? `# Burrow runtime recovery\n\n${renderRuntimeRecovery(message, recoveryManifest)}` : message;
    result = await execute({ id: runId, task, target: native.target, modelConfig: native.modelConfig || { connectionId: native.connectionId, model: native.model },
      executionPolicy: native.executionPolicy, continuation: native, dataRoot, childSessionId: sessionId,
      owner: { agentId }, traceDir, signal, onTraceRecord, parentExecutionContext: followupContext });
  }
  // Successful native responses are already durably appended by the runner.
  if (!result.ok) await authority.append({ sessionId, runId, traceDir, type: 'message', role: 'assistant',
    content: result.summary, metadata: { kind: `${harness}-minion-followup-failure`, blockers: result.blockers } });
  return { ...result, answerText: result.summary,
    decision: result.cancelled ? 'cancelled' : result.ok ? 'answered' : 'failed',
    session: { kind: 'subagent', harness } };
}
