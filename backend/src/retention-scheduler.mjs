import { readRetentionPolicy, readRetentionPolicyState, retentionPolicyFailureState, retentionPolicySuccessState, writeRetentionPolicyState } from './retention-settings.mjs';

export function createRetentionScheduler({ databasePath = null, runCleanup, intervalMs = 60_000, clock = () => new Date() } = {}) {
  if (typeof runCleanup !== 'function') throw new Error('retention_scheduler_cleanup_required');
  let timer = null;
  let ticking = false;
  async function tick() {
    if (ticking) return null;
    ticking = true;
    let policy = null;
    let state = null;
    try {
      policy = readRetentionPolicy({ databasePath });
      state = readRetentionPolicyState({ databasePath });
      const now = clock();
      const nowMs = now.getTime();
      const dueAt = state.nextRunAt ? Date.parse(state.nextRunAt) : null;
      if (!policy.enabled || (Number.isFinite(dueAt) && dueAt > nowMs)) return { ok: true, skipped: true, reason: policy.enabled ? 'not_due' : 'disabled', policy, state };
      const result = await runCleanup(policy);
      // A competing process owns destructive cleanup. Do not overwrite its
      // policy receipt or advance shared scheduling state as if this tick ran.
      if (result?.skipped && result?.reason === 'already_running') return { ok: true, skipped: true, reason: 'already_running', policy, state, result };
      const completedAt = clock();
      const next = retentionPolicySuccessState({ policy, result, at: completedAt, previous: state });
      writeRetentionPolicyState(next, { databasePath });
      return { ok: true, skipped: false, policy, state: next, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (policy && state) {
        try {
          const next = retentionPolicyFailureState({ policy, error, at: clock(), previous: state });
          writeRetentionPolicyState(next, { databasePath });
          return { ok: false, skipped: false, policy, state: next, error: next.lastError };
        } catch {}
      }
      return { ok: false, skipped: false, policy, state, error: message };
    } finally { ticking = false; }
  }
  function start() { if (!timer) { timer = setInterval(() => { void tick().catch(() => {}); }, intervalMs); timer.unref?.(); } return tick(); }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { start, stop, tick };
}
