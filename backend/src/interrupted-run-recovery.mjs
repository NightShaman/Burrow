import { postgresContinuity } from './postgres-continuity.mjs';
import { operationalTelemetry } from './operational-telemetry.mjs';
import { performance } from 'node:perf_hooks';

function boundedText(value, limit = 2_000) {
  const text = String(value || '').trim();
  return text ? text.slice(0, limit) : null;
}

/**
 * Persist runtime-owned recovery manifests before a graceful process shutdown.
 * Records are deliberately compact: the next same-session run reconciles these
 * facts against the durable transcript, workspace, and receipts before acting.
 */
export async function recordActiveRunInterruptions({ stores = null, activeRuns, resolveAgentRuntime, reason = 'service_shutdown', authorityFactory = postgresContinuity } = {}) {
  if (!stores?.conversations) throw new Error('runtime_stores_required');
  const records = activeRuns instanceof Map ? [...activeRuns.values()] : Array.isArray(activeRuns) ? activeRuns : [];
  const settled = await Promise.allSettled(records.map(async (record) => {
    if (!record?.agentId || !record?.sessionId || !record?.runId) return null;
    const startedAt = performance.now();
    const fields = { sessionId: record.sessionId, runId: record.runId,
      source: record.lane === 'side_question' ? 'side_question' : record.source === 'recovery' ? 'recovery' : 'main',
      reason: reason === 'service_shutdown' ? reason : 'other' };
    let outcome = 'failure';
    try {
      if (record.lane === 'side_question') { record.controller?.abort?.(new Error(reason)); outcome = 'cancelled'; return null; }
      const runtime = await resolveAgentRuntime(record.agentId);
      const authority = authorityFactory({ store: stores.conversations, agentId: record.agentId });
      const generation = Number.isSafeInteger(record.generation) ? record.generation : null;
      const manifest = record.source === 'recovery'
        ? await authority.retire({
            rootDir: runtime.agentWorkspaceRoot,
            sessionId: record.sessionId,
            runId: record.runId,
            generation,
            reason,
            recovery: true,
          })
        : await authority.interrupt({
            rootDir: runtime.agentWorkspaceRoot,
            sessionId: record.sessionId,
            runId: record.runId,
            generation,
            reason,
            objective: boundedText(record.objective || record.latestUserMessage),
            lastCompletedStep: `Run was active in phase ${boundedText(record.phase, 120) || 'unknown'} when the runtime received ${reason}.`,
            pendingVerification: ['Reconcile durable workspace, tool, and child-run state before continuing.'],
          });
      // interrupt() returns a manifest even when a newer head fenced the write;
      // unlike retire(), it does not acknowledge persistence. Do not call that a
      // confirmed durable interruption or read/mutate continuity to infer one.
      outcome = record.source === 'recovery' ? (manifest?.stale ? 'stale' : manifest?.ok ? 'retired' : 'failure') : 'requested';
      record.reason = reason;
      record.cancelled = true;
      record.controller?.abort?.(new Error(reason));
      return { agentId: record.agentId, sessionId: record.sessionId, runId: record.runId, manifest };
    } finally {
      operationalTelemetry('run-interrupted', { ...fields, outcome, durationMs: Math.max(0, performance.now() - startedAt) });
    }
  }));
  return settled.map((result) => result.status === 'fulfilled'
    ? { ok: true, value: result.value }
    : { ok: false, error: String(result.reason?.message || result.reason) });
}
