import { promises as fs } from 'node:fs';
import path from 'node:path';
import { routeRequest } from './request-router.mjs';
import { prepareContextForTurn } from './context-builder.mjs';
import { createTraceLogger } from './trace-logger.mjs';
import { resolveRuntimeTracePath } from './config.mjs';
import { claimSessionContinuityHead, isSessionContinuityCurrent, readSessionContinuityHead, recordInterruptedRun } from './session-store.mjs';
import { prepareRuntimeSupportContext } from './runtime-support-context.mjs';
import { workbenchWorkflow } from './workbench-workflow.mjs';
import { buildContinuationPlan, explicitContinueRequested } from './work-item-service.mjs';
import { prepareRuntimeWorkItemContext } from './runtime-work-item-context.mjs';
import { prepareRuntimeSessionContext } from './runtime-session-context.mjs';
import { createTerminalCommitter } from './runtime-terminal-commit.mjs';
import { createCompatibilityObserver } from './compatibility-observability.mjs';
import { runContinuationBranch } from './runtime-continuation-branch.mjs';
import { runRuntimeModelExecution } from './runtime-model-execution.mjs';
import { createRouteDecision, enrichTurnPlan, planTurnWithModel } from './turn-planner.mjs';
import { loadEffectiveSkillCatalog } from './skill-catalog.mjs';
import { buildRuntimeTurnEnvelope } from './runtime-turn-envelope.mjs';
import { createExecutionPolicy } from './execution-policy.mjs';
import { loadRuntimeConfig } from './runtime-config-loader.mjs';
import { compactPlannerObservability } from './runtime-result-assembly.mjs';
import { persistPlainChatResult } from './runtime-plain-chat-persistence.mjs';
import { appendRuntimeSessionTurn } from './runtime-session-writer.mjs';
import { prepareRuntimePromptContext } from './runtime-prompt-context.mjs';
import { subagentVisibilitySummary, listSubagentRecords } from './subagent-store.mjs';
import { applyWorkingContextEvents } from './working-context.mjs';
import { appendTiddleResidue } from './tiddle-continuity.mjs';
import { persistChatAttachments } from './attachment-store.mjs';

import { createExecutionContext, resolveExecutionTarget } from './execution-context.mjs';
import { runtimeHeapStage } from './runtime-heap-diagnostics.mjs';
import { loadRuntimeMcpCapabilities, createRuntimeExecutionContext } from './runtime-capability-context.mjs';


import { attachmentSummary, createFallbackRunId, extraEyesRequested, normalizeRuntimeTurnInput, promptTextAttachments, userTurnMetadata } from './runtime-turn-input.mjs';

export { loadRuntimeConfig };

// A continuity head makes stale completion safe, but it does not make two live
// turns in one process cooperative: a later claimant can still invalidate an
// earlier turn. Queue the complete runtime turn per session so operator turns
// and nested A2A replies cannot race each other. Cross-process protection
// remains the continuity head and file lock in session-store.
const sessionExecutionQueues = new Map();
function sessionExecutionKey({ rootDir, sessionId, args = {}, agentRuntime = null } = {}) {
  const sessionRoot = agentRuntime?.agentWorkspaceRoot
    || args?.agent_workspace_root || args?.agentWorkspaceRoot
    || args?.data_root || args?.dataRoot
    || rootDir;
  return `${path.resolve(String(sessionRoot))}:${String(sessionId || args?.session_id || args?.sessionId || args?.run_id || args?.runId || 'default')}`;
}
async function serializeSessionExecution(options, operation) {
  const key = sessionExecutionKey(options);
  const previous = sessionExecutionQueues.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  sessionExecutionQueues.set(key, current);
  try { return await current; }
  finally { if (sessionExecutionQueues.get(key) === current) sessionExecutionQueues.delete(key); }
}

export async function runAskChat(options = {}) {
  // Internal regression seam: stale-commit tests exercise the cross-process
  // continuity guard directly. Production callers always serialize here.
  if (options.testHooks?.bypassSessionExecutionQueue) return runAskChatUnserialized(options);
  return serializeSessionExecution(options, () => runAskChatUnserialized(options));
}

async function subagentDebugSnapshot({ dataRoot, legacyDataRoot = null, sessionId, compatibilityObserver = null, limit = 20 } = {}) {
  if (!dataRoot) return { snapshot: { items: [], activeCount: 0, finalCount: 0 }, records: [] };
  const records = await listSubagentRecords({ dataRoot, legacyDataRoot, compatibilityObserver, sessionId, limit });
  const summaries = records.map(subagentVisibilitySummary);
  const owned = sessionId ? summaries.filter((item) => item.owner?.sessionId === sessionId) : summaries;
  const active = owned.filter((item) => item.final !== true);
  const final = owned.filter((item) => item.final === true);
  // Raw records are needed only to select prompt evidence below. They must not
  // travel in the canonical envelope, receipt, or router trace.
  return { snapshot: { items: owned, activeCount: active.length, finalCount: final.length }, records };
}

async function logRuntimeHeapStage(logger, stage, objects) {
  // Bounded graph telemetry for the narrow OOM window. It records object
  // counts/sizes without serializing the inspected payloads themselves.
  await logger?.event?.('runtime-heap-stage', runtimeHeapStage(stage, objects));
}

function compactChildEvidence(evidence = []) {
  return (Array.isArray(evidence) ? evidence : []).slice(0, 4).map((item) => ({
    tool: item?.tool || null,
    ok: item?.ok ?? null,
    filePath: item?.filePath || null,
    command: item?.command ? String(item.command).slice(0, 400) : null,
    error: item?.error ? String(item.error).slice(0, 800) : null,
    content: item?.content ? String(item.content).slice(0, 1_200) : null,
    summary: item?.summary ? String(item.summary).slice(0, 1_200) : null,
  }));
}

function completedChildEvidence(records = [], { sessionId = null, conversationId = null, limit = 3 } = {}) {
  return (records || [])
    .filter((record) => record?.owner?.sessionId === sessionId && record?.owner?.conversationId === conversationId && record.status === 'succeeded' && record.result?.ok && record.trace?.childSessionId)
    .slice(0, limit)
    .map((record) => ({
      id: record.id,
      status: record.status,
      ok: Boolean(record.result?.ok),
      target: record.scope?.target || (record.scope?.workspaceRoot ? { kind: 'filesystem', root: record.scope.workspaceRoot } : null),
      childSessionId: record.trace?.childSessionId || null,
      receiptRef: (record.result?.artifacts || []).find((artifact) => artifact?.type === 'subagent-receipt')?.path || null,
      summary: record.result?.summary || '',
      evidence: compactChildEvidence(record.result?.evidence),
    }));
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
  // Trusted server-side context for a participant in an operator group room.
  // The room transcript is prompt context, not the participant's private session.
  groupChannelContext = null,
  // Internal test seam; never supplied by the chat transport.
  testHooks = null,
  // Internal transport observer. It receives persisted trace records and is
  // intentionally not accepted through serialized request arguments.
  onTraceRecord = null,
  // Visible provider text only; never carried in serialized turn arguments.
  onModelTextDelta = null,
  // Transient provider work/reasoning stream; never persisted as a chat turn.
  onModelThoughtDelta = null,
  // Current serialized provider-request budget; transient transport observer.
  onModelContextUsage = null,
  // Trusted server-side lifecycle hook for nested A2A recipient runs. This lets
  // transports publish real recipient work without coupling core to a UI registry.
  registerNestedAgentRun = null,
} = {}) {
  if (!rootDir) throw new Error('rootDir is required');
  if (!message) throw new Error('message is required');

  const { normalizedArgs, attachments } = normalizeRuntimeTurnInput({ args, workspaceRoot, target, action, noCallModel, callModel, agentRuntime });
  const runtimeConfig = await loadRuntimeConfig({ rootDir, args: normalizedArgs });
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
  const persistedAttachments = await persistChatAttachments({ agentWorkspaceRoot: runtimeState.agentWorkspaceRoot || runtimeState.workspaceRoot, attachments });
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
  const resolvedSessionId = sessionId || normalizedArgs.session_id || normalizedArgs.run_id || 'default';
  const continuity = await claimSessionContinuityHead({
    rootDir: sessionRoot,
    sessionId: resolvedSessionId,
    runId: resolvedRunId,
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
      resolvedTarget = await resolveExecutionTarget(targetRequest, { filesystemBoundaries: runtimeState.filesystemBoundaries });
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
    message,
    explicitWorkspaceFiles,
    interruptedRun: continuity.recoveryManifest || null,
  });
  const { priorSession, conversationId, resolvedWorkingRoot, compatibilityScope, continuityScope, generatedContinuityScope, verifiedSubjectScope, deicticFiles, workspaceFiles, initialWorkingContext, ambientWorkingContext } = sessionContext;
  const effectiveAction = action ?? normalizedArgs.action ?? null;
  const dreamPreload = null;
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
  const logger = createTraceLogger({ rootDir: traceRoot, runId: resolvedRunId, sessionId: resolvedSessionId, onRecord: onTraceRecord });
  const commitTerminalResult = createTerminalCommitter({ rootDir, sessionRoot, sessionId: resolvedSessionId, runId: resolvedRunId, generation: continuity.generation, command, json, initialWorkingContext, objective: message, traceRef: logger.traceDir, testHooks });
  const runAgentReply = async ({ recipientRuntime, recipientSessionId, content, senderAgentId, sourceSessionId, sourceRunId, inboundEntryId }) => {
    const nestedRunId = `${resolvedRunId}-reply-${recipientRuntime.agentId}`;
    const lifecycle = typeof registerNestedAgentRun === 'function'
      ? registerNestedAgentRun({ agentRuntime: recipientRuntime, sessionId: recipientSessionId, runId: nestedRunId, message: content, source: 'a2a' })
      : null;
    try {
      const reply = await runAskChat({
        rootDir,
        command: 'agent-message-reply',
        message: content,
        sessionId: recipientSessionId,
        runId: nestedRunId,
        workspaceRoot: recipientRuntime.agentWorkspaceRoot,
        json: true,
        agentRuntime: recipientRuntime,
        resolveAgentRuntime,
        incomingAgentMessage: { senderAgentId, sourceSessionId, sourceRunId, inboundEntryId },
        registerNestedAgentRun,
        onTraceRecord: lifecycle?.onTraceRecord || null,
        onModelTextDelta: lifecycle?.onModelTextDelta || null,
        onModelThoughtDelta: lifecycle?.onModelThoughtDelta || null,
        onModelContextUsage: lifecycle?.onModelContextUsage || null,
        args: lifecycle?.signal ? { abort_signal: lifecycle.signal } : {},
      });
      return { answerText: reply.answerText || null, runId: reply.runId || null, recipientReplyEntryId: reply.assistantTurn?.id || null, error: reply.error || null };
    } finally {
      lifecycle?.finish?.();
    }
  };
  const { mcpTools, mcpConnections } = loadRuntimeMcpCapabilities({ databasePath: runtimeState.settingsDatabasePath, agentId: runtimeState.agentId });
  const executionContext = createRuntimeExecutionContext({ runtimeState, resolvedSessionId, conversationId, continuityScope, agentRuntime, resolveAgentRuntime, runAgentReply, resolvedWorkingRoot, resolvedTarget, dataRoot, executionBoundaries, mcpTools, mcpConnections });
  const effectiveSkillCatalog = await loadEffectiveSkillCatalog({
    workspaceRoot: runtimeState.workspaceRoot,
    agentId: runtimeState.agentId,
    agentRuntime,
    overrides: scopedSkillsConfig,
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
    // Keep provider metadata available for no-call control paths; model remains null when no SQLite selection was made.
    modelConfig,
    traceLogger: logger,
  });
  const route = await routeRequest({
    rootDir,
    message,
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
  const supportContext = await prepareRuntimeSupportContext({ rootDir, sessionRoot, dataRoot, runtimeState, agentRuntime, resolvedSessionId, message, priorSession, continuityScope, explicitContinuityRequested, route, runtimeConfig, logger });
  const { sessionRecall, runEvidence, contextSupport } = supportContext;
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
  const childEvidence = completedChildEvidence(subagentState.records, { sessionId: resolvedSessionId, conversationId });
  // Registry history belongs to the UI/debug surface, never model support context.
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
      sessionRoot,
      sessionId: resolvedSessionId,
      role: 'user',
      content: message,
      runId: resolvedRunId,
      traceDir: logger.traceDir,
      metadata: {
        ...userTurnMetadata({ command, session, intent, attachments: turnAttachments, turnPlan, subjectScope: verifiedSubjectScope }),
        ...(earlyContinuationPlan ? { continuationPlan: earlyContinuationPlan } : {}),
      },
    });
    await testHooks?.afterUserTurnPersisted?.({ sessionId: resolvedSessionId, runId: resolvedRunId });
  }

  const continuationResult = await runContinuationBranch({ rootDir, sessionRoot, dataRoot, logger, command, message, sessionId: resolvedSessionId, conversationId, priorSession, route, selectedSkills: route.skills.selected.map((skill) => skill.id), intent, session, activeWorkItem, requestedItemId, explicitContinue, normalizedArgs, workspaceFiles, resolvedWorkingRoot, turnPlan, plannerObservability, routeDecision, canonicalTurnEnvelope, runtimeTurn, executionContext, subagents, verifiedSubjectScope, commitTerminalResult, compatibilityObserver, runWorkbenchStepOverride: testHooks?.runWorkbenchStep });
  if (continuationResult) return continuationResult;

  const shouldCallModel = normalizedArgs.call_model || !normalizedArgs.no_call_model;
  const modelTask = incomingAgentMessage
    ? `[Agent message from ${incomingAgentMessage.senderAgentId || 'another agent'}]: ${message}`
    : message;
  const promptContext = await prepareRuntimePromptContext({ rootDir, sessionRoot, resolvedSessionId, preparedContext, runtimeState, runtimeConfig, agentRuntime, route, ambientWorkingContext, structuredSubagents, extraEyesReview, dreamPreload, childEvidence, sessionRecall, runEvidence, groupChannelContext, promptAttachments, attachmentManifest, modelTask, logger, modelConfig, executionContext });
  const { turnContext, conversationContext, prompt, finalPromptInspection, contextCompression } = promptContext;
  if (finalPromptInspection.pressure === 'blocked') {
    const content = 'I could not safely fit the final prompt inside the configured model context window after compression. I should not call the model with an over-budget prompt.';
    return commitTerminalResult({
      branch: 'prompt_context_over_budget',
      finalize: () => finalizeBlockedRuntimeResult({
        sessionRoot,
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

  const modelExecution = await runRuntimeModelExecution({ runtimeTurn, prompt, message, shouldCallModel, modelConfig, logger, resolvedWorkingRoot, rootDir, dataRoot, resolvedSessionId, conversationId, runtimeConfig, executionPolicy, executionContext, normalizedArgs, attachments: turnAttachments, sessionRoot, resolvedRunId, continuity, initialWorkingContext, onTextDelta: onModelTextDelta, onThoughtDelta: onModelThoughtDelta, onContextUsage: onModelContextUsage, command, json });
  if (modelExecution.superseded) {
    await recordInterruptedRun({
      rootDir: sessionRoot, sessionId: resolvedSessionId, runId: resolvedRunId, generation: continuity.generation,
      reason: 'superseded_by_newer_session_run', objective: message, traceRef: logger.traceDir,
      lastCompletedStep: 'Model execution completed after session ownership changed; terminal result was not persisted.',
      pendingVerification: ['Reconcile durable workspace and tool state before continuing.'], workingContext: initialWorkingContext,
    });
    return modelExecution.result;
  }
  const { modelTurn, finalWorkingContext } = modelExecution;
  const result = await persistPlainChatResult({ sessionRoot, dataRoot, logger, command, message, sessionId: resolvedSessionId, priorSession, route, selectedSkills: route.skills.selected.map((skill) => skill.id), prompt, contextEngine: turnContext, contextCompression, intent, session, workspaceRoot: resolvedWorkingRoot, subjectScope: verifiedSubjectScope, backgroundWork: trackedBackgroundWork, modelTurn, turnPlan, plannerObservability, routeDecision, canonicalTurnEnvelope, runtimeTurn, subagents, structuredSubagents, extraEyesReview, fileDeicticResolution: deicticFiles, finalWorkingContext, commitTerminalResult });
  if (result?.ok && result.decision === 'answered' && result.answerText) {
    // Tiddle residue is advisory and must never turn a completed chat response
    // into a failure. The periodic pass owns semantic reconciliation later.
    try {
      const residue = appendTiddleResidue({ databasePath: runtimeState.settingsDatabasePath, agentId: runtimeState.agentId, scope: continuityScope, sessionId: resolvedSessionId, conversationId: conversationId || resolvedSessionId, runId: logger.runId, message, answerText: result.answerText, toolResults: result?.proposalExecution?.tools || [] });
      await logger.event('tiddle-residue-recorded', { rollingContinuity: true, residue: residue ? { ref: residue.ref, scope: residue.scope } : null });
    } catch (error) {
      await logger.event('tiddle-residue-recorded', { rollingContinuity: true, error: String(error?.message || error) });
    }
  }
  return result;
}

export async function readTextFileIfExists(filePath) {
  try { return await fs.readFile(filePath, 'utf8'); } catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
}
