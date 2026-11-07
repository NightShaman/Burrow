import { performance } from 'node:perf_hooks';
import { chatResultMetadata } from '../../src/chat-result-metadata.mjs';
import { createChatStreamDelta } from '../../src/chat-stream-delta.mjs';
import { applyModelRecoveryProgress, modelRecoveryProgress } from '../../src/model-recovery-projection.mjs';
import { beginSessionAdmissionSupersession, finishSessionAdmissionSupersession, serializeSessionAdmission } from '../../src/session-admission.mjs';
import { beginRuntimeSessionExecutionSupersession, finishRuntimeSessionExecutionSupersession, chatTurnInputFromBody, createChatTurnRunId, chatTurnResponse, chatTurnProgressResponse, chatTurnErrorResponse } from '../../src/chat-turn-controller.mjs';
import { coreApiCaller } from '../../src/core-api-dispatch.mjs';
import { activeChatRunKey, activeChatRunSummary, activeChatRunSummaries, cancelActiveChatRun, registerActiveAgentRun } from '../../src/active-chat-runs.mjs';
import { chatCommandHelpText, chatCommandResponse, parseChatCommand } from '../../src/chat-commands.mjs';
import { conversationAuthority as conversationAuthorityDefault } from '../../src/conversation-authority.mjs';
import { buildSessionEntry as buildSessionEntryDefault } from '../../src/session-entry.mjs';
import { runSessionCompression as runSessionCompressionDefault } from '../../src/session-compression.mjs';
import { postgresContinuity as postgresContinuityDefault } from '../../src/postgres-continuity.mjs';
import { resolveRuntimeTracePath as resolveTracePathDefault } from '../../src/config.mjs';
import { createTraceLogger as createTraceLoggerDefault } from '../../src/trace-logger.mjs';
import { toolActivityPresentation } from '../../src/tool-activity-labels.mjs';
import { observeModelRecovery } from '../../src/http-operational-log.mjs';
import { projectSubagentTree as projectSubagentTreeDefault, sessionMinionAncestry as sessionMinionAncestryDefault } from '../../src/subagent-projection.mjs';

/**
 * Owns the in-process HTTP chat session authority: per-agent/session HTTP
 * admission, active HTTP and nested runs, latest-run continuity projection,
 * reset barriers, cancellation, steering and HTTP response orchestration.
 *
 * Dependencies are grouped by authority rather than passed as positional
 * callbacks. `activeChatRuns` is returned as the same Map used by all external
 * registry consumers; callers must not create a parallel active-run registry.
 */
export function publicChatProgress(record = {}) {
  if (record.type === 'model-recovery') return modelRecoveryProgress(record);
  const payload = record.payload || {};
  if (['context-compaction-started', 'context-compaction-completed', 'context-compaction-failed'].includes(record.type)) {
    return { type: record.type.replace('context-compaction-', 'context.compaction.'), data: {
      reason: payload.reason || null, compressed: payload.compressed === true,
      ...(payload.error ? { error: String(payload.error).slice(0, 1000) } : {}),
    } };
  }
  if (record.type === 'router' && payload.stage === 'ask-chat-turn') {
    return { type: 'route.decided', data: { routeKind: payload.route?.kind || null, sessionKind: payload.runtimeTurn?.envelope?.route?.kind || null } };
  }
  if (record.type === 'provider-dispatched') {
    return { type: 'model.dispatched', data: { requestId: payload.requestId, modelCall: payload.modelCall || null, provider: payload.provider, api: payload.api, model: payload.model, invokedAt: payload.invokedAt, monotonicMs: payload.monotonicMs, clockDomain: payload.clockDomain, boundary: 'local-fetch-invocation', providerAcceptance: 'unknown' } };
  }
  if (record.type === 'model' && payload.stage === 'model-request') {
    return { type: 'model.started', data: { provider: payload.provider || null, api: payload.api || null, model: payload.model || null, toolCount: Number(payload.toolCount || 0) } };
  }
  if (record.type === 'model' && payload.stage === 'model-response') {
    return { type: 'model.completed', data: { status: payload.status ?? null, ok: payload.ok === true, finishReason: payload.finishReason || null, responseChars: Number(payload.responseChars || 0) } };
  }
  if (record.type === 'tool') {
    const presentation = toolActivityPresentation(payload) || {};
    return {
      type: payload.phase === 'start' ? 'tool.started' : 'tool.completed',
      data: {
        tool: payload.tool || null,
        rawTool: payload.tool || null,
        provider: payload.provider || null,
        mcpToolName: payload.mcpToolName || null,
        skillId: payload.skillId || null,
        skillName: payload.skillName || null,
        activityId: payload.activityId || null,
        ok: payload.ok ?? null,
        status: payload.status || null,
        childSessionId: payload.childSessionId || null,
        ...presentation,
        command: payload.command || null,
        cwd: payload.cwd || null,
        filePath: payload.filePath || payload.path || null,
        dirPath: payload.dirPath || null,
        query: payload.query || payload.pattern || null,
        reason: payload.reason || null,
        error: payload.error || null,
      },
    };
  }
  if (record.type === 'verifier') return { type: 'verification.completed', data: { ok: payload.ok ?? null, required: payload.required ?? null, status: payload.status || null } };
  if (record.type === 'chat-tool-loop-warning' || record.type === 'chat-tool-loop-blocked') return { type: 'runtime.notice', data: { notice: record.type } };
  return null;
}

export function createChatSessionService({ runtime, http, commands, sessions, observability = {}, runPolicy = {} } = {}) {
  if (!runtime || !http || !commands || !sessions) throw new TypeError('chat_session_service_dependencies_required');
  const {
    projectRoot, postgresApplication, requestLifecycle, resolveAgentRuntime,
    resolveModelConnectionChatBody, runChatTurnFromBody, serializeSessionExecution,
    telemetry: otelRuntime, logger: serverLogger, getCompletionDispatch = () => null,
    postgresContinuity = postgresContinuityDefault, registerActiveAgentRun: registerActiveAgentRunImpl = registerActiveAgentRun, cancelActiveChatRun: cancelActiveChatRunImpl = cancelActiveChatRun,
    createChatTurnRunId: createChatTurnRunIdImpl = createChatTurnRunId,
    retireCancelledRun: retireCancelledRunImpl = null,
    cancellationGraceMs: RUN_CANCELLATION_GRACE_MS = 5_000,
  } = runtime;
  let chatInputRunner = runtime.chatInputRunner || null;
  const {
    readJsonBody, validateBoundaryBody, sendJson, correlateHttpRun, recordHttpFailure,
    observeHttpResult, observeHttpRunEvent,
  } = http;
  const {
    runtimeConfig, activeConversationLimits, inspectSessionContextStatus,
    latestProviderRequest = null, contextReport = null,
    resolveRuntimeTracePath = resolveTracePathDefault,
    conversationAuthority = conversationAuthorityDefault, buildSessionEntry = buildSessionEntryDefault,
    runSessionCompression = runSessionCompressionDefault, createTraceLogger = createTraceLoggerDefault,
    commandText, contextMeterLines,
  } = commands;
  const {
    sessionWriteHandoff, archiveSummaryForReset,
  } = sessions;
  const { onActiveRunRemoved = null } = runPolicy;
  const {
    agentsStore, resolveAgentContext, listSubagentSummaries, readMinionSettings, metadataStore,
    projectSubagentTree = projectSubagentTreeDefault, sessionMinionAncestry = sessionMinionAncestryDefault,
  } = observability;

  const activeChatRuns = new class extends Map {
    delete(key) {
      const removed = super.delete(key);
      if (removed) queueMicrotask(() => onActiveRunRemoved?.());
      return removed;
    }
  }();
  const sessionContinuityHeads = new Map();
  // HTTP admission/reset lives here; runtime's independently serialized lane
  // remains a separate cross-producer authority owned by app-runtime.
  const sessionChatQueues = new Map();
  function sessionChatQueueKey(agentId, sessionId) { return `${String(agentId)}:${String(sessionId || 'default')}`; }
  async function serializeSessionChat({ agentId, sessionId, operation, signal, onCancellationDeadline = null }) {
    const key = sessionChatQueueKey(agentId, sessionId);
    const cancellationGraceMs = typeof RUN_CANCELLATION_GRACE_MS === 'number' ? RUN_CANCELLATION_GRACE_MS : 10_000;
    return serializeSessionAdmission(sessionChatQueues, key, operation, signal, { cancellationGraceMs, onCancellationDeadline });
  }

function acceptsNdjson(req) {
  return String(req.headers.accept || '').toLowerCase().split(',').some((value) => value.trim().split(';')[0] === 'application/x-ndjson');
}

function beginNdjson(res) {
  res.writeHead(200, {
    'content-type': 'application/x-ndjson; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
  });
}

function writeNdjson(res, event, options) {
  observeHttpRunEvent(res, event, options);
  if (res.writableEnded || res.destroyed) return;
  res.write(`${JSON.stringify(event)}\n`);
}

// This is deliberately a narrow public projection of persisted trace records.
// Prompts, headers, tool arguments/results, and model/provider internals stay
// in trace evidence; the progress stream exposes only operational state.
function registerRuntimeActiveRun(options) {
  const lifecycle = registerActiveAgentRunImpl(activeChatRuns, { ...options, logger: serverLogger || null });
  lifecycle.cancellationGraceMs = RUN_CANCELLATION_GRACE_MS;
  lifecycle.onCancellationDeadline = options.lane === 'side_question' ? null : () => retireCancelledRun(lifecycle.record);
  return lifecycle;
}

async function retireCancelledRun(record, { recovery = record?.source === 'recovery' } = {}) {
  if (!record?.agentId || !record?.sessionId || !record?.runId) return { ok: false, stale: true };
  const authority = postgresContinuity({ store: postgresApplication.stores.conversations, agentId: record.agentId });
  const retired = await (retireCancelledRunImpl || (value => authority.retire(value)))({
    sessionId: record.sessionId,
    runId: record.runId,
    generation: Number.isSafeInteger(record.generation) ? record.generation : null,
    reason: String(record.reason || 'cancellation_deadline_exceeded'),
    objective: record.objective || record.latestUserMessage || null,
    recovery,
  });
  const key = activeChatRunKey(record.agentId, record.runId);
  if (retired.ok && activeChatRuns.get(key) === record) activeChatRuns.delete(key);
  return retired;
}

function sessionContinuityHeadKey(agentId, sessionId) {
  return `${String(agentId)}:${String(sessionId || 'default')}`;
}
async function handleChatCommand({ parsed, sessionId, agentRuntime, runId = null, onProgress = null, signal = null } = {}) {
  if (parsed?.error) return { status: 400, response: chatCommandResponse({ command: null, sessionId, text: `Invalid command.\n\n${chatCommandHelpText()}`, receipt: { error: parsed.error }, ok: false }) };
  if (!parsed?.definition) return { status: 400, response: chatCommandResponse({ command: parsed?.command || null, sessionId, text: `Unknown command: /${parsed?.command || ''}\n\n${chatCommandHelpText()}`, receipt: { error: 'command_unknown' }, ok: false }) };
  if (parsed.args && !(parsed.command === 'context' && parsed.args === 'full')) return { status: 400, response: chatCommandResponse({ command: parsed.command, sessionId, text: `${parsed.definition.usage} does not accept arguments.`, receipt: { error: 'command_arguments_not_supported' }, ok: false }) };
  if (parsed.command === 'help') return { status: 200, response: chatCommandResponse({ command: 'help', sessionId, text: chatCommandHelpText(), receipt: { available: ['help', 'context', 'compact', 'status', 'new', 'stop'] } }) };
  if (parsed.command === 'new') {
    const resetBarrier = await beginSessionAdmissionsReset({ agentId: agentRuntime.agentId, sessionId });
    try {
      const supersededRuns = await supersedeSessionRuns({ agentId: agentRuntime.agentId, sessionId, reason: 'superseded by /new' });
      const active = supersededRuns[0] || null;
      await sessionWriteHandoff({ agentId: agentRuntime.agentId, sessionId, title: `Boundary checkpoint before new conversation: ${sessionId}`, runId: `session-reset-${Date.now()}`, message: `Preserve the useful state from session ${sessionId} before starting a new conversation.` });
      const reset = await postgresApplication.stores.conversations.reset({ agentId: agentRuntime.agentId, sessionId });
      void archiveSummaryForReset({ agentId: agentRuntime.agentId, rootDir: agentRuntime.agentWorkspaceRoot, sessionId, archiveId: reset.archiveId, archivedPath: reset.archivedPath }).catch(() => {});
      return { status: 200, response: chatCommandResponse({ command: 'new', sessionId, text: 'Started a fresh conversation. Prior history was archived; it was not deleted.', receipt: { conversationId: reset.conversationId, archivedPath: reset.archivedPath || null, resetAt: reset.resetAt || reset.metadata?.resetAt || null, ...(reset.archiveId ? { archiveId: reset.archiveId } : {}), ...(active ? { cancelledRunId: active.runId } : {}) } }) };
    } finally { finishSessionAdmissionsReset(resetBarrier); }
  }
  if (parsed.command === 'stop') {
    // Signal first. Compaction/feedback may own the very row lock (or last
    // pool connection) needed by the durable queue hold below.
    chatInputRunner.cancelSession({ agentId:agentRuntime.agentId, sessionId, mainOnly:true });
    const matchingRuns = [...activeChatRuns.values()].filter((run) => run.agentId === agentRuntime.agentId && run.sessionId === sessionId && run.lane !== 'side_question');
    const active = matchingRuns.find((run) => !run.controller.signal.aborted) || matchingRuns.at(-1) || null;
    if (active && !active.controller.signal.aborted) {
      const cancelled = await cancelChatRun(active.runId, { reason: 'stopped by /stop' }, agentRuntime);
      return { status: 200, response: chatCommandResponse({ command: 'stop', sessionId, text: `Stopped active run ${active.runId}.`, receipt: cancelled }) };
    }
    await postgresApplication.stores.chatInputs.holdSession({ agentId:agentRuntime.agentId, sessionId });
    if (!active) return { status: 200, response: chatCommandResponse({ command: 'stop', sessionId, text: 'No active run in this session.', receipt: { status: 'idle' } }) };
    return { status: 200, response: chatCommandResponse({ command: 'stop', sessionId, text: `Run ${active.runId} is already cancelling.`, receipt: { status: 'cancelling', runId: active.runId, agentId: active.agentId, sessionId: active.sessionId, reason: active.reason || null } }) };
  }
  if (parsed.command === 'compact') {
    runId ||= createChatTurnRunId({ sessionId, prefix: 'compact' });
    const lifecycle = { reason: 'manual', compressed: false };
    signal?.throwIfAborted();
    await onProgress?.({ type: 'context.compaction.started', data: lifecycle });
    signal?.throwIfAborted();
    const authority = conversationAuthority({ store: postgresApplication.stores.conversations, agentId: agentRuntime.agentId });
    const metadata = await authority.metadata(sessionId, { signal });
    signal?.throwIfAborted();
    const expectedGeneration = Number(metadata?.generation || 0);
    let logger;
    let receipt;
    let text;
    let ok = true;
    try {
      const runtime = await runtimeConfig(agentRuntime.agentId);
      const traceRoot = resolveRuntimeTracePath({ ...runtime.runtimeState, agentId: agentRuntime.agentId, sessionId });
      logger = createTraceLogger({ rootDir: traceRoot, runId, sessionId });
      const result = await runSessionCompression({ rootDir: agentRuntime.agentWorkspaceRoot, sessionId, config: runtime.contextConfig, force: true, stores: postgresApplication.stores, agentId: agentRuntime.agentId, logger, expectedGeneration, signal });
      signal?.throwIfAborted();
      receipt = { reason: result.reason, compressed: Boolean(result.compressed) };
      text = result.compressed ? 'Conversation context compacted. Original history remains archived.' : `No compaction performed: ${result.reason}.`;
    } catch (error) {
      signal?.throwIfAborted();
      receipt = { ...lifecycle, error: error?.message || String(error) };
      text = `Compaction failed: ${receipt.error}`;
      ok = false;
    } finally {
      await logger?.terminal?.();
    }
    // Append to the successor transcript after compaction, not the generation
    // it may archive. Command feedback is visible history, never model input.
    // Keep persistence outside the compression catch: a storage failure must
    // not publish a terminal receipt claiming feedback was saved.
    signal?.throwIfAborted();
    // Both feedback turns share a single locked generation check and commit.
    // Reading metadata after rotation would accidentally adopt a concurrent /new.
    await postgresApplication.stores.conversations.appendBatchIfGeneration({
      agentId: agentRuntime.agentId, sessionId,
      expectedGeneration: expectedGeneration + (receipt.compressed ? 1 : 0), signal,
      entries: [['user', '/compact'], ['assistant', text]].map(([role, content]) => ({
        entry: buildSessionEntry({ sessionId, runId, role, content, type: 'message', visibility: 'chat', entersPrompt: false,
          metadata: { command: 'compact', commandReceipt: receipt, ok } }),
        idempotencyKey: `command:compact:${runId}:${role}`,
      })),
    });
    signal?.throwIfAborted();
    const response = chatCommandResponse({ command: 'compact', sessionId, text, receipt, ok });
    response.result.runId = runId;
    await onProgress?.({ type: ok ? 'context.compaction.completed' : 'context.compaction.failed', data: receipt });
    return { status: ok ? 200 : 500, response };
  }
  const runtime = await runtimeConfig(agentRuntime.agentId);
  const limits = activeConversationLimits({ modelConfig: runtime.modelConfig, contextConfig: runtime.contextConfig });
  const matchingRuns = [...activeChatRuns.values()].filter((run) => run.agentId === agentRuntime.agentId && run.sessionId === sessionId && run.lane !== 'side_question');
  const active = matchingRuns.find((run) => !run.controller.signal.aborted) || matchingRuns.at(-1) || null;
  const status = await inspectSessionContextStatus({ stores: postgresApplication.stores, agentId: agentRuntime.agentId, rootDir: projectRoot, dataRoot: agentRuntime.agentWorkspaceRoot, sessionId, limits, contextConfig: runtime.contextConfig, contextWindow: runtime.modelConfig?.contextWindow, contextTokens: runtime.modelConfig?.contextTokens, liveContext: active?.contextUsage || null });
  const context = status.context || {};
  if (parsed.command === 'context') {
    const traceSessionRoot = resolveRuntimeTracePath({ cacheRoot: runtime.runtimeState.cacheRoot, workspaceRoot: runtime.runtimeState.workspaceRoot, agentId: agentRuntime.agentId, sessionId });
    const request = await latestProviderRequest({ traceSessionRoot, sessionId, runId: context.runId || null, requestId: context.requestId || null });
    if (!request) return { status: 404, response: chatCommandResponse({ command: 'context', sessionId, text: 'No captured provider request is available for this session meter. Send a message first; older requests may predate request capture. Current settings have not been substituted for missing captured context.', receipt: { error: 'provider_request_unavailable', runId: context.runId || null, requestId: context.requestId || null }, ok: false }) };
    const full = parsed.args === 'full';
    const presentation = contextReport({ request, agentRuntime, sessionId, status, full });
    const response = chatCommandResponse({ command: 'context', sessionId, text: presentation.text, receipt: { mode: full ? 'full' : 'overview', runId: request.runId, sentAt: request.ts, requestId: request.payload?.requestId || null, messageCount: request.payload?.messageCount ?? null, promptChars: request.payload?.promptChars ?? null, estimatedTokens: context.requestId === request.payload?.requestId ? context.estimatedTokens ?? null : null, capacityTokens: context.capacityTokens ?? null } });
    response.result.contextReport = presentation.report;
    return { status: 200, response };
  }
  return { status: 200, response: chatCommandResponse({ command: 'status', sessionId, text: commandText('Status', [['Agent', agentRuntime.agentId], ['Session', sessionId], ['Model', runtime.modelConfig?.model || 'unconfigured'], ['Model configured', Boolean(runtime.modelConfig?.model)], ['Run', active ? `${active.runId} (${active.phase})` : 'idle'], ...contextMeterLines(context, status.compaction, { source: status.recall?.used ? 'session recall' : 'none' })]), receipt: { agentId: agentRuntime.agentId, model: runtime.modelConfig?.model || null, modelConfigured: Boolean(runtime.modelConfig?.model), activeRun: active ? activeChatRunSummary(active) : null, context, compaction: { active: Boolean(status.compaction?.active), next: status.compaction?.next || null }, memory: { source: status.recall?.used ? 'session recall' : 'none' } } }) };
}
async function handleChat(req, res) {
  const latencyTiming = { ingressMs: performance.now(), ingressAt: new Date().toISOString() };
  const body = validateBoundaryBody('chat', await readJsonBody(req));
  let agentRuntime;
  try {
    agentRuntime = await resolveAgentRuntime(body.agentId);
  } catch (error) {
    return sendJson(res, error?.statusCode || 500, { ok: false, error: String(error?.message || error) });
  }
  const sessionId = String(body.sessionId || 'default');
  // Cancellation, reset, and read-only status must reach the active turn, not
  // wait for that turn to finish. Mutating ordinary chat remains serialized
  // within the current session generation.
  if (['stop', 'new', 'status'].includes(parseChatCommand(body.message)?.command)) {
    return handleSerializedChat({ req, res, body, agentRuntime, sessionId });
  }
  const busy = [...activeChatRuns.values()].some(run => run.agentId === agentRuntime.agentId && run.sessionId === sessionId && run.lane !== 'side_question');
  const pending = await postgresApplication.stores.chatInputs.list({ agentId: agentRuntime.agentId, sessionId });
  if (busy || pending.inputs.some(input => input.intent === 'queue_next' && ['queued','held','running'].includes(input.status))) {
    return sendJson(res, 409, { ok:false, error:'chat_session_busy_use_explicit_intent' });
  }
  const admission = new AbortController();
  const disconnected = () => admission.abort(new Error('chat_admission_disconnected'));
  res.once('close', disconnected);
  req.once('aborted', disconnected);
  if (req.aborted || res.destroyed) disconnected();
  latencyTiming.httpQueuedMs = performance.now();
  try {
    return await serializeSessionChat({ agentId: agentRuntime.agentId, sessionId, signal: admission.signal, operation: async () => {
      const waiting = await postgresApplication.stores.chatInputs.list({ agentId: agentRuntime.agentId, sessionId });
      if (waiting.inputs.some(input => input.intent === 'queue_next' && ['queued','held','running'].includes(input.status))) return sendJson(res,409,{ok:false,error:'chat_session_busy_use_explicit_intent'});
      latencyTiming.httpAdmittedMs = performance.now();
      // After admission preserve the existing detached-run policy.
      res.removeListener('close', disconnected);
      req.removeListener('aborted', disconnected);
      return handleSerializedChat({ req, res, body, agentRuntime, sessionId, latencyTiming });
    } });
  } catch (error) {
    if (!admission.signal.aborted) throw error;
  } finally {
    res.removeListener('close', disconnected);
    req.removeListener('aborted', disconnected);
    void chatInputRunner.wake().catch(() => {});
  }
}
async function handleSerializedChat({ req, res, body, agentRuntime, sessionId, latencyTiming = null }) {
  if (typeof requestLifecycle !== 'undefined') requestLifecycle.signal.throwIfAborted();
  const streaming = acceptsNdjson(req);
  const command = parseChatCommand(body.message);
  if (command) {
    const runId = body.runId ? String(body.runId) : createChatTurnRunIdImpl({ sessionId, prefix: 'command' });
    correlateHttpRun(res, { runId, sessionId, agentId: agentRuntime.agentId });
    // Manual compaction is real session work, not an invisible command.
    // Register before waiting for the shared runtime lane so Stop can cancel
    // even a compact blocked behind another producer.
    const manualCompact = command.command === 'compact' && command.definition && !command.args && !command.error;
    const owner = manualCompact ? registerActiveAgentRun(activeChatRuns, {
      agentId: agentRuntime.agentId, sessionId, runId, message: '/compact', source: coreApiCaller(req) ? 'backdoor-api' : 'operator-chat',
    }) : null;
    if (owner) { owner.record.phase = 'compacting'; owner.record.detached = false; }
    const detached = () => { if (owner && !res.writableEnded) owner.record.detached = true; };
    if (owner) req.on('close', detached);
    try {
      if (streaming) beginNdjson(res);
      const onProgress = streaming ? (event) => writeNdjson(res, { ...event, runId, sessionId, ts: new Date().toISOString() }) : null;
      const operation = () => handleChatCommand({ parsed: command, sessionId, agentRuntime, runId, onProgress, signal: owner?.signal });
      const result = owner
        ? await serializeSessionExecution({ rootDir: projectRoot, sessionId, agentRuntime, args: { abort_signal: owner.signal } }, operation)
        : await operation();
      owner?.signal.throwIfAborted();
      if (streaming) {
        writeNdjson(res, { type: result.response.ok ? 'run.completed' : 'run.failed', runId, sessionId, ts: new Date().toISOString(), data: { response: { ...result.response, result: { ...result.response.result, runId } } } }, { status: result.status });
        return res.end();
      }
      return sendJson(res, result.status, result.response);
    } catch (error) {
      if (owner?.signal.aborted) {
        const response = { ...chatResultMetadata({ ok: false, decision: 'cancelled' }), ok: false, error: String(owner.record.reason || error?.message || 'agent_stopped'), runId };
        if (streaming) { writeNdjson(res, { type: 'run.cancelled', runId, sessionId, ts: new Date().toISOString(), data: { response } }); return res.end(); }
        return sendJson(res, 499, response);
      }
      const expected = chatTurnErrorResponse(error);
      if (!expected) recordHttpFailure(res, { error, status: 500, event: 'run_failed', errorCode: 'chat_command_failed' });
      throw error;
    } finally {
      if (owner) { req.removeListener('close', detached); owner.finish(); }
    }
  }
  const runId = body.runId ? String(body.runId) : createChatTurnRunIdImpl({ sessionId, prefix: 'ui' });
  correlateHttpRun(res, { runId, sessionId, agentId: agentRuntime.agentId });
  if (activeChatRuns.has(activeChatRunKey(agentRuntime.agentId, runId))) throw Object.assign(new Error('chat_run_id_already_used'), { statusCode: 409 });
  const controller = new AbortController();
  getCompletionDispatch()?.trackHttp(agentRuntime.agentId, runId, res, { sessionId, source: coreApiCaller(req) ? 'backdoor-api' : 'operator-chat', startedAt: new Date().toISOString() });
  const record = { agentId: agentRuntime.agentId, runId, sessionId, controller, startedAt: new Date().toISOString(), phase: 'thinking', latestUserMessage: String(body.message || '').trim().slice(0, 16_000), objective: String(body.message || '').trim().slice(0, 16_000), progress: [], contextUsage: null, cancelled: false, reason: null, detached: false, steeringReady: false };
  const headKey = sessionContinuityHeadKey(agentRuntime.agentId, sessionId);
  sessionContinuityHeads.set(headKey, record);
  activeChatRuns.set(activeChatRunKey(agentRuntime.agentId, runId), record);
  if (streaming) {
    beginNdjson(res);
    writeNdjson(res, { type: 'run.started', runId, sessionId, ts: record.startedAt, data: { command: 'chat' } });
  }
  req.on('close', () => {
    if (!res.writableEnded && !controller.signal.aborted) record.detached = true;
  });
  const emitTextDelta = streaming ? createChatStreamDelta({ record, type: 'assistant.delta', runId, sessionId, write: (event) => writeNdjson(res, event) }) : null;
  const emitThoughtDelta = streaming ? createChatStreamDelta({ record, type: 'assistant.thought', runId, sessionId, write: (event) => writeNdjson(res, event) }) : null;
  try {
    const chatBody = await resolveModelConnectionChatBody(body);
    const result = await runChatTurnFromBody({
      body: { ...chatBody, runId, abortSignal: controller.signal },
      rootDir: projectRoot,
      agentRuntime,
      stores: postgresApplication.stores,
      resolveAgentRuntime,
      latencyTiming,
      telemetry: otelRuntime,
      runSource: coreApiCaller(req) ? 'backdoor-api' : 'operator-chat',
      cancellationGraceMs: RUN_CANCELLATION_GRACE_MS,
      onCancellationDeadline: () => retireCancelledRun(record),
      registerNestedAgentRun: ({ agentRuntime: nestedRuntime, sessionId: nestedSessionId, runId: nestedRunId, message, source, ...a2a }) => registerRuntimeActiveRun({ agentId: nestedRuntime.agentId, sessionId: nestedSessionId, runId: nestedRunId, message, source, a2a: source === 'a2a' ? a2a : null }),
      onTraceRecord: (traceRecord) => {
        // Capture runtime-owned span correlation while the run is still active.
        correlateHttpRun(res, { traceContext: otelRuntime.traceContextForRun?.(runId) });
        const progress = publicChatProgress(traceRecord);
        if (progress) {
          const event = { ...progress, runId, sessionId, ts: traceRecord.ts || new Date().toISOString() };
          record.progress = [...record.progress, event].slice(-50);
          if (progress.type === 'model.recovery') observeModelRecovery(serverLogger, traceRecord, record);
          if (!applyModelRecoveryProgress(record, progress)) {
            if (controller.signal.aborted || record.phase === 'cancelling') record.phase = 'cancelling';
            else {
              if (progress.type === 'context.compaction.started') record.phase = 'compacting';
              if (['context.compaction.completed', 'context.compaction.failed', 'model.started'].includes(progress.type)) record.phase = 'thinking';
            }
          }
          if (streaming) writeNdjson(res, event);
        }
      },
      onModelTextDelta: streaming ? (delta) => { if (controller.signal.aborted || record.phase === 'cancelling') { record.phase = 'cancelling'; return; } emitTextDelta(delta); } : null,
      onModelThoughtDelta: streaming ? (delta) => { if (controller.signal.aborted || record.phase === 'cancelling') { record.phase = 'cancelling'; return; } emitThoughtDelta(delta); } : null,
      onSteeringReady: () => { record.steeringReady = !controller.signal.aborted && record.phase !== 'cancelling'; },
      onModelContextUsage: async (usage) => {
        if (!usage || typeof usage !== 'object') return;
        // Each update is scoped to one physical request; never carry a previous
        // response or run maximum into the next request estimate.
        record.contextUsage = { ...usage, runId };
        try {
          await postgresApplication.stores.conversations.append({
            agentId: agentRuntime.agentId,
            sessionId,
            entry: {
            sessionId,
            type: 'event',
            role: null,
            content: 'Latest provider request context measurement updated.',
            runId,
            metadata: { contextMeter: record.contextUsage },
            visibility: 'debug',
            entersPrompt: false,
            },
          });
        } catch {
          // Meter persistence is observational; it must never interrupt a run.
        }
      },
    });
    if (sessionContinuityHeads.get(headKey) !== record) {
      const response = { ...chatResultMetadata({ ok: false, decision: 'superseded' }), ok: false, decision: 'superseded', runId, sessionId, blockers: ['superseded_by_newer_session_run'] };
      if (streaming) { writeNdjson(res, { type: 'run.superseded', runId, sessionId, ts: new Date().toISOString(), data: { response } }); return res.end(); }
      return sendJson(res, 409, response);
    }
    correlateHttpRun(res, { cancelled: controller.signal.aborted });
    // An abort-ignoring attempt can still settle with a result. Stop owns the
    // public terminal; do not turn that late settlement into a completed run.
    if (controller.signal.aborted) {
      const response = chatTurnProgressResponse({ ...result, decision: 'cancelled', answerText: null }, { ok: false });
      if (streaming) { writeNdjson(res, { type: 'run.cancelled', runId, sessionId, ts: new Date().toISOString(), data: { response } }); return res.end(); }
      return sendJson(res, 499, response);
    }
    // Observe the internal result before the stream's intentionally narrow
    // response drops model status/codes. This never serializes model payloads.
    observeHttpResult(res, 200, { ok: result.ok, result }, { event: 'run_failed' });
    const response = chatTurnResponse(result, { ok: result.ok });
    const streamResponse = chatTurnProgressResponse(result, { ok: result.ok });
    if (streaming) { writeNdjson(res, { type: `run.${streamResponse.result.terminalStatus}`, runId, sessionId, ts: new Date().toISOString(), data: { response: streamResponse } }); return res.end(); }
    return sendJson(res, 200, response);
  } catch (error) {
    if (controller.signal.aborted) {
      const response = { ...chatResultMetadata({ ok: false, decision: 'cancelled' }), ok: false, error: String(record.reason || error?.message || 'agent_stopped'), runId };
      if (streaming) { writeNdjson(res, { type: 'run.cancelled', runId, sessionId, ts: new Date().toISOString(), data: { response } }); return res.end(); }
      return sendJson(res, 499, response);
    }
    const errorResponse = chatTurnErrorResponse(error);
    if (errorResponse) {
      if (streaming) { writeNdjson(res, { type: 'run.failed', runId, sessionId, ts: new Date().toISOString(), data: { response: { ...errorResponse.body, ...chatResultMetadata({ ok: false, decision: 'failed' }) } } }, { status: errorResponse.status }); return res.end(); }
      return sendJson(res, errorResponse.status, { ...errorResponse.body, ...chatResultMetadata({ ok: false, decision: 'failed' }) });
    }
    recordHttpFailure(res, { error, status: 500, event: 'run_failed', errorCode: 'chat_run_failed' });
    if (streaming) { writeNdjson(res, { type: 'run.failed', runId, sessionId, ts: new Date().toISOString(), data: { response: { ...chatResultMetadata({ ok: false, decision: 'failed' }), ok: false, error: String(error?.message || error), runId } } }); return res.end(); }
    throw error;
  } finally {
    if (activeChatRuns.get(activeChatRunKey(agentRuntime.agentId, runId)) === record) activeChatRuns.delete(activeChatRunKey(agentRuntime.agentId, runId));
  }
}
async function cancelChatRun(runId, body = {}, agentRuntime = null) {
  const requestedAgentId = agentRuntime?.agentId || body.agentId;
  const matches = [...activeChatRuns.values()].filter(run => run.runId===runId);
  const record = requestedAgentId ? activeChatRuns.get(activeChatRunKey(requestedAgentId,runId)) : matches.length===1 ? matches[0] : null;
  const cancelled = cancelActiveChatRunImpl(activeChatRuns, runId, { body, agentId: agentRuntime?.agentId || null });
  if (record && record.lane !== 'side_question') {
    chatInputRunner.cancelSession({ ...record, mainOnly: true });
    await postgresApplication.stores.chatInputs.holdSession(record);
  }
  return cancelled;
}

async function supersedeSessionRuns({ agentId, sessionId, reason = 'superseded by session reset' } = {}) {
  const matches = [...activeChatRuns.values()].filter((run) => run.agentId === agentId && run.sessionId === sessionId);
  const superseded = [];
  for (const run of matches) {
    sessionContinuityHeads.delete(sessionContinuityHeadKey(agentId, sessionId));
    const result = cancelActiveChatRunImpl(activeChatRuns, run.runId, { body: { reason }, agentId });
    if (result.ok && result.cancelledRuns.length) superseded.push(...result.cancelledRuns);
    else if (run.controller.signal.aborted) superseded.push({ runId: run.runId, agentId: run.agentId, sessionId: run.sessionId });
    // Reset supersedes this display/dispatch identity. Durable reset fences its
    // old writes; an abort-ignoring provider must not block the fresh generation.
    activeChatRuns.delete(activeChatRunKey(run.agentId,run.runId));
  }
  return superseded.filter((run, index, all) => all.findIndex((candidate) => candidate.agentId === run.agentId && candidate.runId === run.runId) === index);
}

async function beginSessionAdmissionsReset({ agentId, sessionId } = {}) {
  const agentRuntime = await resolveAgentRuntime(agentId);
  const http = beginSessionAdmissionSupersession(sessionChatQueues, sessionChatQueueKey(agentId, sessionId));
  try {
    const runtime = beginRuntimeSessionExecutionSupersession({ rootDir: projectRoot, sessionId, agentRuntime });
    try {
      // The reset barriers already exclude successors. Signal current owners
      // before waiting for durable queue/reset rows they may themselves hold.
      for (const record of activeChatRuns.values()) {
        if (record.agentId === agentId && record.sessionId === sessionId) {
          cancelActiveChatRunImpl(activeChatRuns, record.runId, { body: { reason: 'superseded by session reset' }, agentId });
        }
      }
      chatInputRunner.cancelSession({ agentId, sessionId });
      await postgresApplication.stores.chatInputs.cancelGeneration({ agentId, sessionId });
      return { http, runtime };
    } catch(error) { finishRuntimeSessionExecutionSupersession(runtime); throw error; }
  } catch (error) {
    finishSessionAdmissionSupersession(http);
    throw error;
  }
}

function finishSessionAdmissionsReset(tokens = {}) {
  finishRuntimeSessionExecutionSupersession(tokens.runtime);
  finishSessionAdmissionSupersession(tokens.http);
}
async function steerChatRun(runId, body, agentRuntime) {
  if (!agentRuntime) throw Object.assign(new Error('agent_id_required'),{statusCode:400});
  const input = chatTurnInputFromBody({ body });
  const identity = { agentId: agentRuntime.agentId, sessionId: input.sessionId, runId };
  const record = activeChatRuns.get(activeChatRunKey(identity.agentId, runId));
  if (record && (record.sessionId !== input.sessionId || record.lane === 'side_question')) throw Object.assign(new Error('chat_run_not_found'),{statusCode:404});
  // Stop closes acceptance even while the provider is unwinding.
  if (!record || record.controller.signal.aborted) await postgresApplication.stores.steering.boundary(identity, { finish: true });
  if (body.promotedFrom) {
    const side = await postgresApplication.stores.chatInputs.get({ ...identity, id: body.promotedFrom });
    if (!side || side.intent !== 'side_question' || side.status !== 'succeeded') throw Object.assign(new Error('chat_input_promotion_source_invalid'),{statusCode:400});
  }
  const steering = await postgresApplication.stores.steering.submit({ ...identity, idempotencyKey: body.idempotencyKey, message: input.message, attachments: input.args.attachments || [], generation: body.generation, promotedFrom: body.promotedFrom });
  return { ok: true, runId, sessionId: identity.sessionId, steering };
}

async function listChatSteering(runId, body, agentRuntime) {
  if (!agentRuntime) throw Object.assign(new Error('agent_id_required'),{statusCode:400});
  const identity = { agentId: agentRuntime.agentId, sessionId: String(body.sessionId || 'default'), runId };
  if (!activeChatRuns.has(activeChatRunKey(identity.agentId, runId))) {
    try { await postgresApplication.stores.steering.boundary(identity, { finish: true }); }
    catch (error) { if (error.statusCode !== 404) throw error; }
  }
  return { ok: true, ...identity, steering: await postgresApplication.stores.steering.list(identity) };
}

async function currentActiveChatRunSummaries({ agentId = null, sessionId = null } = {}) {
  const allRuns = activeChatRunSummaries(activeChatRuns, { agentId });
  const runs = [];
  const childRecords = [];
  // Observability reads stored identity/data, not permission to execute a turn.
  const runtimes = agentId ? [await resolveAgentContext(agentId)] : await Promise.all((await agentsStore().list({ includeDisabled: true })).map((agent) => resolveAgentContext(agent.id)));
  for (const agentRuntime of runtimes) {
    const [records, settings, metadata] = await Promise.all([
      listSubagentSummaries(agentRuntime),
      readMinionSettings(metadataStore(), agentRuntime.agentId),
      sessionId ? postgresApplication.stores.conversations.getMetadata({ agentId: agentRuntime.agentId, sessionId }) : null,
    ]);
    const requested = sessionId ? sessionMinionAncestry({ sessionId, metadata, maxDepth: settings.maxDepth }) : null;
    const agentRuns = allRuns.filter(run => run.agentId === agentRuntime.agentId);
    const activeSessions = await Promise.all(agentRuns.map(async run => ({
      ...run,
      metadata: run.sessionId === sessionId ? metadata : await postgresApplication.stores.conversations.getMetadata({ agentId: agentRuntime.agentId, sessionId: run.sessionId }),
    })));
    const tree = projectSubagentTree(records, { agentId: agentRuntime.agentId, sessionId, rootSessionId: requested?.depth > 0 ? requested.rootSessionId : null, activeSessions });
    const expectedRoot = requested?.depth > 0 ? requested.rootSessionId : tree.find(item => item.sessionId === sessionId)?.rootSessionId || sessionId;
    const liveSessions = new Set(agentRuns.map(run => run.sessionId));
    const activeTree = projectSubagentTree(tree, { agentId: agentRuntime.agentId, sessionId, rootSessionId: requested?.depth > 0 ? requested.rootSessionId : null, visible: item => !item.final || liveSessions.has(item.sessionId) });
    childRecords.push(...activeTree.map(item => ({ ...item, source: 'subagent' })));
    for (const run of agentRuns) {
      const subagent = tree.find(item => item.sessionId === run.sessionId && (!item.trace?.runId || item.trace.runId === run.runId));
      const runMetadata = subagent ? null : activeSessions.find(item => item.runId === run.runId)?.metadata;
      const ancestry = sessionMinionAncestry({ sessionId: run.sessionId, runId: run.runId, metadata: runMetadata, maxDepth: settings.maxDepth, subagent });
      if (sessionId && run.sessionId !== sessionId && ancestry.rootSessionId && expectedRoot && ancestry.rootSessionId !== expectedRoot) continue;
      if (sessionId && run.sessionId !== sessionId && !subagent && ancestry.rootSessionId !== sessionId && ancestry.parentSessionId !== sessionId) continue;
      // A requested child must not pick up siblings sharing its root marker.
      if (sessionId && requested?.depth > 0 && run.sessionId !== sessionId && !subagent && ancestry.parentSessionId !== sessionId) continue;
      const observed = { ...run, ...ancestry };
      if (run.lane === 'side_question') observed.steering = [];
      else {
        try { observed.steering = await postgresApplication.stores.steering.list(run); }
        catch (error) { if (error.statusCode !== 404) throw error; observed.steering = []; }
      }
      runs.push(observed);
    }
  }
  runs.sort((a, b) => a.agentId.localeCompare(b.agentId) || a.depth - b.depth);
  return { runs, subagents: childRecords, pendingForgeDeliveries: await postgresApplication.stores.forge.pendingChatDeliveryCount({ agentId, sessionId }) };
}

  return Object.freeze({
    configureChatInputRunner(runner) { chatInputRunner = runner; },
    handleChat, handleChatCommand, handleSerializedChat,
    activeChatRuns, sessionContinuityHeads, sessionChatQueues,
    sessionChatQueueKey, serializeSessionChat, sessionContinuityHeadKey,
    registerRuntimeActiveRun, retireCancelledRun,
    registerActiveRun: registerRuntimeActiveRun,
    cancelChatRun, supersedeSessionRuns, beginSessionAdmissionsReset, finishSessionAdmissionsReset,
    steerChatRun, listChatSteering,
    activeRunSummaries: ({ agentId = null, sessionId = null } = {}) => activeChatRunSummaries(activeChatRuns, { agentId, sessionId }),
    currentActiveChatRunSummaries,
  });
}
