import { postgresContinuity } from './postgres-continuity.mjs';

// Startup recovery is deliberately bounded and idempotent. A queue claim is
// durable before model work begins; duplicate startups see it as running and
// leave it alone. The next normal turn still receives the manifest if a
// recovery run itself fails.
export async function runPendingRecoveryContinuations({ stores = null, agentRuntimes = [], runContinuation, createRunId, limit = 20, logger = console } = {}) {
  if (!stores?.conversations) throw new Error('runtime_stores_required');
  if (typeof runContinuation !== 'function') throw new Error('recovery_continuation_runner_required');
  if (typeof createRunId !== 'function') throw new Error('recovery_continuation_run_id_required');
  const outcomes = [];
  for (const runtime of agentRuntimes) {
    if (!runtime?.agentWorkspaceRoot || !runtime?.agentId) continue;
    const authority = postgresContinuity({ store: stores.conversations, agentId: runtime.agentId });
    const pending = await authority.pending({ rootDir: runtime.agentWorkspaceRoot, limit });
    for (const item of pending) {
      const runId = createRunId({ sessionId: item.sessionId, prefix: 'recover' });
      const claim = await authority.claimRecovery({ rootDir: runtime.agentWorkspaceRoot, sessionId: item.sessionId, recoveryRunId: runId });
      if (!claim.ok) continue;
      try {
        const result = await runContinuation({ runtime, sessionId: item.sessionId, runId, manifest: claim.manifest, continuation: claim.continuation });
        const completed = await authority.completeRecovery({
          rootDir: runtime.agentWorkspaceRoot, sessionId: item.sessionId, recoveryRunId: runId,
          ok: Boolean(result?.ok), result: result?.decision || (result?.ok ? 'completed' : 'failed'),
        });
        outcomes.push({ agentId: runtime.agentId, sessionId: item.sessionId, runId, ok: Boolean(result?.ok), result, continuation: completed.continuation });
      } catch (error) {
        const completed = await authority.completeRecovery({ rootDir: runtime.agentWorkspaceRoot, sessionId: item.sessionId, recoveryRunId: runId, ok: false, result: String(error?.message || error) });
        logger?.error?.(`Burrow recovery continuation failed for ${runtime.agentId}/${item.sessionId}: ${String(error?.message || error)}`);
        outcomes.push({ agentId: runtime.agentId, sessionId: item.sessionId, runId, ok: false, error: String(error?.message || error), continuation: completed.continuation });
      }
    }
  }
  return outcomes;
}
