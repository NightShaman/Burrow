import { createBackgroundLifecycle } from './background-lifecycle.mjs';
import { readRetentionPolicy, readRetentionPolicyState, retentionPolicyFailureState, retentionPolicySuccessState, writeRetentionPolicyState } from './retention-settings.mjs';

export function createRetentionScheduler({ store = null, runCleanup, runIndependentCleanup = null, intervalMs = 60_000, clock = () => new Date() } = {}) {
  if (typeof runCleanup !== 'function') throw new Error('retention_scheduler_cleanup_required');
  const lifecycle = createBackgroundLifecycle({ name: 'retention_scheduler', clock: () => clock().toISOString() });
  let timer = null;
  let ticking = false;
  let independentDueAt = 0;
  function tick() { return lifecycle.stopped ? Promise.resolve(null) : lifecycle.track(runTick); }
  async function runTick() {
    if (ticking || lifecycle.stopped) return null;
    ticking = true;
    let policy = null;
    let state = null;
    try {
      policy = await readRetentionPolicy({ store });
      state = await readRetentionPolicyState({ store });
      if (lifecycle.stopped) return { ok: true, skipped: true, reason: 'stopped' };
      const now = clock();
      const nowMs = now.getTime();
      // Independent retention ignores the Dreams enable flag, not its cadence.
      // Advance only after success so a failed cleanup is retried next tick.
      if (runIndependentCleanup && nowMs >= independentDueAt) {
        await runIndependentCleanup();
        independentDueAt = clock().getTime() + policy.intervalMinutes * 60_000;
      }
      if (lifecycle.stopped) return { ok: true, skipped: true, reason: 'stopped' };
      const dueAt = state.nextRunAt ? Date.parse(state.nextRunAt) : null;
      if (!policy.enabled || (Number.isFinite(dueAt) && dueAt > nowMs)) return { ok: true, skipped: true, reason: policy.enabled ? 'not_due' : 'disabled', policy, state };
      const result = await runCleanup(policy);
      // A competing process owns destructive cleanup. Do not overwrite its
      // policy receipt or advance shared scheduling state as if this tick ran.
      if (result?.skipped && result?.reason === 'already_running') return { ok: true, skipped: true, reason: 'already_running', policy, state, result };
      const completedAt = clock();
      const next = retentionPolicySuccessState({ policy, result, at: completedAt, previous: state });
      await writeRetentionPolicyState(next, { store });
      return { ok: true, skipped: false, policy, state: next, result };
    } catch (error) {
      lifecycle.reportFailure(error);
      const message = error instanceof Error ? error.message : String(error);
      if (policy && state) {
        try {
          const next = retentionPolicyFailureState({ policy, error, at: clock(), previous: state });
          await writeRetentionPolicyState(next, { store });
          return { ok: false, skipped: false, policy, state: next, error: next.lastError };
        } catch {}
      }
      return { ok: false, skipped: false, policy, state, error: message };
    } finally { ticking = false; }
  }
  function start() { if (lifecycle.stopped) return Promise.resolve(null); if (!timer) { timer = setInterval(() => { void tick().catch(() => {}); }, intervalMs); timer.unref?.(); } return tick(); }
  function stop() { lifecycle.stop(); if (timer) clearInterval(timer); timer = null; }
  function close() { stop(); return lifecycle.close(); }
  return { start, stop, close, tick, health: lifecycle.health };
}
