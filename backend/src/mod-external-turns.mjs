import { createChatTurnRunId } from './chat-turn-run-id.mjs';
import { runChatTurnFromBody } from './chat-turn-controller.mjs';
import { classifyRuntimeOutcome } from './runtime-outcome.mjs';
import { createBackgroundLifecycle } from './background-lifecycle.mjs';

function boundedResult(result = {}) {
  return {
    answerText: typeof result.answerText === 'string' ? result.answerText.slice(0, 24_000) : null,
    decision: typeof result.decision === 'string' ? result.decision.slice(0, 128) : null,
    blockers: Array.isArray(result.blockers) ? result.blockers.slice(0, 20).map(value => String(value).slice(0, 512)) : [],
    verification: result.verification ? {
      required: Boolean(result.verification.required),
      ok: result.verification.ok ?? null,
      reason: result.verification.reason ? String(result.verification.reason).slice(0, 512) : null,
    } : null,
  };
}

export function publicExternalTurn(turn) {
  return {
    id: turn.id,
    agentId: turn.agentId,
    sessionId: turn.sessionId,
    status: turn.status,
    runId: turn.runId || null,
    result: turn.result || null,
    error: turn.error || null,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    startedAt: turn.startedAt || null,
    completedAt: turn.completedAt || null,
  };
}

export function createModExternalTurnDispatcher({ store, stores, resolveAgentRuntime, rootDir, executeTurn = runChatTurnFromBody, createRunId = createChatTurnRunId, telemetry = null } = {}) {
  if (!store || !stores || typeof resolveAgentRuntime !== 'function' || typeof executeTurn !== 'function') throw new Error('mod_external_turn_dispatcher_dependencies_required');
  const lifecycle = createBackgroundLifecycle({ name: 'mod_external_turn_dispatcher' });

  async function interrupt(turn) {
    return store.complete(turn.id, { status: 'interrupted', error: 'service_shutdown' });
  }

  async function run(turn) {
    const runId = createRunId({ sessionId: turn.sessionId, prefix: 'external' });
    try {
      if (lifecycle.stopped) { await interrupt(turn); return; }
      if (!(await store.markRunning(turn.id, runId))) return;
      if (lifecycle.stopped) { await interrupt(turn); return; }
      const agentRuntime = await resolveAgentRuntime(turn.agentId);
      lifecycle.signal.throwIfAborted();
      const result = await executeTurn({
        body: { message: turn.message, sessionId: turn.sessionId, runId, abortSignal: lifecycle.signal },
        rootDir,
        stores,
        agentRuntime,
        resolveAgentRuntime,
        turnSource: 'mod/external',
        runSource: 'mod/external',
        externalTurnMetadata: { ownerModId: turn.ownerModId, externalTurnId: turn.id },
        telemetry,
      });
      const outcome = classifyRuntimeOutcome(result, { cancelled: lifecycle.signal.aborted });
      await store.complete(turn.id, {
        status: lifecycle.stopped ? 'interrupted' : outcome.ok ? 'succeeded' : 'failed',
        result: boundedResult(result),
        error: lifecycle.stopped ? 'service_shutdown' : outcome.ok ? null : 'agent_turn_failed',
      });
    } catch {
      try { await store.complete(turn.id, { status: lifecycle.stopped ? 'interrupted' : 'failed', error: lifecycle.stopped ? 'service_shutdown' : 'agent_turn_failed' }); }
      catch { /* Startup reconciliation will interrupt a receipt if terminal persistence is unavailable. */ }
    }
  }

  function launch(turn) {
    void lifecycle.track(() => run(turn), 'dispatch').catch(() => {});
  }

  return Object.freeze({
    async replay(input) {
      if (typeof store.getByIdempotency !== 'function') return null;
      const turn = await store.getByIdempotency(input.ownerModId, input.idempotencyKey);
      if (!turn) return null;
      if (turn.agentId !== input.agentId || turn.sessionId !== input.sessionId || turn.message !== input.message) throw new Error('mod_external_turn_idempotency_conflict');
      return { turn: publicExternalTurn(turn), replayed: true };
    },
    async submit(input) {
      if (lifecycle.stopped) throw new Error('mod_external_turn_dispatcher_stopped');
      const created = await store.create(input);
      if (!created.replayed && created.turn.status === 'queued') {
        if (lifecycle.stopped) {
          const interrupted = await interrupt(created.turn);
          return { turn: publicExternalTurn(interrupted || created.turn), replayed: false };
        }
        launch(created.turn);
      }
      return { turn: publicExternalTurn(created.turn), replayed: created.replayed };
    },
    async read(ownerModId, id) {
      const turn = await store.getOwned(ownerModId, id);
      return turn ? publicExternalTurn(turn) : null;
    },
    stop: (reason) => lifecycle.stop(reason),
    close: (reason) => lifecycle.close(reason),
    health: () => lifecycle.health(),
    pendingCount: () => lifecycle.health().pending,
  });
}
