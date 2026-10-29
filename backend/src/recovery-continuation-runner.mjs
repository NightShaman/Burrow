import { createBackgroundLifecycle } from './background-lifecycle.mjs';
import { postgresContinuity } from './postgres-continuity.mjs';
import { operationalTelemetry } from './operational-telemetry.mjs';
import { performance } from 'node:perf_hooks';

// Startup recovery is deliberately bounded and idempotent. A queue claim is
// durable before model work begins; duplicate startups see it as running and
// leave it alone. The next normal turn still receives the manifest if a
// recovery run itself fails.
export async function runPendingRecoveryContinuations({ stores = null, agentRuntimes = [], runContinuation, createRunId, limit = 20, logger = console, signal = null, authorityFactory = postgresContinuity, cancellationGraceMs = 10_000 } = {}) {
  if (!stores?.conversations) throw new Error('runtime_stores_required');
  if (typeof runContinuation !== 'function') throw new Error('recovery_continuation_runner_required');
  if (typeof createRunId !== 'function') throw new Error('recovery_continuation_run_id_required');
  const outcomes = [];
  for (const runtime of agentRuntimes) {
    if (signal?.aborted) break;
    if (!runtime?.agentWorkspaceRoot || !runtime?.agentId) continue;
    const authority = authorityFactory({ store: stores.conversations, agentId: runtime.agentId });
    const pending = await authority.pending({ rootDir: runtime.agentWorkspaceRoot, limit });
    for (const item of pending) {
      if (signal?.aborted) break;
      const runId = createRunId({ sessionId: item.sessionId, prefix: 'recover' });
      const claim = await authority.claimRecovery({ rootDir: runtime.agentWorkspaceRoot, sessionId: item.sessionId, recoveryRunId: runId });
      if (!claim.ok) continue;
      const startedAt = performance.now();
      const attempt = Number(claim.continuation?.attempts);
      const fields = { sessionId: item.sessionId, runId,
        attempt: Number.isSafeInteger(attempt) && attempt > 0 ? attempt : null };
      operationalTelemetry('recovery-attempt', { ...fields, outcome: 'started', durationMs: 0 });
      let terminalOutcome = 'persistence_failure';
      try {
        signal?.throwIfAborted();
        const execution = Promise.resolve(runContinuation({ runtime, sessionId: item.sessionId, runId, manifest: claim.manifest, continuation: claim.continuation, signal }));
        execution.catch(() => {});
        let timer = null;
        let schedule = null;
        const cancellationDeadline = new Promise((_, reject) => {
          if (!signal) return;
          schedule = () => {
            timer = setTimeout(() => reject(signal.reason || new Error('recovery_cancellation_deadline_exceeded')), Math.max(0, Number(cancellationGraceMs) || 0));
          };
          if (signal.aborted) schedule();
          else signal.addEventListener('abort', schedule, { once: true });
        });
        let result;
        try { result = await Promise.race([execution, cancellationDeadline]); }
        finally {
          if (timer !== null) clearTimeout(timer);
          if (schedule) signal?.removeEventListener('abort', schedule);
        }
        const completed = await authority.completeRecovery({
          rootDir: runtime.agentWorkspaceRoot, sessionId: item.sessionId, recoveryRunId: runId,
          ok: Boolean(result?.ok), result: result?.decision || (result?.ok ? 'completed' : 'failed'),
        });
        terminalOutcome = completed.stale ? 'stale' : result?.ok ? 'success' : signal?.aborted ? 'cancelled' : 'failure';
        outcomes.push({ agentId: runtime.agentId, sessionId: item.sessionId, runId, ok: Boolean(result?.ok), result, continuation: completed.continuation });
      } catch (error) {
        const completed = await authority.completeRecovery({ rootDir: runtime.agentWorkspaceRoot, sessionId: item.sessionId, recoveryRunId: runId, ok: false, result: String(error?.message || error) });
        terminalOutcome = completed.stale ? 'stale' : signal?.aborted ? 'cancelled' : 'failure';
        logger?.error?.(`Burrow recovery continuation failed for ${runtime.agentId}/${item.sessionId}: ${String(error?.message || error)}`);
        outcomes.push({ agentId: runtime.agentId, sessionId: item.sessionId, runId, ok: false, error: String(error?.message || error), continuation: completed.continuation });
      } finally {
        operationalTelemetry('recovery-completed', { ...fields, outcome: terminalOutcome, durationMs: Math.max(0, performance.now() - startedAt) });
      }
    }
  }
  return outcomes;
}

// Startup recovery is a one-shot producer, but participates in the same drain
// as recurring schedulers. Runtime discovery belongs to this owner too.
export function createRecoveryContinuationScheduler({ resolveOptions, ...options } = {}) {
  const lifecycle = createBackgroundLifecycle({ name: 'recovery_continuation_scheduler' });
  let started = null, running = null;
  function wake() {
    if (lifecycle.stopped) return Promise.resolve([]);
    if (running) return running;
    running = lifecycle.track(async () => {
      const resolved = resolveOptions ? await resolveOptions() : options;
      if (lifecycle.stopped) return [];
      return runPendingRecoveryContinuations({ ...resolved, signal: lifecycle.signal });
    }).finally(() => { running = null; });
    return running;
  }
  function start() { started ||= wake(); return started; }
  return { start, wake, stop: lifecycle.stop, close: lifecycle.close, health: lifecycle.health };
}
