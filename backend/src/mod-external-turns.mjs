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

export function createModExternalTurnDispatcher({ store, stores, resolveAgentRuntime, rootDir, executeTurn = runChatTurnFromBody, createRunId = createChatTurnRunId, registerActiveRun = null, telemetry = null } = {}) {
  if (!store || !stores || typeof resolveAgentRuntime !== 'function' || typeof executeTurn !== 'function') throw new Error('mod_external_turn_dispatcher_dependencies_required');
  if (registerActiveRun !== null && typeof registerActiveRun !== 'function') throw new Error('mod_external_turn_lifecycle_required');
  const lifecycle = createBackgroundLifecycle({ name: 'mod_external_turn_dispatcher' });

  const controllers = new Map();

  async function interrupt(turn) {
    return store.complete(turn.id, { status: 'interrupted', error: 'service_shutdown' });
  }

  async function run(turn) {
    const controller = controllers.get(turn.id);
    const dispatchSignal = AbortSignal.any([lifecycle.signal, controller.signal]);
    let signal = dispatchSignal;
    let activeRun = null;
    const cancellationError = () => lifecycle.stopped ? 'service_shutdown' : controller.signal.aborted ? 'cancelled_by_mod' : 'cancelled';
    const runId = createRunId({ sessionId: turn.sessionId, prefix: 'external' });
    try {
      if (lifecycle.stopped) { await interrupt(turn); return; }
      if (!(await store.markRunning(turn.id, runId))) return;
      if (lifecycle.stopped) { await interrupt(turn); return; }
      // Register before runtime resolution/session admission, so queued turns are
      // visible and individually stoppable too. Shared lifecycle owns progress,
      // cancellation deadlines and fencing; dispatcher still owns mod/shutdown drain.
      activeRun = registerActiveRun?.({ agentId: turn.agentId, sessionId: turn.sessionId, runId, message: turn.displayMessage || turn.message, objective: turn.message, source: 'mod/external', parentSignal: dispatchSignal }) || null;
      signal = activeRun?.signal ? AbortSignal.any([dispatchSignal, activeRun.signal]) : dispatchSignal;
      signal.throwIfAborted();
      const agentRuntime = await resolveAgentRuntime(turn.agentId);
      signal.throwIfAborted();
      const metadata = await stores.conversations?.getMetadata?.({ agentId: turn.agentId, sessionId: turn.sessionId });
      if (metadata?.externalModOwnerId && metadata.externalModOwnerId !== turn.ownerModId) throw new Error('mod_session_not_found');
      const selection = metadata?.externalModOwnerId === turn.ownerModId ? metadata.externalModModel : null;
      signal.throwIfAborted();
      const result = await executeTurn({
        body: { message: turn.message, sessionId: turn.sessionId, runId, abortSignal: signal, ...(selection ? { modelConnectionId: selection.connectionId, model: selection.model } : {}) },
        rootDir,
        stores,
        agentRuntime,
        resolveAgentRuntime,
        turnSource: 'mod/external',
        runSource: 'mod/external',
        externalTurnMetadata: { ownerModId: turn.ownerModId, externalTurnId: turn.id, displayMessage: turn.displayMessage || turn.message },
        telemetry,
        onTraceRecord: activeRun?.onTraceRecord || null,
        onModelTextDelta: activeRun?.onModelTextDelta || null,
        onModelThoughtDelta: activeRun?.onModelThoughtDelta || null,
        onModelContextUsage: activeRun?.onModelContextUsage || null,
        onSteeringReady: activeRun?.onSteeringReady || null,
        cancellationGraceMs: activeRun?.cancellationGraceMs ?? null,
        onCancellationDeadline: activeRun?.onCancellationDeadline || null,
        registerNestedAgentRun: registerActiveRun ? ({ agentRuntime: nestedRuntime, sessionId, runId, message, source, parentSignal, ...a2a }) => registerActiveRun({
          agentId: nestedRuntime.agentId, sessionId, runId, message, source,
          parentSignal: parentSignal ? AbortSignal.any([signal, parentSignal]) : signal,
          a2a: source === 'a2a' ? a2a : null,
        }) : null,
      });
      const outcome = classifyRuntimeOutcome(result, { cancelled: signal.aborted });
      await store.complete(turn.id, {
        status: signal.aborted ? 'interrupted' : outcome.ok ? 'succeeded' : 'failed',
        result: boundedResult(result),
        error: signal.aborted ? cancellationError() : outcome.ok ? null : 'agent_turn_failed',
      });
    } catch {
      try { await store.complete(turn.id, { status: signal.aborted ? 'interrupted' : 'failed', error: signal.aborted ? cancellationError() : 'agent_turn_failed' }); }
      catch { /* Startup reconciliation will interrupt a receipt if terminal persistence is unavailable. */ }
    } finally {
      try { activeRun?.finish?.(); }
      finally { controllers.delete(turn.id); }
    }
  }

  function launch(turn) {
    controllers.set(turn.id, new AbortController());
    void lifecycle.track(() => run(turn), 'dispatch').catch(() => {});
  }

  return Object.freeze({
    async replay(input) {
      if (typeof store.getByIdempotency !== 'function') return null;
      const turn = await store.getByIdempotency(input.ownerModId, input.idempotencyKey);
      if (!turn) return null;
      if (turn.agentId !== input.agentId || turn.sessionId !== input.sessionId || turn.message !== input.message || (turn.displayMessage || turn.message) !== input.displayMessage) throw new Error('mod_external_turn_idempotency_conflict');
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
    async cancel(ownerModId, id) {
      const turn = await store.getOwned(ownerModId, id);
      if (!turn) return null;
      const controller = controllers.get(id);
      const cancellationRequested = Boolean(controller && !controller.signal.aborted && ['queued', 'running'].includes(turn.status));
      if (cancellationRequested) controller.abort(new Error('cancelled_by_mod'));
      return { turn: publicExternalTurn(turn), cancellationRequested };
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
