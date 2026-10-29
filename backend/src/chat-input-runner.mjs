import { projectModelRecoveryMetadata } from './model-recovery-projection.mjs';
import { postgresContinuity } from './postgres-continuity.mjs';
import { randomUUID } from 'node:crypto';
import { createBackgroundLifecycle } from './background-lifecycle.mjs';
import { runChatTurnFromBody } from './chat-turn-controller.mjs';
import { answerSideQuestion } from './chat-side-question.mjs';
import { classifyRuntimeOutcome } from './runtime-outcome.mjs';
import { hasOperationalTelemetryObservers, operationalTelemetry } from './operational-telemetry.mjs';
import { performance } from 'node:perf_hooks';

// Dispatch is deliberately small: queue-next uses the ordinary session turn;
// side questions use a frozen, tool-free snapshot and never claim that session.
export function createChatInputRunner({ store, stores, rootDir, resolveAgentRuntime,
  executeTurn = runChatTurnFromBody, answerSide = answerSideQuestion,
  admitMain = async (_job, operation) => operation(), registerActiveRun = null,
  telemetry = null, requestRecovery = null, ownerId = `inputs-${randomUUID()}`, maxConcurrent = 4, retryMs = 1000,
} = {}) {
  if (!store || !stores || !resolveAgentRuntime) throw new Error('chat_input_runner_dependencies_required');
  const lifecycle = createBackgroundLifecycle({ name: 'chat_input_runner' });
  const active = new Map(), receipts = new Map(), reconciliation = new Map();
  let started = false, initialized = false, pumping = null, timer = null, closing = null;
  async function flush() {
    for (const [id, receipt] of receipts) {
      try {
        const startedAt = performance.now();
        const completed = await store.complete(id, receipt);
        // Another flush may have acknowledged a newer receipt while this
        // idempotent persistence awaited its lock. Observe only this owner.
        if (receipts.get(id) === receipt) {
          if (completed?.status === 'interrupted') operationalTelemetry('run-interrupted', {
            sessionId: completed.sessionId, runId: completed.runId, source: completed.intent === 'side_question' ? 'side_question' : 'main',
            outcome: 'recorded', reason: 'service_shutdown', durationMs: Math.max(0, performance.now() - startedAt),
          });
          receipts.delete(id);
        }
      } catch (error) {
        if (error?.message === 'chat_input_owner_fenced') {
          // Reset/dead-owner reconciliation already owns this terminal state.
          // A permanently fenced receipt must not consume dispatch capacity.
          if (receipts.get(id) === receipt) receipts.delete(id);
          continue;
        }
        lifecycle.reportFailure(error, 'terminal_persistence'); return;
      }
    }
  }
  let observingQueue = false;
  function observeQueue() {
    if (observingQueue || lifecycle.stopped || !hasOperationalTelemetryObservers() || typeof store.queueTelemetrySnapshot !== 'function') return;
    observingQueue = true;
    // Coalesce the optional aggregate read without gating admission/receipts.
    // Pass shutdown cancellation to supporting stores and own every read until
    // it settles. Custom stores that ignore the signal must still be drained.
    void lifecycle.track(async () => {
      try {
        if (lifecycle.stopped || !hasOperationalTelemetryObservers()) return;
        const snapshots = await store.queueTelemetrySnapshot({ signal: lifecycle.signal });
        if (lifecycle.stopped || !hasOperationalTelemetryObservers()) return;
        for (const { intent, pendingDepth, oldestAgeMs } of snapshots || []) {
          operationalTelemetry('chat-queue-snapshot', { intent, pendingDepth, oldestAgeMs });
        }
      } catch { /* Observation cannot change dispatch or health. */ }
      finally { observingQueue = false; }
    }, 'queue_observation').catch(() => {});
  }
  async function run(job, controller) {
    let registered = null, receipt;
    let signal = AbortSignal.any([lifecycle.signal, controller.signal]);
    try {
      const runtime = await resolveAgentRuntime(job.agentId);
      const operation = async () => {
        signal.throwIfAborted();
        const current = await store.get(job);
        if (!current || current.status !== 'running') throw new Error('chat_input_session_reset');
        if (current.cancelRequested) { controller.abort(new Error('chat_input_cancelled')); signal.throwIfAborted(); }
        const enqueuedAt = Date.parse(job.createdAt || '');
        operationalTelemetry('chat-queue-started', { intent: job.intent, sessionId: job.sessionId, runId: job.runId,
          waitMs: Number.isFinite(enqueuedAt) ? Math.max(0, Date.now() - enqueuedAt) : null });
        registered = registerActiveRun?.({ agentId: job.agentId, sessionId: job.sessionId, runId: job.runId,
          message: job.message, source: job.intent, lane: job.intent === 'side_question' ? 'side_question' : 'main',
          inputId: job.id, parentSignal: signal });
        if (registered?.signal) signal = AbortSignal.any([signal, registered.signal]);
        const observers = { onTraceRecord: registered?.onTraceRecord, onModelTextDelta: registered?.onModelTextDelta,
          onModelThoughtDelta: registered?.onModelThoughtDelta, onModelContextUsage: registered?.onModelContextUsage };
        if (job.intent === 'side_question') return answerSide({ job, stores, rootDir, agentRuntime: runtime, signal, telemetry, ...observers });
        return executeTurn({ body: { message: job.message, attachments: job.attachments, sessionId: job.sessionId, runId: job.runId, abortSignal: signal },
          chatInput: { id: job.id, intent: 'queue_next', projection: true, generation: job.generation, promotedFrom: job.promotedFrom },
          stores, rootDir, agentRuntime: runtime, resolveAgentRuntime, telemetry, runSource: 'queue_next', ...observers,
          onSteeringReady: registered?.onSteeringReady,
          cancellationGraceMs: registered?.cancellationGraceMs, onCancellationDeadline: registered?.onCancellationDeadline,
          registerNestedAgentRun: registerActiveRun ? ({ agentRuntime: nested, sessionId, runId, message, source, parentSignal, ...a2a }) => registerActiveRun({
            agentId: nested.agentId, sessionId, runId, message, source, parentSignal: parentSignal ? AbortSignal.any([signal, parentSignal]) : signal,
            a2a: source === 'a2a' ? a2a : null }) : null,
        });
      };
      const result = job.intent === 'queue_next' ? await admitMain(job, operation, signal) : await operation();
      const outcome = classifyRuntimeOutcome(result, { cancelled: signal.aborted });
      receipt = { ownerId, ownerLockId: job.ownerLockId,
        status: lifecycle.stopped ? 'interrupted' : signal.aborted ? 'cancelled' : outcome.ok ? 'succeeded' : 'failed',
        result: { ...projectModelRecoveryMetadata(result), ok: outcome.ok, answerText: result.answerText || null, decision: result.decision || null, blockers: result.blockers || [] },
        error: lifecycle.stopped ? 'service_shutdown' : signal.aborted ? 'chat_input_cancelled' : outcome.ok ? null : result.error || 'agent_turn_failed',
        traceDir: result.traceDir || null };
    } catch (error) {
      receipt = { ownerId, ownerLockId: job.ownerLockId,
        status: lifecycle.stopped ? 'interrupted' : signal.aborted ? 'cancelled' : 'failed',
        error: lifecycle.stopped ? 'service_shutdown' : signal.aborted ? 'chat_input_cancelled' : error?.message === 'chat_input_session_reset' ? error.message : 'agent_turn_failed' };
    }
    receipts.set(job.id, receipt);
    try { await flush(); } finally { registered?.finish?.(); }
  }
  function wake() {
    if (!started || lifecycle.stopped) return Promise.resolve();
    if (pumping) return pumping;
    pumping = lifecycle.track(async () => {
      await store.reconcileInterrupted(); initialized = true;
      const blockedScopes = await store.pendingMainScopes?.() || [];
      for (const scope of blockedScopes) {
        let authority=reconciliation.get(scope.agentId);
        if (!authority) { authority=postgresContinuity({store:stores.conversations,agentId:scope.agentId,ownerId:`${ownerId}:reconcile:${scope.agentId}`}); reconciliation.set(scope.agentId,authority); }
        await authority.reconcile({sessionId:scope.sessionId});
      }
      // Reuse normal recovery claims; do not replay uncertain work in this
      // dispatcher. Recovery remains asynchronous to independent side answers.
      if (blockedScopes.length && requestRecovery) void requestRecovery().catch(error=>lifecycle.reportFailure(error,'continuity_recovery'));
      // A claim can commit before its controller is registered; cancellation is
      // durable and checked both before dispatch and while execution is live.
      for (const item of active.values()) {
        const current = await store.get(item.job);
        if (!current || current.status !== 'running' || current.cancelRequested) item.controller.abort(new Error('chat_input_cancelled'));
      }
      await flush();
      while (!lifecycle.stopped && new Set([...active.keys(), ...receipts.keys()]).size < maxConcurrent) {
        const job = await store.claim({ ownerId });
        if (!job) break;
        const controller = new AbortController();
        const item = { job, controller };
        active.set(job.id, item);
        const execution = lifecycle.track(() => run(job, controller), 'dispatch');
        execution.finally(() => {
          active.delete(job.id);
          queueMicrotask(() => { void wake().catch(() => {}); });
        }).catch(() => {});
      }
      observeQueue();
    }, 'admission').finally(() => { pumping = null; });
    return pumping;
  }
  return {
    start() { if (started || lifecycle.stopped) return Promise.resolve(); started = true;
      timer = setInterval(() => { void wake().catch(() => {}); }, retryMs); timer.unref?.(); return wake().catch(() => {}); },
    wake,
    cancel(id) { const item = active.get(id); if (item) item.controller.abort(new Error('chat_input_cancelled')); return Boolean(item); },
    cancelSession({ agentId, sessionId, mainOnly = false }) {
      for (const item of active.values()) if (item.job.agentId === agentId && item.job.sessionId === sessionId && (!mainOnly || item.job.intent === 'queue_next')) item.controller.abort(new Error('chat_input_cancelled'));
    },
    stop(reason) { clearInterval(timer); lifecycle.stop(reason); },
    close(reason) { this.stop(reason); closing ||= (async () => { await lifecycle.close(reason); await flush(); await store.interruptOwner(ownerId); await Promise.all([...reconciliation.values()].map(authority=>authority.close())); })(); return closing; },
    health: () => ({ ...lifecycle.health(), active: active.size, terminalReceipts: receipts.size, initialized }),
  };
}
