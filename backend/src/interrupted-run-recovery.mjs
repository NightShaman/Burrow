import { recordInterruptedRun } from './session-store.mjs';

function boundedText(value, limit = 2_000) {
  const text = String(value || '').trim();
  return text ? text.slice(0, limit) : null;
}

/**
 * Persist runtime-owned recovery manifests before a graceful process shutdown.
 * Records are deliberately compact: the next same-session run reconciles these
 * facts against the durable transcript, workspace, and receipts before acting.
 */
export async function recordActiveRunInterruptions({ activeRuns, resolveAgentRuntime, reason = 'service_shutdown' } = {}) {
  const records = activeRuns instanceof Map ? [...activeRuns.values()] : Array.isArray(activeRuns) ? activeRuns : [];
  const settled = await Promise.allSettled(records.map(async (record) => {
    if (!record?.agentId || !record?.sessionId || !record?.runId) return null;
    const runtime = await resolveAgentRuntime(record.agentId);
    const manifest = await recordInterruptedRun({
      rootDir: runtime.agentWorkspaceRoot,
      sessionId: record.sessionId,
      runId: record.runId,
      generation: Number.isSafeInteger(record.generation) ? record.generation : null,
      reason,
      objective: boundedText(record.latestUserMessage),
      lastCompletedStep: `Run was active in phase ${boundedText(record.phase, 120) || 'unknown'} when the runtime received ${reason}.`,
      pendingVerification: ['Reconcile durable workspace, tool, and child-run state before continuing.'],
    });
    record.reason = reason;
    record.cancelled = true;
    record.controller?.abort?.(new Error(reason));
    return { agentId: record.agentId, sessionId: record.sessionId, runId: record.runId, manifest };
  }));
  return settled.map((result) => result.status === 'fulfilled'
    ? { ok: true, value: result.value }
    : { ok: false, error: String(result.reason?.message || result.reason) });
}
