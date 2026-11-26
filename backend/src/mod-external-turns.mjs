import { operationalEvent, infrastructureErrorCode, operationalId } from './operational-log.mjs';
import { createChatTurnRunId } from './chat-turn-run-id.mjs';
import { runChatTurnFromBody } from './chat-turn-controller.mjs';
import { classifyRuntimeOutcome } from './runtime-outcome.mjs';
import { createBackgroundLifecycle } from './background-lifecycle.mjs';
import { externalTurnOutputAttachments, readExternalTurnOutputAttachment } from './mod-external-turn-output.mjs';
import { sameExternalTurnInput } from './mod-external-turn-attachments.mjs';

// PostgreSQL JSONB rejects NUL and unpaired UTF-16 surrogates. Keep the
// existing code-unit limits, dropping a pair that would cross the boundary.
function boundedReceiptString(value, limit) {
  const text = value.toWellFormed().replaceAll('\0', '\uFFFD');
  let end = Math.min(text.length, limit);
  if (end < text.length && end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
  return text.slice(0, end);
}

function boundedResult(result = {}, attachments = []) {
  return {
    attachments,
    answerText: typeof result.answerText === 'string' ? boundedReceiptString(result.answerText, 24_000) : null,
    decision: typeof result.decision === 'string' ? boundedReceiptString(result.decision, 128) : null,
    blockers: Array.isArray(result.blockers) ? result.blockers.slice(0, 20).map(value => boundedReceiptString(String(value), 512)) : [],
    verification: result.verification ? {
      required: Boolean(result.verification.required),
      ok: result.verification.ok ?? null,
      reason: result.verification.reason ? boundedReceiptString(String(result.verification.reason), 512) : null,
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

export function createModExternalTurnDispatcher({ store, stores, resolveAgentRuntime, rootDir, executeTurn = runChatTurnFromBody, createRunId = createChatTurnRunId, registerActiveRun = null, telemetry = null, logger = console, receiptRetryMs = 1000 } = {}) {
  if (!store || !stores || typeof resolveAgentRuntime !== 'function' || typeof executeTurn !== 'function') throw new Error('mod_external_turn_dispatcher_dependencies_required');
  if (registerActiveRun !== null && typeof registerActiveRun !== 'function') throw new Error('mod_external_turn_lifecycle_required');
  const lifecycle = createBackgroundLifecycle({ name: 'mod_external_turn_dispatcher', logger });
  const report = (type, turn, error) => operationalEvent(logger, type, { turnId: operationalId(turn.id), ownerModId: operationalId(turn.ownerModId), errorCode: infrastructureErrorCode(error, 'receipt_storage_failed') }, { level: 'error', component: 'mod-external-turn' });
  const controllers = new Map(), receipts = new Map();
  let retryTimer = null, closing = null;

  async function flushReceipt(id) {
    const receipt = receipts.get(id);
    if (!receipt) return null;
    receipt.writing ||= (async () => {
      try {
        const completed = await store.complete(id, receipt.patch);
        receipts.delete(id);
        return completed;
      } catch (error) {
        if (error?.message === 'mod_external_turn_receipt_fenced') receipts.delete(id);
        else if (!receipt.reported) {
          receipt.reported = true;
          report('mod_external_turn_receipt_persistence_failed', receipt.turn, error);
        }
        return null;
      }
    })().finally(() => { receipt.writing = null; });
    return receipt.writing;
  }
  async function flushReceipts() {
    for (const id of receipts.keys()) await flushReceipt(id);
  }
  function scheduleRetry() {
    if (retryTimer || lifecycle.stopped || !receipts.size) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!lifecycle.stopped) void lifecycle.track(flushReceipts, 'receipt_retry').finally(scheduleRetry).catch(() => {});
    }, Math.max(1, receiptRetryMs));
    retryTimer.unref?.();
  }
  async function persistReceipt(turn, patch) {
    receipts.set(turn.id, { turn, patch });
    const completed = await flushReceipt(turn.id);
    scheduleRetry();
    return completed;
  }

  async function run(turn) {
    const controller = controllers.get(turn.id);
    const dispatchSignal = AbortSignal.any([lifecycle.signal, controller.signal]);
    let signal = dispatchSignal;
    let activeRun = null;
    const cancellationError = () => lifecycle.stopped ? 'service_shutdown' : controller.signal.aborted ? 'cancelled_by_mod' : 'cancelled';
    const runId = createRunId({ sessionId: turn.sessionId, prefix: 'external' });
    let patch, claimedRunId = null;
    try {
      if (lifecycle.stopped) throw lifecycle.signal.reason;
      let claimed;
      try { claimed = await store.markRunning(turn.id, runId); }
      catch (error) {
        // The claim may have committed before acknowledgement. No turn has run.
        patch = { status: 'failed', error: 'agent_turn_failed', runId, allowQueued: true };
        report('mod_external_turn_receipt_claim_failed', turn, error);
        throw error;
      }
      if (!claimed) return;
      claimedRunId = runId;
      if (lifecycle.stopped) throw lifecycle.signal.reason;
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
        body: { message: turn.message, attachments: turn.attachments || [], sessionId: turn.sessionId, runId, abortSignal: signal, ...(selection ? { modelConnectionId: selection.connectionId, model: selection.model } : {}) },
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
      const attachments = await externalTurnOutputAttachments({ conversations: stores.conversations, agentWorkspaceRoot: agentRuntime.agentWorkspaceRoot, agentId: turn.agentId, sessionId: turn.sessionId, runId });
      const outcome = classifyRuntimeOutcome(result, { cancelled: signal.aborted });
      patch = {
        runId,
        status: signal.aborted ? 'interrupted' : outcome.ok ? 'succeeded' : 'failed',
        result: boundedResult(result, attachments),
        error: signal.aborted ? cancellationError() : outcome.ok ? null : 'agent_turn_failed',
      };
    } catch {
      patch ||= { runId: claimedRunId, status: signal.aborted ? 'interrupted' : 'failed', error: signal.aborted ? cancellationError() : 'agent_turn_failed' };
    } finally {
      try { if (patch) await persistReceipt(turn, patch); }
      finally {
        try { activeRun?.finish?.(); }
        finally { controllers.delete(turn.id); }
      }
    }
  }

  function launch(turn) {
    controllers.set(turn.id, new AbortController());
    void lifecycle.track(() => run(turn), 'dispatch').catch(() => {});
  }

  function stop(reason) { clearTimeout(retryTimer); retryTimer = null; lifecycle.stop(reason); }
  return Object.freeze({
    async replay(input) {
      if (typeof store.getByIdempotency !== 'function') return null;
      const turn = await store.getByIdempotency(input.ownerModId, input.idempotencyKey);
      if (!turn) return null;
      if (!sameExternalTurnInput(turn, input)) throw new Error('mod_external_turn_idempotency_conflict');
      return { turn: publicExternalTurn(await flushReceipt(turn.id) || turn), replayed: true };
    },
    async submit(input) {
      if (lifecycle.stopped) throw new Error('mod_external_turn_dispatcher_stopped');
      const created = await store.create(input);
      if (!created.replayed && created.turn.status === 'queued') {
        if (lifecycle.stopped) {
          const interrupted = await persistReceipt(created.turn, { status: 'interrupted', error: 'service_shutdown' });
          return { turn: publicExternalTurn(interrupted || created.turn), replayed: false };
        }
        launch(created.turn);
      }
      return { turn: publicExternalTurn((created.replayed && await flushReceipt(created.turn.id)) || created.turn), replayed: created.replayed };
    },
    async cancel(ownerModId, id) {
      const turn = await store.getOwned(ownerModId, id);
      if (!turn) return null;
      const controller = controllers.get(id);
      const cancellationRequested = Boolean(controller && !receipts.has(id) && !controller.signal.aborted && ['queued', 'running'].includes(turn.status));
      if (cancellationRequested) controller.abort(new Error('cancelled_by_mod'));
      return { turn: publicExternalTurn(turn), cancellationRequested };
    },
    async read(ownerModId, id) {
      const turn = await store.getOwned(ownerModId, id);
      return turn ? publicExternalTurn(await flushReceipt(id) || turn) : null;
    },
    async readAttachment(ownerModId, id, attachmentId) {
      const turn = await store.getOwned(ownerModId, id);
      if (!turn) throw new Error('mod_external_turn_not_found');
      // Durable receipt membership, not a caller-provided session/path, is authority.
      const descriptor = turn.result?.attachments?.find(item => item.id === attachmentId);
      if (!descriptor) throw new Error('mod_external_turn_attachment_not_found');
      const runtime = await resolveAgentRuntime(turn.agentId);
      const result = await readExternalTurnOutputAttachment({ agentWorkspaceRoot: runtime.agentWorkspaceRoot, descriptor });
      if (!result) throw new Error('mod_external_turn_attachment_not_found');
      return result;
    },
    stop,
    close(reason) { stop(reason); return closing ||= lifecycle.close(reason).then(flushReceipts); },
    health: () => ({ ...lifecycle.health(), terminalReceipts: receipts.size }),
    pendingCount: () => lifecycle.health().pending,
  });
}
