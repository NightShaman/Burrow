import { createBackgroundLifecycle } from './background-lifecycle.mjs';
import { runDreamCycle } from './dream-cycle-runner.mjs';

function now() { return new Date().toISOString(); }

export function createDreamCycleScheduler({ intervalMs = 30_000, clock = now, resolveAgentRoot = null, stores = null, modelAdapter = null } = {}) {
  const lifecycle = createBackgroundLifecycle({ name: 'dream_cycle_scheduler', clock });
  let timer = null;
  let ticking = false;
  function tick() { return lifecycle.stopped ? Promise.resolve([]) : lifecycle.track(runTick); }
  async function runTick() {
    if (ticking || lifecycle.stopped) return [];
    ticking = true;
    try {
      const at = clock();
      if (!stores?.agents || !stores?.dreamCycles || !stores?.dreamSettings) throw new Error('dream_cycle_stores_required');
      const results = [];
      const due = (await Promise.all((await stores.agents.list({ includeDisabled: false })).map(async (agent) => {
          try {
          // Brains opt-in is not permission to inherit Core's heavy Dream cycle.
          // The owning mod schedules any reflection it wants independently.
          if (lifecycle.stopped || agent.modAgent) return null;
          const settings = await stores.dreamSettings.get(agent.id);
          if (lifecycle.stopped) return null;
          const state = await stores.dreamCycles.ensureState({ agentId: agent.id, settings, at });
          return settings.enabled && state.nextRunAt && state.nextRunAt <= at ? { agent } : null;
          } catch (error) { lifecycle.reportFailure(error, 'due'); results.push({ ok: false, agentId: agent.id, error: String(error?.message || error), generatedAt: at }); return null; }
        }))).filter(Boolean);
      for (const item of due) {
        if (lifecycle.stopped) break;
        let rootDir;
        try { rootDir = await resolveAgentRoot?.(item.agent.id); }
        catch (error) { lifecycle.reportFailure(error, 'resolve_root'); results.push({ ok: false, agentId: item.agent.id, error: String(error?.message || error), generatedAt: at }); continue; }
        if (lifecycle.stopped) break;
        const claim = await stores.dreamCycles.claimDue({ agentId: item.agent.id, at });
        if (!claim) continue;
        if (lifecycle.stopped) {
          await stores.dreamCycles.write({ version: 1, ok: false, status: 'failed', agentId: item.agent.id, runId: claim.runId, trigger: 'scheduled', scheduledFor: claim.scheduledFor, generatedAt: claim.scheduledFor, completedAt: clock(), error: 'service_shutdown' });
          continue;
        }
        try {
          const receipt = await runDreamCycle({ agentId: item.agent.id, rootDir, generatedAt: claim.scheduledFor, scheduledFor: claim.scheduledFor, runId: claim.runId, trigger: 'scheduled', stores, modelAdapter, signal: lifecycle.signal });
          if (receipt.ok === false) lifecycle.reportFailure(new Error(receipt.error || 'dream_cycle_failed'), 'run');
          results.push(receipt);
        }
        catch (error) { lifecycle.reportFailure(error, 'run'); results.push({ ok: false, agentId: item.agent.id, error: String(error?.message || error), generatedAt: at }); }
      }
      return results;
    } finally { ticking = false; }
  }
  function start() { if (lifecycle.stopped) return Promise.resolve([]); if (!timer) { timer = setInterval(() => { void tick().catch(() => {}); }, intervalMs); timer.unref?.(); } return tick(); }
  function stop() { lifecycle.stop(); if (timer) clearInterval(timer); timer = null; }
  function close() { stop(); return lifecycle.close(); }
  return { start, stop, close, tick, health: lifecycle.health };
}
