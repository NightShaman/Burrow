import { conversationAuthority } from './conversation-authority.mjs';
import { contextSessionId, withContextHistory } from './model-context-boundary.mjs';
import { createHash } from 'node:crypto';
import { visibleUserMessage } from './runtime-turn-input.mjs';
import { performance } from 'node:perf_hooks';
import { normalizeProviderMessage } from './provider-messages.mjs';
import { beginSessionAdmissionSupersession, finishSessionAdmissionSupersession, serializeSessionAdmission } from './session-admission.mjs';
import { operatorTimezone } from './timezone.mjs';
import { postgresContinuity } from './postgres-continuity.mjs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { routeRequest } from './request-router.mjs';
import { prepareContextForTurn } from './context-builder.mjs';
import { createTraceLogger } from './trace-logger.mjs';
import { resolveRuntimeTracePath } from './config.mjs';
import { prepareRuntimeSupportContext } from './runtime-support-context.mjs';
import { workbenchWorkflow } from './workbench-workflow.mjs';
import { buildContinuationPlan, explicitContinueRequested } from './work-item-service.mjs';
import { prepareRuntimeWorkItemContext } from './runtime-work-item-context.mjs';
import { agentExecutionWorkspaceRoot, prepareRuntimeSessionContext } from './runtime-session-context.mjs';
import { createTerminalCommitter } from './runtime-terminal-commit.mjs';
import { createCompatibilityObserver } from './compatibility-observability.mjs';
import { runContinuationBranch } from './runtime-continuation-branch.mjs';
import { runRuntimeModelExecution } from './runtime-model-execution.mjs';
import { createRouteDecision, enrichTurnPlan, planTurnWithModel } from './turn-planner.mjs';
import { loadEffectiveSkillCatalog } from './skill-catalog.mjs';
import { buildRuntimeTurnEnvelope } from './runtime-turn-envelope.mjs';
import { createExecutionPolicy } from './execution-policy.mjs';
import { loadRuntimeConfig } from './runtime-config-loader.mjs';
import { finalizeBlockedRuntimeResult } from './runtime-blocked-result.mjs';
import { compactPlannerObservability, compactAskChatResult } from './runtime-result-assembly.mjs';
import { persistPlainChatResult } from './runtime-plain-chat-persistence.mjs';
import { appendRuntimeSessionTurn } from './runtime-session-writer.mjs';
import { prepareRuntimePromptContext } from './runtime-prompt-context.mjs';
import { subagentVisibilitySummary, listSubagentRecords } from './subagent-store.mjs';
import { applyWorkingContextEvents } from './working-context.mjs';
import { appendTiddleResidueAsync } from './tiddle-continuity.mjs';
import { persistChatAttachments } from './attachment-store.mjs';

import { createExecutionContext } from './execution-context.mjs';
import { resolveRuntimeTurnTarget } from './runtime-turn-target.mjs';
import { runtimeHeapStage } from './runtime-heap-diagnostics.mjs';
import { loadRuntimeMcpCapabilities, createRuntimeExecutionContext } from './runtime-capability-context.mjs';


import { attachmentSummary, createFallbackRunId, extraEyesRequested, normalizeRuntimeTurnInput, promptTextAttachments, userTurnMetadata } from './runtime-turn-input.mjs';

export { loadRuntimeConfig };

// A continuity head makes stale completion safe, but it does not make two live
// turns in one process cooperative: a later claimant can still invalidate an
// earlier turn. Queue the complete runtime turn per session so operator turns
// and nested A2A replies cannot race each other. Cross-process protection
// remains the PostgreSQL continuity head and transactional ownership guard.
const sessionExecutionQueues = new Map();
function sessionExecutionKey({ rootDir, sessionId, args = {}, agentRuntime = null } = {}) {
  const sessionRoot = agentRuntime?.agentWorkspaceRoot
    || args?.agent_workspace_root || args?.agentWorkspaceRoot
    || args?.data_root || args?.dataRoot
    || rootDir;
  return `${path.resolve(String(sessionRoot))}:${String(sessionId || args?.session_id || args?.sessionId || args?.run_id || args?.runId || 'default')}`;
}
export async function serializeSessionExecution(options, operation) {
  const key = sessionExecutionKey(options);
  return serializeSessionAdmission(
    sessionExecutionQueues,
    key,
    operation,
    options.args?.abort_signal || options.args?.abortSignal,
    // Continuity retirement fences terminal commits, not every preparation or
    // command write. Retain the runtime lane until the operation actually drains.
    // Reset remains an explicit generation supersession, not a timeout shortcut.
  );
}

export function beginRuntimeSessionExecutionSupersession({ rootDir, sessionId, args = {}, agentRuntime = null } = {}) {
  return beginSessionAdmissionSupersession(sessionExecutionQueues, sessionExecutionKey({ rootDir, sessionId, args, agentRuntime }));
}

export function finishRuntimeSessionExecutionSupersession(token) {
  return finishSessionAdmissionSupersession(token);
}

export async function runAskChat(options = {}) {
  // Internal regression seam: stale-commit tests exercise the cross-process
  // continuity guard directly. Production callers always serialize here.
  if (options.testHooks?.bypassSessionExecutionQueue) return runAskChatUnserialized(options);
  const latencyTiming = { ...(options.latencyTiming || {}), runtimeQueuedMs: performance.now() };
  return serializeSessionExecution(options, async () => {
    try {
      return await runAskChatUnserialized({ ...options, latencyTiming: { ...latencyTiming, runtimeAdmittedMs: performance.now() } });
    } catch (error) {
      // Preserve interrupted-run evidence after execution unwinds but before a
      // successor can claim continuity. Retirement never detaches live work.
      if ((options.args?.abort_signal || options.args?.abortSignal)?.aborted) {
        await options.onCancellationDeadline?.();
      }
      throw error;
    }
  });
}

async function subagentDebugSnapshot({ dataRoot, legacyDataRoot = null, sessionId, compatibilityObserver = null, limit = 20 } = {}) {
  if (!dataRoot) return { snapshot: { items: [], activeCount: 0, finalCount: 0 }, records: [] };
  const records = await listSubagentRecords({ dataRoot, legacyDataRoot, compatibilityObserver, sessionId, limit });
  const summaries = records.map(subagentVisibilitySummary);
  const owned = sessionId ? summaries.filter((item) => item.owner?.sessionId === sessionId) : summaries;
  const active = owned.filter((item) => item.final !== true);
  // Completed child records remain durable for receipts, archive proof, and
  // explicit inspection. They are historical runs, not ambient context for a
  // later operator turn. Only live children belong in the current snapshot.
  return { snapshot: { items: active, activeCount: active.length, finalCount: 0 }, records };
}

async function logRuntimeHeapStage(logger, stage, objects) {
  // Bounded graph telemetry for the narrow OOM window. It records object
  // counts/sizes without serializing the inspected payloads themselves.
  await logger?.event?.('runtime-heap-stage', runtimeHeapStage(stage, objects));
}

async function runAskChatUnserialized({
  rootDir,
  command = 'chat',
  message,
  sessionId,
  runId,
  workspaceRoot = null,
  target = null,
  action = null,
  json = false,
  noCallModel = false,
  callModel = false,
  args = {},
  // Trusted server-side authority. This is intentionally separate from args:
  // transport/request fields must never be able to redefine agent roots.
  agentRuntime = null,
  resolveAgentRuntime = null,
  // Trusted internal provenance for one bounded recipient response. It is never
  // accepted from serialized request args.
  incomingAgentMessage = null,
  contextBoundary = null,
  // Internal ingress provenance; never taken from request body.
  turnSource = null,
  // Core-attested external ingress metadata; never taken from request body.
  externalTurnMetadata = null,
  completionEvent = null,
  chatInput = null,
  // Trusted server-side context for a participant in an operator group room.
  // The room transcript is prompt context, not the participant's private session.
  groupChannelContext = null,
  // Required composed PostgreSQL stores.
  stores = null,
  // Internal test seam; never supplied by the chat transport.
  testHooks = null,
  // Internal transport observer. It receives persisted trace records and is
  // intentionally not accepted through serialized request arguments.
  onTraceRecord = null,
  // Optional process-owned OTel projection; never accepted from serialized args.
  telemetry = null,
  parentTraceContext = null,
  runSource = null,
  latencyTiming = null,
  // Visible provider text only; never carried in serialized turn arguments.
  onModelTextDelta = null,
  // Transient provider work/reasoning stream; never persisted as a chat turn.
  onModelThoughtDelta = null,
  // Current serialized provider-request budget; transient transport observer.
  onModelContextUsage = null,
  // Signals that this run's durable steering identity exists. Active-run
  // projections must not advertise steering before this boundary completes.
  onSteeringReady = null,
  // Trusted server-side lifecycle hook for nested A2A recipient runs. This lets
  // transports publish real recipient work without coupling core to a UI registry.
  registerNestedAgentRun = null,
} = {}) {
  if (!rootDir) throw new Error('rootDir is required');
  if (!stores?.metadata || !stores?.conversations) throw new Error('runtime_stores_required');

  const { normalizedArgs, attachments } = normalizeRuntimeTurnInput({ args, workspaceRoot, target, action, noCallModel, callModel, agentRuntime });
  if (!message && !attachments.length) throw new Error('message is required');
  normalizedArgs.abort_signal?.throwIfAborted();
  const runtimeConfig = await loadRuntimeConfig({ rootDir, args: normalizedArgs, stores });
  const { defaults, modelConfig, executionBoundaries, runtimeState: loadedRuntimeState, skillsConfig } = runtimeConfig
  const agentContextConfig = agentRuntime?.contextConfig || agentRuntime?.agent?.contextConfig || {};
  const runtimeState = agentRuntime ? {
    ...loadedRuntimeState,
    agentId: agentRuntime.agentId,
    agentWorkspaceRoot: path.resolve(agentRuntime.agentWorkspaceRoot),
    agentDataRoot: path.resolve(agentRuntime.agentDataRoot),
    skillsRoot: path.resolve(agentRuntime.skillsRoot),
    filesystemBoundaries: agentRuntime.filesystemBoundaries.map((item) => path.resolve(item)),
  } : loadedRuntimeState;
  normalizedArgs.abort_signal?.throwIfAborted();
  const attachmentRetention = stores.albdruck ? (await stores.albdruck.readRetention()).attachmentDays : 30;
  const persistedAttachments = await persistChatAttachments({ retentionDays: attachmentRetention, agentWorkspaceRoot: runtimeState.agentWorkspaceRoot || runtimeState.workspaceRoot, attachments });
  const turnAttachments = persistedAttachments.length ? persistedAttachments : attachments;
  const promptAttachments = promptTextAttachments(turnAttachments);
  const attachmentManifest = attachmentSummary(turnAttachments);
  // Planner/router observability must receive the selected agent's resolved
  // skill context too; otherwise it can describe Hatchet's default root while
  // execution correctly uses another agent's catalog.
  const scopedSkillsConfig = {
    ...skillsConfig,
    root: runtimeState.skillsRoot,
    workspaceRoot: runtimeState.workspaceRoot,
    agentId: runtimeState.agentId,
  };
  const compatibilityObserver = createCompatibilityObserver();
  const legacyDataRoot = runtimeState.agentDataRoot && runtimeState.dataRoot !== runtimeState.agentDataRoot ? runtimeState.dataRoot : null;
  const explicitLegacyRoot = normalizedArgs.data_root || null;
  const sessionRoot = normalizedArgs.agent_workspace_root || explicitLegacyRoot || runtimeState.agentWorkspaceRoot || path.join(runtimeState.workspaceRoot, runtimeState.agentId || 'hatchet');
  const dataRoot = explicitLegacyRoot || normalizedArgs.agent_data_root || runtimeState.agentDataRoot || runtimeState.dataRoot || rootDir;
  const requestedWorkspaceRoot = workspaceRoot ?? normalizedArgs.workspace_root ?? null;
  // A trace run id identifies one turn. A fixed fallback silently merges
  // unrelated CLI/test turns into one apparent runaway trace.
  const resolvedRunId = runId || normalizedArgs.run_id || defaults.runId || createFallbackRunId();
  const historyStores = stores;
  const historySessionId = sessionId || normalizedArgs.session_id || normalizedArgs.run_id || 'default';
  const resolvedSessionId = contextBoundary
    ? contextSessionId({ agentId: runtimeState.agentId, historySessionId, key: contextBoundary.key })
    : historySessionId;
  if (contextBoundary) {
    stores = { ...stores, conversations: withContextHistory(stores.conversations, { agentId: runtimeState.agentId, sessionId: resolvedSessionId, historySessionId }) };
    await stores.conversations.updateMetadata({ agentId: runtimeState.agentId, sessionId: resolvedSessionId, update: metadata => ({ ...metadata, contextIsolation: { ...metadata.contextIsolation, historySessionId } }) });
    // Only the scheduler opts into visible-history rotation. Run after named
    // session admission, before continuity claim, projection, or model work.
    if (contextBoundary.resetHistory === true) {
      if (turnSource !== 'scheduled' || incomingAgentMessage) throw new Error('context_history_reset_scheduler_required');
      await historyStores.conversations.reset({ agentId: runtimeState.agentId, sessionId: historySessionId,
        freshExecutionSessionId: resolvedSessionId });
    }
    if (incomingAgentMessage?.inboundEntryId) {
      const entries = await conversationAuthority({ store: historyStores.conversations, agentId: runtimeState.agentId }).entriesAll(historySessionId);
      const inbound = entries.find(entry => entry.id === incomingAgentMessage.inboundEntryId);
      if (!inbound) throw new Error('context_boundary_inbound_missing');
      await historyStores.conversations.appendIfAbsent({ agentId: runtimeState.agentId, sessionId: resolvedSessionId, entry: { ...inbound, sessionId: resolvedSessionId }, idempotencyKey: `context-inbound:${inbound.id}` });
    }
  }
  if (!contextBoundary) {
    const isolation = (await stores.conversations.getMetadata({ agentId: runtimeState.agentId, sessionId: resolvedSessionId, signal: normalizedArgs.abort_signal }))?.contextIsolation;
    if (isolation?.historySessionId) stores = { ...stores, conversations: withContextHistory(stores.conversations, { agentId: runtimeState.agentId, sessionId: resolvedSessionId, historySessionId: isolation.historySessionId }) };
  }
  const steeringIdentity = { agentId: runtimeState.agentId, sessionId: resolvedSessionId, runId: resolvedRunId };
  if (stores.steering) {
    await stores.steering.open(steeringIdentity);
    onSteeringReady?.(steeringIdentity);
    normalizedArgs.live_steering = { boundary: options => stores.steering.boundary(steeringIdentity, options) };
  }
  let telemetryRun = null;
  let telemetryTerminalResult = null;
  let telemetryEnded = false;
  const rememberTelemetryTerminal = (result) => {
    // The orchestrator retains cancellation evidence on the model without
    // changing the persisted/product model_failed decision contract.
    telemetryTerminalResult ||= result?.decision === 'model_failed' && result?.model?.cancelled === true ? { ...result, cancelled: true } : result;
  };
  const endTelemetryRun = () => {
    if (!telemetryRun || telemetryEnded) return;
    telemetryEnded = true;
    try { telemetry.endRun?.(resolvedRunId, telemetryTerminalResult || { ok: false, status: 'failed' }); } catch {}
  };
  try {
  const continuityAuthority = postgresContinuity({ store: stores.conversations, agentId: runtimeState.agentId });
  const continuity = await continuityAuthority.claim({
    rootDir: sessionRoot,
    sessionId: resolvedSessionId,
    runId: resolvedRunId,
    objective: message,
    expectedResetGeneration: chatInput?.generation,
    chatInputId: chatInput?.id,
    // An internally delivered agent message is persisted first so it enters
    // the recipient prompt. Its source run is trusted, bounded provenance—not
    // an ambiguous interrupted foreign turn.
    acceptedLatestRunIds: incomingAgentMessage?.sourceRunId ? [incomingAgentMessage.sourceRunId] : [],
  });
  if (!continuity.current) {
    const result = { ok: false, mode: 'ask', command, decision: 'continuity_uncertain', runId: resolvedRunId, sessionId: resolvedSessionId, answerText: 'I found session state that is newer than the last completed continuity head. I will not guess which history is current.', blockers: ['continuity_uncertain'], continuity };
    return json ? result : compactAskChatResult(result);
  }
  const explicitWorkspaceFiles = normalizedArgs.file ? [normalizedArgs.file] : [];
  const targetRequest = normalizedArgs.target && typeof normalizedArgs.target === 'object' ? normalizedArgs.target : null;
  let resolvedTarget = null;
  let targetResolutionError = null;
  if (targetRequest) {
    try {
      resolvedTarget = await resolveRuntimeTurnTarget(targetRequest, { agentRuntime, filesystemBoundaries: runtimeState.filesystemBoundaries, runId: resolvedRunId });
    } catch (error) {
      targetResolutionError = error?.message || String(error);
    }
  }
  const sessionContext = await prepareRuntimeSessionContext({
    sessionRoot,
    resolvedSessionId,
    runtimeState,
    normalizedArgs,
    workspaceRoot,
    resolvedTarget,
    agentRuntime,
    message,
    explicitWorkspaceFiles,
    interruptedRun: continuity.recoveryManifest || null,
    stores,
  });
  const { turnStartedAt, lastOperatorMessageAt, priorSession, sessionSnapshot, conversationId, resolvedWorkingRoot, compatibilityScope, continuityScope, generatedContinuityScope, verifiedSubjectScope, deicticFiles, workspaceFiles, initialWorkingContext, ambientWorkingContext, dreamPreload } = sessionContext;
  const effectiveAction = action ?? normalizedArgs.action ?? null;
  const turnMemoryContext = {};
  // An explicit data root owns its trace cache too. This keeps isolated callers
  // (tests, one-shot tools, and alternate runtimes) from falling back to the
  // deployed cache, while every tool on this turn still receives this logger.
  const traceRoot = resolveRuntimeTracePath({
    cacheRoot: explicitLegacyRoot ? path.join(dataRoot, 'cache') : runtimeState.cacheRoot,
    workspaceRoot: runtimeState.workspaceRoot,
    agentId: runtimeState.agentId,
    sessionId: resolvedSessionId,
  });
  // A still-owned A2A delegation belongs to its sender's generation, even if
  // settings were disabled after the sender started. Neither an arbitrary W3C
  // carrier nor serialized args may enroll an unrelated run while disabled.
  const telemetryParentRunId = incomingAgentMessage?.sourceRunId || null;
  const ownedTelemetryParent = telemetryParentRunId && telemetry?.traceContextForRun?.(telemetryParentRunId);
  telemetryRun = runtimeConfig.opentelemetry?.effective?.enabled || ownedTelemetryParent
    ? telemetry?.startRun?.({ runId: resolvedRunId, sessionId: resolvedSessionId, agentId: runtimeState.agentId, source: runSource || turnSource || command, parentRunId: telemetryParentRunId, parentTraceContext })
    : null;
  const observeTrace = telemetryRun
    ? (record) => { telemetry.observe?.(record); return onTraceRecord?.(record); }
    : onTraceRecord;
  const logger = createTraceLogger({ rootDir: traceRoot, runId: resolvedRunId, sessionId: resolvedSessionId, conversationId, onRecord: observeTrace });
  if (latencyTiming) await logger.event('chat-admission-timing', { ...latencyTiming, clockDomain: 'server-process' });
  const commitTerminalResult = createTerminalCommitter({ stores, agentId:runtimeState.agentId, continuityAuthority, rootDir, sessionRoot, sessionId: resolvedSessionId, runId: resolvedRunId, generation: continuity.generation, command, json, initialWorkingContext, objective: message, traceRef: logger.traceDir, logger, onTerminal: rememberTelemetryTerminal, testHooks });
  const runAgentReply = async ({ recipientRuntime, recipientSessionId, content, senderAgentId, sourceSessionId, sourceRunId, messageMode = 'request_reply', inboundEntryId, contextBoundary = null, parentTraceContext = null, parentSignal = null }) => {
    // Ingress is already durable/idempotent before this callback. Each distinct
    // exchange needs a distinct run, while replays retain the same identity.
    if (!inboundEntryId) throw new Error('agent_message_inbound_identity_required');
    const nestedRunId = `a2a-${createHash('sha256').update(JSON.stringify([
      runtimeState.agentId, resolvedRunId, recipientRuntime.agentId,
      recipientSessionId, inboundEntryId,
    ])).digest('hex')}`;
    const lifecycle = typeof registerNestedAgentRun === 'function'
      ? registerNestedAgentRun({ agentRuntime: recipientRuntime, sessionId: recipientSessionId, runId: nestedRunId, message: content, source: 'a2a', parentSignal, parentAgentId: runtimeState.agentId, parentRunId: resolvedRunId, parentSessionId: resolvedSessionId, messageMode, senderAgentId, sourceSessionId, sourceRunId, inboundEntryId })
      : null;
    try {
      const reply = await runAskChat({
        rootDir,
        command: 'agent-message-reply',
        message: content,
        sessionId: recipientSessionId,
        runId: nestedRunId,
        // Let the recipient resolve its own execution assignment. Passing its
        // controller-owned data root here overrides the remote workspace.
        workspaceRoot: agentExecutionWorkspaceRoot(recipientRuntime),
        json: true,
        agentRuntime: recipientRuntime,
        resolveAgentRuntime,
        contextBoundary,
        incomingAgentMessage: { senderAgentId, sourceSessionId, sourceRunId, messageMode, inboundEntryId },
        registerNestedAgentRun,
        stores: historyStores,
        onTraceRecord: lifecycle?.onTraceRecord || null,
        telemetry,
        // The sender tool, not its root run, is the immediate A2A parent.
        parentTraceContext,
        runSource: 'a2a',
        onModelTextDelta: lifecycle?.onModelTextDelta || null,
        onModelThoughtDelta: lifecycle?.onModelThoughtDelta || null,
        onModelContextUsage: lifecycle?.onModelContextUsage || null,
        onSteeringReady: lifecycle?.onSteeringReady || null,
        cancellationGraceMs: lifecycle?.cancellationGraceMs ?? null,
        onCancellationDeadline: lifecycle?.onCancellationDeadline || null,
        args: { abort_signal: lifecycle?.signal || parentSignal || normalizedArgs.abort_signal || null },
      });
      return { ok: reply.ok === true, decision: reply.decision || null, answerText: reply.answerText || null, runId: reply.runId || null, recipientReplyEntryId: reply.assistantTurn?.id || null, error: reply.error || null };
    } finally {
      lifecycle?.finish?.();
    }
  };
  const { mcpTools, mcpConnections } = await loadRuntimeMcpCapabilities({ agentId: runtimeState.agentId, stores });
  const agentMessageReplyTo = incomingAgentMessage?.senderAgentId && incomingAgentMessage?.sourceSessionId
    ? { recipientAgentId: incomingAgentMessage.senderAgentId, sessionId: incomingAgentMessage.sourceSessionId }
    : null;
  const executionContext = createRuntimeExecutionContext({ agentMessageReplyTo, stores, runtimeState, resolvedSessionId, conversationId, continuityScope, agentRuntime, resolveAgentRuntime, runAgentReply, resolvedWorkingRoot, resolvedTarget, dataRoot, executionBoundaries, mcpTools, mcpConnections, parentRunId: resolvedRunId, traceContext: telemetryRun ? telemetry.traceContextForRun?.(resolvedRunId) : null, telemetry: telemetryRun ? telemetry : null, abortSignal: normalizedArgs.abort_signal || null, skillOverrides: scopedSkillsConfig });
  const effectiveSkillCatalog = await loadEffectiveSkillCatalog({
    workspaceRoot: runtimeState.workspaceRoot,
    agentId: runtimeState.agentId,
    agentRuntime,
    overrides: scopedSkillsConfig,
    skillStore: stores?.skills || null,
  });
  const preliminaryTurnPlan = await planTurnWithModel({
    message,
    action: effectiveAction,
    explicitControls: { action: normalizedArgs.action ?? action ?? null, extraEyes: extraEyesRequested(normalizedArgs) },
    memoryContext: turnMemoryContext,
    agentRuntime,
    conversationContext: priorSession,
    workspaceContext: { workspaceRoot: resolvedWorkingRoot, files: workspaceFiles },
    skillConfig: scopedSkillsConfig,
    skillIndex: { skills: effectiveSkillCatalog.skills },
    // Keep provider metadata available for no-call control paths; model remains null when no PostgreSQL selection was made.
    modelConfig,
    traceLogger: logger,
  });
  const route = await routeRequest({
    rootDir,
    message,
    attachments,
    memoryContext: turnMemoryContext,
    skillConfig: scopedSkillsConfig,
    availableSkills: effectiveSkillCatalog.skills,
    workspaceContext: { workspaceRoot: resolvedWorkingRoot, files: workspaceFiles },
    turnPlan: preliminaryTurnPlan,
  });
  const turnPlan = enrichTurnPlan(preliminaryTurnPlan, {
    message,
    action: effectiveAction,
    explicitControls: { action: normalizedArgs.action ?? action ?? null, extraEyes: extraEyesRequested(normalizedArgs) },
    memoryContext: turnMemoryContext,
    agentRuntime,
    conversationContext: priorSession,
    workspaceContext: { workspaceRoot: resolvedWorkingRoot, files: workspaceFiles },
    skillConfig: scopedSkillsConfig,
    skillIndex: { skills: effectiveSkillCatalog.skills },
  });
  // Chat is one model-owned tool loop. Runtime does not classify prose into
  // inspect/mutate/stop routes; it only carries explicit transport controls and
  // structural targets to the tools the model is offered.
  const session = { kind: 'answer', reason: 'model_owned_chat', workspaceRoot: resolvedWorkingRoot, cues: { factory: [], mutation: [], plan: [], inspect: [] } };
  const routeDecision = createRouteDecision({
    session,
    turnPlan,
    route,
    explicitControls: {
      action: normalizedArgs.action ?? action ?? null,
      extraEyes: extraEyesRequested(normalizedArgs),
      continueWork: explicitContinueRequested(normalizedArgs),
    },
  });
  const plannerObservability = compactPlannerObservability(turnPlan);
  const workItemContext = await prepareRuntimeWorkItemContext({ dataRoot, legacyDataRoot, compatibilityObserver, resolvedSessionId, resolvedRunId, normalizedArgs: { ...normalizedArgs, message }, resolvedWorkingRoot, route, session });
  const { shouldAutoTrack, requestedItemId, explicitContinue, activeWorkItem, trackedWorkItem, trackedWorkCreated, trackedBackgroundWork, intent } = workItemContext;
  const explicitContinuityRequested = Boolean(compatibilityScope || normalizedArgs.continuity_scope || normalizedArgs.continuityScope || normalizedArgs.working_project || normalizedArgs.workingProject);
  const supportContext = await prepareRuntimeSupportContext({ stores, rootDir, sessionRoot, dataRoot, runtimeState, agentRuntime, resolvedSessionId, message, priorSession, continuityScope, explicitContinuityRequested, route, runtimeConfig, logger });
  const { sessionRecall, runEvidence, contextSupport } = supportContext;
  const albdruckRecall = null; // Saved knowledge requires an explicit agent tool call.
  const preparedContext = await prepareContextForTurn({
    rootDir: sessionRoot,
    dataRoot: sessionRoot,
    agentRuntime,
    sessionId: resolvedSessionId,
    contextConfig: runtimeConfig.contextConfig,
    modelConfig,
    selectedSkills: contextSupport.selectedSkills,
    logger,
    agentWorkspaceRoot: runtimeState.agentWorkspaceRoot,
    agentDataRoot: runtimeState.agentDataRoot,
    cacheRoot: runtimeState.cacheRoot,
    stores,
    agentId: runtimeState.agentId,
    transcript: sessionSnapshot?.entries || [],
    transcriptSnapshotSupplied: true,
    signal: normalizedArgs.abort_signal,
  });
  const { compressionResult, preCompressionInspection } = preparedContext;
  const executionPolicy = createExecutionPolicy({
    explicitControls: { action: normalizedArgs.action ?? action ?? null },
    policyBlockers: session?.blockers || [],
    policyWarnings: session?.warnings || [],
  });
  await logRuntimeHeapStage(logger, 'after-policy-envelope', { executionPolicy, turnContext: preparedContext.turnContext, conversationContext: preparedContext.conversationContext });
  // Planner support signals are observability only. They must not spawn delegated
  // workers or synthesize execution targets. Child work must come from a selected
  // runtime/tool action with explicit structural input.
  const structuredSubagents = null;
  const extraEyesReview = null;
  const subagentState = await subagentDebugSnapshot({ dataRoot, legacyDataRoot, sessionId: resolvedSessionId, compatibilityObserver });
  // Completed child records remain available through receipts, traces, and
  // explicit inspection. They do not become ambient evidence on later turns.
  const childEvidence = [];
  const subagents = subagentState.snapshot;
  await logRuntimeHeapStage(logger, 'after-delegated-evidence-selection', { childEvidence, rawSubagentRecordCount: subagentState.records.length });
  const { canonicalTurnEnvelope, runtimeTurn } = await buildRuntimeTurnEnvelope({ logger, resolvedSessionId, conversationId, message, command, resolvedWorkingRoot, resolvedTarget, attachments: attachmentSummary(turnAttachments), session, intent, routeDecision, turnPlan, turnContext: preparedContext.turnContext, ambientWorkingContext, agentContextConfig, route, executionPolicy, subagents, structuredSubagents, extraEyesReview, resolvedRunId, childEvidence, plannerObservability, priorSession, deicticFiles, trackedBackgroundWork, runtimeHeapStage: logRuntimeHeapStage });

  // The originating user message is canonical evidence, not terminal output.
  // Persist it before any continuation/workbench/model path can act, so an
  // in-process restart or crash leaves Archive with the instruction that led
  // to the recorded activity. Agent-delivery ingress already persisted its
  // attributed source message before invoking this recipient run.
  if (!incomingAgentMessage) {
    const earlyContinuationPlan = explicitContinue
      ? buildContinuationPlan({ item: activeWorkItem, requestedItemId, sessionId: resolvedSessionId, args: normalizedArgs, workspaceFiles })
      : null;
    await appendRuntimeSessionTurn({
      sessionRoot, stores, agentId: runtimeState.agentId,
      sessionId: resolvedSessionId,
      role: 'user',
      content: visibleUserMessage(message, externalTurnMetadata),
      runId: resolvedRunId,
      traceDir: logger.traceDir,
      metadata: {
        ...userTurnMetadata({ command, session, intent, attachments: turnAttachments, turnPlan, subjectScope: verifiedSubjectScope }),
        ...(turnSource ? { source: turnSource } : {}),
        ...(completionEvent ? { completionEvent } : {}),
        ...(chatInput ? { chatInput } : {}),
        ...(externalTurnMetadata ? { externalTurn: { ownerModId: externalTurnMetadata.ownerModId, externalTurnId: externalTurnMetadata.externalTurnId } } : {}),
        ...(earlyContinuationPlan ? { continuationPlan: earlyContinuationPlan } : {}),
      },
    });
    await testHooks?.afterUserTurnPersisted?.({ sessionId: resolvedSessionId, runId: resolvedRunId });
  }

  const continuationResult = await runContinuationBranch({ rootDir, stores, agentId: runtimeState.agentId, sessionRoot, dataRoot, logger, command, message, sessionId: resolvedSessionId, conversationId, priorSession, route, selectedSkills: route.skills.selected.map((skill) => skill.id), intent, session, activeWorkItem, requestedItemId, explicitContinue, normalizedArgs, workspaceFiles, resolvedWorkingRoot, turnPlan, plannerObservability, routeDecision, canonicalTurnEnvelope, runtimeTurn, executionContext, subagents, verifiedSubjectScope, commitTerminalResult, compatibilityObserver, runWorkbenchStepOverride: testHooks?.runWorkbenchStep });
  if (continuationResult) return continuationResult;

  const shouldCallModel = normalizedArgs.call_model || !normalizedArgs.no_call_model;
  const modelTask = incomingAgentMessage
    ? normalizeProviderMessage({ role: 'agent', content: message, metadata: {
      fromAgentId: incomingAgentMessage.senderAgentId,
      toAgentId: runtimeState.agentId,
      sourceSessionId: incomingAgentMessage.sourceSessionId,
      targetSessionId: historySessionId,
      messageMode: incomingAgentMessage.messageMode || 'request_reply',
    } }).content
    : message;
  let promptContext;
  try {
    promptContext = await prepareRuntimePromptContext({ rootDir, sessionRoot, resolvedSessionId, preparedContext, runtimeState, runtimeConfig, agentRuntime, stores, route, ambientWorkingContext, structuredSubagents, extraEyesReview, dreamPreload, childEvidence, sessionRecall, runEvidence, albdruckRecall, groupChannelContext, promptAttachments, attachmentManifest, modelTask, logger, modelConfig, executionContext, signal: normalizedArgs.abort_signal, temporalContext: { turnStartedAt, lastOperatorMessageAt, timezone: await operatorTimezone(stores.metadata) } });
  } catch (error) {
    // Context preparation can reject before returning its final inspection.
    // Route that exact budget failure through the same durable blocked owner,
    // rather than bypassing terminal assembly with an uncaught exception.
    if (error?.message !== 'context_preparation_prompt_over_budget') throw error;
    promptContext = {
      finalPromptInspection: { ...error.details, pressure: 'blocked' },
      contextCompression: { blocked: true, ...error.details },
    };
  }
  const { turnContext, conversationContext, prompt, finalPromptInspection, contextCompression } = promptContext;
  if (finalPromptInspection.pressure === 'blocked') {
    const content = 'I could not safely fit the final prompt inside the configured model context window after compression. I should not call the model with an over-budget prompt.';
    return await commitTerminalResult({
      branch: 'prompt_context_over_budget',
      finalize: () => finalizeBlockedRuntimeResult({
        sessionRoot, stores, agentId: runtimeState.agentId,
        dataRoot,
        logger,
        command,
        sessionId: resolvedSessionId,
        priorSession,
        route,
        selectedSkills: route.skills.selected.map((skill) => skill.id),
        intent,
        session,
        workbenchStatus: null,
        debug: { contextCompression, turnPlan, plannerObservability, routeDecision, canonicalTurnEnvelope, runtimeTurn, executionPolicy, subagents, structuredSubagents, extraEyesReview, compatibilityReads: compatibilityObserver.reads },
        backgroundWork: trackedBackgroundWork,
        blockedReason: 'prompt_context_over_budget',
        blockers: ['prompt_context_over_budget'],
        content,
        userTurn: null,
        assistantTurn: { role: 'assistant', content, metadata: { decision: 'blocked', blockedReason: 'prompt_context_over_budget', contextCompression } },
        subjectScope: verifiedSubjectScope,
      }),
    });
  }

  const modelExecution = await runRuntimeModelExecution({ continuityAuthority, runtimeTurn, prompt, message, shouldCallModel, modelConfig, logger, resolvedWorkingRoot, rootDir, dataRoot, resolvedSessionId, conversationId, runtimeConfig, executionPolicy, executionContext, normalizedArgs, attachments: turnAttachments, sessionRoot, resolvedRunId, continuity, initialWorkingContext, onTextDelta: onModelTextDelta, onThoughtDelta: onModelThoughtDelta, onContextUsage: onModelContextUsage, command, json });
  if (modelExecution.superseded) {
    rememberTelemetryTerminal(modelExecution.result);
    await continuityAuthority.interrupt({
      rootDir: sessionRoot, sessionId: resolvedSessionId, runId: resolvedRunId, generation: continuity.generation,
      reason: 'superseded_by_newer_session_run', objective: message, traceRef: logger.traceDir,
      lastCompletedStep: 'Model execution completed after session ownership changed; terminal result was not persisted.',
      pendingVerification: ['Reconcile durable workspace and tool state before continuing.'], workingContext: initialWorkingContext,
    });
    await logger.terminal();
    return modelExecution.result;
  }
  const { modelTurn, finalWorkingContext } = modelExecution;
  const result = await persistPlainChatResult({
    stores, agentId: runtimeState.agentId, sessionRoot, dataRoot, logger, command, message, sessionId: resolvedSessionId, priorSession, route, selectedSkills: route.skills.selected.map((skill) => skill.id), prompt, contextEngine: turnContext, contextCompression, intent, session, workspaceRoot: resolvedWorkingRoot, artifactWorkspaceRoot: runtimeState.agentWorkspaceRoot, subjectScope: verifiedSubjectScope, backgroundWork: trackedBackgroundWork, modelTurn, turnPlan, plannerObservability, routeDecision, canonicalTurnEnvelope, runtimeTurn, subagents, structuredSubagents, extraEyesReview, fileDeicticResolution: deicticFiles, finalWorkingContext, commitTerminalResult,
    afterCommitBeforeTraceTerminal: async (committedResult) => {
      if (!committedResult?.ok || committedResult.decision !== 'answered' || !committedResult.answerText) return;
      // Tiddle residue is advisory and must never turn a completed chat response
      // into a failure. Record it before terminal.json so the marker remains the
      // final trace write and completed traces stay retention-eligible.
      try {
        const residue = await appendTiddleResidueAsync({ metadataStore: stores.metadata, agentId: runtimeState.agentId, scope: continuityScope, sessionId: resolvedSessionId, conversationId: conversationId || resolvedSessionId, runId: logger.runId, message, answerText: committedResult.answerText, toolResults: committedResult?.proposalExecution?.tools || [] });
        await logger.event('tiddle-residue-recorded', { rollingContinuity: true, residue: residue ? { ref: residue.ref, scope: residue.scope } : null });
      } catch (error) {
        await logger.event('tiddle-residue-recorded', { rollingContinuity: true, error: String(error?.message || error) });
      }
    },
  });
  return result;
  } catch (error) {
    rememberTelemetryTerminal({ ok: false, status: normalizedArgs.abort_signal?.aborted || error?.name === 'AbortError' ? 'cancelled' : 'failed' });
    throw error;
  } finally {
    try {
      if (stores.steering) await stores.steering.boundary(steeringIdentity, { finish: true });
    } finally {
      // Finish only after the terminal owner (including its trace writes) has
      // settled. Exceptions and supersession cannot strand a started OTel run.
      endTelemetryRun();
    }
  }
}

export async function readTextFileIfExists(filePath) {
  try { return await fs.readFile(filePath, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
