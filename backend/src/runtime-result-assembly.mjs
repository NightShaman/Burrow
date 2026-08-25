import { appendSessionEntry, appendSessionContextState } from './session-store.mjs';
import { createExecutionPolicyEvidence } from './execution-policy-evidence.mjs';
import { compactExecution } from './runtime-result-shapes.mjs';

// A receipt is an explicit durable schema, not a generic object-graph copier.
// Full runtime contracts, prompts, tool output, and model envelopes stay in
// trace artifacts. Session persistence gets only stable facts and references.
function compactStrings(values = [], limit = 20) {
  return Array.isArray(values) ? values.filter((value) => typeof value === 'string').slice(0, limit) : [];
}

function compactTurnSupport(support = {}) {
  return {
    memory: support.memory ? { enabled: Boolean(support.memory.enabled), scope: support.memory.scope || null, query: support.memory.query || null, routingTerms: compactStrings(support.memory.routingTerms) } : null,
    workspace: support.workspace ? { include: Boolean(support.workspace.include), root: support.workspace.root || null, files: compactStrings(support.workspace.files) } : null,
    skills: { selected: support.skills?.selected?.map((skill) => skill.id).filter(Boolean) || [] },
  };
}
function compactExecutionFlags(execution = {}) {
  return { mayInspect: Boolean(execution.mayInspect), mayMutate: Boolean(execution.mayMutate), mayCommit: Boolean(execution.mayCommit) };
}
function compactIntentFacts(intentFacts = null) {
  if (!intentFacts) return null;
  return {
    action: intentFacts.action || null, kind: intentFacts.kind || null, target: intentFacts.target || null,
    targetKind: intentFacts.targetKind || null, fileTargets: compactStrings(intentFacts.fileTargets),
    plannerSource: intentFacts.plannerSource || null, fallbackReason: intentFacts.fallbackReason || null,
    ...compactIntentFlags(intentFacts),
  };
}

function compactIntentFlags(intentFacts = null) {
  if (!intentFacts) return null;
  return {
    authoritative: Boolean(intentFacts.authoritative),
    advisoryOnly: Boolean(intentFacts.advisoryOnly),
    readOnly: Boolean(intentFacts.readOnly),
    needsWorkspace: Boolean(intentFacts.needsWorkspace),
    requiresGitStatus: Boolean(intentFacts.requiresGitStatus),
  };
}

export function compactPlannerObservability(turnPlan = null) {
  if (!turnPlan) return undefined;
  return {
    version: turnPlan.version || 1,
    mode: turnPlan.mode || null,
    action: turnPlan.observability?.action || turnPlan.explicitControls?.action || turnPlan.instruction?.action || null,
    source: turnPlan.observability?.source || turnPlan.instruction?.source || null,
    confidence: turnPlan.observability?.confidence || turnPlan.instruction?.confidence || null,
    instruction: turnPlan.instruction ? {
      action: turnPlan.instruction.action || null,
      kind: turnPlan.instruction.kind || null,
      target: turnPlan.instruction.target || null,
      confidence: turnPlan.instruction.confidence || null,
      source: turnPlan.instruction.source || null,
    } : null,
    intentFacts: compactIntentFacts(turnPlan.intentFacts),
    intentFlags: compactIntentFlags(turnPlan.intentFacts),
    execution: compactExecutionFlags(turnPlan.execution),
    support: {
      ...compactTurnSupport(turnPlan.support),
      extraEyes: turnPlan.support?.extraEyes ? {
        requested: Boolean(turnPlan.support.extraEyes.requested),
        helper: turnPlan.support.extraEyes.helper || null,
        blockers: compactStrings(turnPlan.support.extraEyes.blockers),
      } : null,
    },
    provenance: compactStrings(turnPlan.provenance),
    signals: Array.isArray(turnPlan.observability?.signals) ? turnPlan.observability.signals.slice(0, 20).map((signal) => ({ source: signal?.source || null, target: signal?.target || null })) : [],
    blockers: compactStrings(turnPlan.observability?.blockers || turnPlan.safety?.blockers),
    warnings: compactStrings(turnPlan.observability?.warnings || turnPlan.safety?.warnings),
  };
}

export function compactRouteDecision(routeDecision = null) {
  if (!routeDecision) return undefined;
  return {
    version: routeDecision.version || 1,
    sessionKind: routeDecision.sessionKind || null,
    routeKind: routeDecision.routeKind || null,
    action: routeDecision.action || null,
    reason: routeDecision.reason || null,
    source: routeDecision.source || null,
    confidence: routeDecision.confidence || null,
    explicitControls: { action: routeDecision.explicitControls?.action || null, extraEyes: Boolean(routeDecision.explicitControls?.extraEyes), continueWork: Boolean(routeDecision.explicitControls?.continueWork) },
    signals: Array.isArray(routeDecision.signals) ? routeDecision.signals.slice(0, 20).map((signal) => ({ source: signal?.source || null, target: signal?.target || null })) : [],
    blockers: compactStrings(routeDecision.blockers),
    warnings: compactStrings(routeDecision.warnings),
  };
}

export function compactCanonicalTurnEnvelope(envelope = null) {
  if (!envelope) return undefined;
  return {
    kind: envelope.kind || null,
    rootPrimitive: envelope.rootPrimitive || null,
    sessionId: envelope.sessionId || null,
    conversationId: envelope.conversationId || null,
    input: { command: envelope.input?.command || null, workspaceRoot: envelope.input?.workspaceRoot || null },
    route: { kind: envelope.route?.kind || null },
    routeDecision: compactRouteDecision(envelope.routeDecision),
    planner: envelope.planner ? { mode: envelope.planner.mode || null, execution: compactExecutionFlags(envelope.planner.execution), instruction: envelope.planner.instruction ? { action: envelope.planner.instruction.action || null, kind: envelope.planner.instruction.kind || null, target: envelope.planner.instruction.target || null } : null, intentFacts: compactIntentFacts(envelope.planner.intentFacts) } : null,
    context: { rawRecentTurnCount: envelope.context?.rawRecentTurnCount ?? null },
    executionPolicy: { mayMutate: Boolean(envelope.executionPolicy?.mayMutate), blockers: compactStrings(envelope.executionPolicy?.blockers) },
    support: compactTurnSupport(envelope.support),
    trace: { runId: envelope.trace?.runId || null },
  };
}

export function compactRuntimeTurnContract(runtimeTurn = null) {
  if (!runtimeTurn) return undefined;
  return {
    kind: runtimeTurn.kind || null,
    rootPrimitive: runtimeTurn.rootPrimitive || null,
    ...(runtimeTurn.envelopeKind ? { envelopeKind: runtimeTurn.envelopeKind } : {}),
    ...(compactRouteDecision(runtimeTurn.routeDecision) ? { routeDecision: compactRouteDecision(runtimeTurn.routeDecision) } : {}),
    planner: runtimeTurn.planner ? { mode: runtimeTurn.planner.mode || null, execution: compactExecutionFlags(runtimeTurn.planner.execution), instruction: runtimeTurn.planner.instruction ? { action: runtimeTurn.planner.instruction.action || null, kind: runtimeTurn.planner.instruction.kind || null, target: runtimeTurn.planner.instruction.target || null } : null, intentFacts: compactIntentFacts(runtimeTurn.planner.intentFacts) } : null,
    context: { rawRecentTurnCount: runtimeTurn.context?.rawRecentTurnCount ?? null },
    executionPolicy: { mayMutate: Boolean(runtimeTurn.executionPolicy?.mayMutate), blockers: compactStrings(runtimeTurn.executionPolicy?.blockers) },
    support: compactTurnSupport(runtimeTurn.support),
  };
}

export function compactExecutionContext(executionContext = null) {
  if (!executionContext) return undefined;
  return {
    sessionId: executionContext.sessionId ?? null,
    workspaceRoot: executionContext.workspaceRoot ?? null,
    target: executionContext.target || null,
    dataRoot: executionContext.dataRoot ?? null,
    cacheRoot: executionContext.cacheRoot ?? null,
    filesystemBoundaries: executionContext.filesystemBoundaries || [],
    toolNames: (executionContext.toolSchemas || []).map((tool) => tool?.function?.name).filter(Boolean),
  };
}

export function compactRuntimeReceipt({
  decision = null,
  backgroundWork = null,
  prompt = null,
  workResult = null,
  recentFiles = [],
  memoryIntent = null,
  outcome = null,
  turnPlan = null,
  plannerObservability = null,
  routeDecision = null,
  canonicalTurnEnvelope = null,
  runtimeTurn = null,
  delegatedWork = null,
  invariantValidation = null,
  executionContext = null,
  acceptanceChecklist = null,
  contextUsage = null,
  completionEvidence = null,
} = {}) {
  return {
    decision,
    executionContext: compactExecutionContext(executionContext),
    acceptanceChecklist: acceptanceChecklist ? {
      required: Boolean(acceptanceChecklist.required),
      status: acceptanceChecklist.status || null,
      complete: Boolean(acceptanceChecklist.complete),
      requirements: (acceptanceChecklist.requirements || []).slice(0, 20).map((item) => ({ id: item?.id || null, verdict: item?.verdict || null, reason: item?.reason || null })),
      evidence: acceptanceChecklist.evidence || null,
    } : undefined,
    outcome: outcome || undefined,
    memoryIntent: memoryIntent || undefined,
    turnPlan: turnPlan ? {
      mode: turnPlan.mode || null,
      execution: compactExecutionFlags(turnPlan.execution),
      support: compactTurnSupport(turnPlan.support),
      instruction: turnPlan.instruction ? { action: turnPlan.instruction.action || null, kind: turnPlan.instruction.kind || null, target: turnPlan.instruction.target || null } : null,
      intentFacts: compactIntentFacts(turnPlan.intentFacts),
      intentFlags: compactIntentFlags(turnPlan.intentFacts),
      provenance: compactStrings(turnPlan.provenance),
    } : undefined,
    plannerObservability: plannerObservability || compactPlannerObservability(turnPlan),
    ...(compactRouteDecision(routeDecision || canonicalTurnEnvelope?.routeDecision || runtimeTurn?.routeDecision) ? { routeDecision: compactRouteDecision(routeDecision || canonicalTurnEnvelope?.routeDecision || runtimeTurn?.routeDecision) } : {}),
    canonicalTurnEnvelope: compactCanonicalTurnEnvelope(canonicalTurnEnvelope),
    runtimeTurn: compactRuntimeTurnContract(runtimeTurn),
    invariantValidation: invariantValidation ? { valid: Boolean(invariantValidation.valid), violations: compactStrings(invariantValidation.violations), severity: invariantValidation.severity || null } : undefined,
    authorityEvidence: createExecutionPolicyEvidence({ decision, routeDecision: routeDecision || canonicalTurnEnvelope?.routeDecision || runtimeTurn?.routeDecision, runtimeTurn, workResult, outcome }),
    completionEvidence: completionEvidence || undefined,
    delegatedWork: delegatedWork ? {
      activeCount: delegatedWork.activeCount ?? 0,
      finalCount: delegatedWork.finalCount ?? 0,
      items: Array.isArray(delegatedWork.items) ? delegatedWork.items.slice(0, 20).map((item) => ({ id: item?.id || null, status: item?.status || null, profile: item?.profile || null, traceDir: item?.traceDir || null })) : [],
    } : undefined,
    recentFiles: recentFiles.length ? recentFiles : undefined,
    backgroundWork: backgroundWork ? {
      itemId: backgroundWork.itemId || null,
      status: backgroundWork.status || null,
      step: backgroundWork.step || null,
      blockers: compactStrings(backgroundWork.blockers),
      delegatedWork: backgroundWork.delegatedWork ? { id: backgroundWork.delegatedWork.id || null, status: backgroundWork.delegatedWork.status || null } : null,
    } : null,
    prompt: prompt?.stats ? {
      stats: prompt.stats,
      contextBuildReceipt: prompt.contextBuildReceipt ? {
        ...prompt.contextBuildReceipt,
        ...(Number.isFinite(Number(contextUsage?.estimatedTokens)) ? {
          budget: {
            ...prompt.contextBuildReceipt.budget,
            estimatedTokens: Number(contextUsage.estimatedTokens),
            estimatedChars: Number(contextUsage.estimatedChars) || prompt.contextBuildReceipt.budget?.estimatedChars || null,
            usageRatio: Number.isFinite(Number(prompt.contextBuildReceipt.budget?.contextTokens || prompt.contextBuildReceipt.budget?.contextWindow))
              ? Number(contextUsage.estimatedTokens) / Number(prompt.contextBuildReceipt.budget.contextTokens || prompt.contextBuildReceipt.budget.contextWindow)
              : null,
            source: contextUsage.source || 'provider-request-estimate',
            providerInputTokens: Number.isFinite(Number(contextUsage.providerInputTokens)) ? Number(contextUsage.providerInputTokens) : null,
            modelCall: Number.isFinite(Number(contextUsage.modelCall)) ? Number(contextUsage.modelCall) : null,
            continuation: Boolean(contextUsage.continuation),
            updatedAt: contextUsage.updatedAt || null,
          },
        } : {}),
      } : null,
    } : null,
    workResult: workResult ? {
      runId: workResult.runId || null,
      decision: workResult.decision || null,
      proposedActions: workResult.proposedActions?.length ?? 0,
      executedActions: workResult.proposalExecution?.executed ?? 0,
      verification: workResult.verification ? { required: Boolean(workResult.verification.required), ok: Boolean(workResult.verification.ok), reason: workResult.verification.reason || null, checks: Number(workResult.verification.evidence?.checks || 0) } : null,
    } : null,
  };
}

export function compactPersistedReceipt({ receipt = {}, logger = null } = {}) {
  return {
    kind: 'runtime-receipt-ref',
    version: 1,
    runId: logger?.runId || receipt.workResult?.runId || null,
    traceDir: logger?.traceDir || null,
    decision: receipt.decision || null,
    route: receipt.routeDecision ? { kind: receipt.routeDecision.routeKind || null, action: receipt.routeDecision.action || null } : null,
    outcome: receipt.outcome ? { kind: receipt.outcome.kind || null, changedFiles: compactStrings(receipt.outcome.changedFiles) } : null,
    ...(receipt.acceptanceChecklist ? { acceptance: { status: receipt.acceptanceChecklist.status || null, complete: Boolean(receipt.acceptanceChecklist.complete) } } : {}),
    contextBuildReceipt: receipt.prompt?.contextBuildReceipt || null,
  };
}

function runtimeContextStates({ receipt = {}, sessionId, logger } = {}) {
  const runId = logger?.runId || receipt?.workResult?.runId || null;
  const sourceRefs = [runId ? `run:${runId}` : null, logger?.traceDir ? `trace:${logger.traceDir}` : null].filter(Boolean);
  const states = [];
  const blockers = receipt?.plannerObservability?.blockers || receipt?.turnPlan?.plannerObservability?.blockers || [];
  for (const [index, blocker] of blockers.entries()) {
    const content = String(blocker || '').trim();
    if (!content) continue;
    states.push({ id: `blocker:${runId || 'run'}:${index}`, kind: 'blocker', lifecycle: 'active', scopeKey: `runtime-blocker:${content.slice(0, 160)}`, title: 'Runtime blocker', content, sourceRefs });
  }
  const completion = receipt?.completionEvidence;
  if (completion?.status || completion?.summary) {
    const content = String(completion.summary || completion.status).trim();
    if (content) states.push({ id: `evidence:${runId || 'run'}`, kind: 'evidence', lifecycle: 'completed', title: 'Run completion evidence', content, sourceRefs });
  }
  return states;
}

export async function appendRuntimeReceipt({ sessionRoot, dataRoot = null, sessionId, logger, receipt, subjectScope = null } = {}) {
  const rootDir = sessionRoot || dataRoot;
  if (!rootDir || !sessionId || !receipt) return null;
  const receiptRef = compactPersistedReceipt({ receipt, logger });
  const receiptEntry = await appendSessionEntry({
    rootDir,
    sessionId,
    type: 'receipt',
    role: null,
    content: `Runtime receipt: ${receiptRef.decision || 'completed'}${receiptRef.runId ? ` (${receiptRef.runId})` : ''}`,
    runId: receiptRef.runId,
    traceDir: receiptRef.traceDir,
    metadata: { ...(subjectScope ? { subjectScope } : {}), receiptRef, authorityEvidence: receipt.authorityEvidence || null },
  });
  // Only runtime-structured facts are derived here. Operator instructions,
  // decisions, and pins require an explicit caller-created context-state record.
  for (const state of runtimeContextStates({ receipt, sessionId, logger })) {
    await appendSessionContextState({ rootDir, sessionId, runId: receiptRef.runId, traceDir: receiptRef.traceDir, state });
  }
  return receiptEntry;
}

export function compactAskChatResult(result = {}) {
  const outcomeExecution = result.outcome?.execution || null;
  return {
    ok: result.ok,
    mode: result.mode,
    command: result.command,
    decision: result.decision,
    runId: result.runId,
    dataRoot: result.dataRoot,
    traceDir: result.traceDir,
    selectedSkills: result.selectedSkills,
    intent: result.intent,
    sessionId: result.sessionId,
    sessionContext: result.sessionContext,
    session: result.session,
    observedResultKind: result.observedResultKind,
    workbenchStatus: result.workbenchStatus,
    chatSupport: result.chatSupport,
    backgroundWork: result.backgroundWork,
    debug: result.debug,
    outcome: result.outcome,
    workResult: result.workResult,
    proposalExecution: result.proposalExecution || (outcomeExecution ? {
      executed: outcomeExecution.executedActions ?? 0,
      skipped: outcomeExecution.skippedActions || [],
      tools: [],
    } : compactExecution(null)),
    verification: result.verification || result.outcome?.verification || null,
    acceptanceChecklist: result.acceptanceChecklist || null,
    completionEvidence: result.completionEvidence || result.outcome?.completionEvidence || null,
    commit: result.commit || result.outcome?.commit || null,
    chatToolLoop: result.chatToolLoop,
    memoryIntent: result.memoryIntent,
    memoryStage: result.memoryStage,
    memory: result.memory,
    handoffCandidate: result.handoffCandidate,
    memoryWrite: result.memoryWrite,
    answerText: result.answerText,
    modelUsage: result.modelUsage,
    proposedActionCount: result.proposedActions?.length ?? 0,
    proposedActions: result.proposedActions,
  };
}
