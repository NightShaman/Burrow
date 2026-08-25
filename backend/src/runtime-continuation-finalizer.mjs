import { appendWorkItemStep } from './work-item-store.mjs';
import { appendRuntimeSessionTurn } from './runtime-session-writer.mjs';
import { appendValidatedRuntimeReceipt, validateRuntimeInvariantsBeforeSideEffects } from './runtime-receipt-finalizer.mjs';
import { buildOutcome, compactExecution } from './runtime-result-shapes.mjs';
import { buildWorkbenchStatus, chatSupportStatus } from './workbench-status.mjs';
import { workbenchWorkflow } from './workbench-workflow.mjs';

function normalizedWorkItemKind(item = {}) {
  const allowed = new Set(['answer', 'inspect', 'plan', 'mutate', 'factory']);
  return allowed.has(item?.kind) ? item.kind : null;
}

function compactDelegatedWorkReceipt(delegatedFix = null) {
  if (!delegatedFix) return null;
  const commandEvidence = (delegatedFix.evidence || []).filter((item) => item.type === 'command');
  return {
    workerProfile: delegatedFix.workerProfile || null,
    spawned: delegatedFix.spawned ?? null,
    recordId: delegatedFix.recordId || null,
    status: delegatedFix.status || null,
    changedFiles: delegatedFix.changedFiles || [],
    verification: commandEvidence.length ? {
      ok: commandEvidence.every((item) => item.ok === true),
      commands: commandEvidence.map((item) => ({ command: item.command || null, ok: item.ok ?? null, exitCode: item.exitCode ?? null, timedOut: item.timedOut ?? false })),
    } : null,
    authority: {
      network: false,
      commit: false,
      push: false,
      memoryWrites: (delegatedFix.memoryWrites || []).length > 0,
      sideEffectsApplied: Boolean(delegatedFix.sideEffectsApplied),
    },
  };
}

function compactContinuedWork({ item, step, result, updated, eligibility, continuationPlan = null }) {
  return {
    continued: true,
    itemId: item.id,
    status: updated?.status || item.status,
    kind: normalizedWorkItemKind(item),
    step,
    workspaceRoot: continuationPlan?.workspaceRoot || item.workspaceRoot || null,
    targetFiles: continuationPlan?.targetFiles?.length ? continuationPlan.targetFiles : undefined,
    blockers: result?.blockers || eligibility?.blockers || [],
    allowedNextSteps: updated?.allowedNextSteps || item.allowedNextSteps || [],
    delegatedWork: result?.delegatedFix ? compactDelegatedWorkReceipt(result.delegatedFix) : null,
    stepResult: result ? { ok: result.ok, decision: result.decision, runId: result.runId || result.result?.runId || null, traceDir: result.traceDir || result.result?.traceDir || null, blockers: result.blockers || result.result?.blockers || [], delegatedFix: result.delegatedFix || null } : null,
  };
}

function describeWorkStep({ step, updatedItem, result, eligibility }) {
  if (!eligibility?.ok) {
    return `I can't continue that yet: ${eligibility?.blockers?.join(', ') || 'blocked by current task state'}.`;
  }
  const blockers = result?.blockers || result?.result?.blockers || [];
  const status = updatedItem?.status || 'updated';
  if (blockers.length) return `I moved it to ${step}, but it is blocked: ${blockers.join(', ')}.`;
  if (step === 'inspect') return `I checked the project state. Current status: ${status}.`;
  if (step === 'propose' && result?.decision === 'delegated_fix_applied') return `I applied the scoped delegated change. Current status: ${status}.`;
  if (step === 'propose') return `I prepared a proposed change. Current status: ${status}.`;
  if (step === 'verify') return result?.ok ? 'I ran verification and it passed.' : 'I ran verification and it failed.';
  if (step === 'factory') return `I prepared a commit preview. Current status: ${status}.`;
  return `I moved it to ${step}. Current status: ${status}.`;
}

function structuredWorkItemKind(item = {}, session = {}) {
  const allowed = new Set(['answer', 'inspect', 'plan', 'mutate', 'factory']);
  if (allowed.has(item?.kind)) return item.kind;
  if (allowed.has(item?.status)) return item.status;
  return session?.kind || 'answer';
}

function continuationWorkResult({ eligibility = null, continuedResult = null, backgroundWork = null } = {}) {
  const result = continuedResult || null;
  return {
    ok: eligibility?.ok ? Boolean(result?.ok ?? true) : false,
    decision: eligibility?.ok ? 'continued_work' : 'blocked',
    runId: result?.runId || result?.result?.runId || null,
    traceDir: result?.traceDir || result?.result?.traceDir || null,
    blockers: result?.blockers || result?.result?.blockers || eligibility?.blockers || [],
    warnings: result?.warnings || result?.result?.warnings || [],
    proposedActions: result?.proposedActions || result?.result?.proposedActions || [],
    proposalExecution: result?.proposalExecution || result?.result?.proposalExecution || null,
    verification: result?.verification || result?.result?.verification || null,
    commit: result?.commit || result?.result?.commit || null,
    backgroundWork,
  };
}

export async function finalizeContinuationRuntimeResult({
  sessionRoot,
  dataRoot,
  logger,
  command,
  message,
  sessionId,
  priorSession = null,
  selectedSkills = [],
  intent = null,
  session = null,
  activeWorkItem = null,
  continuationPlan = null,
  step = null,
  eligibility = null,
  continuedResult = null,
  delegatedWork = null,
  memoryStage = null,
  turnPlan = null,
  plannerObservability = null,
  routeDecision = null,
  canonicalTurnEnvelope = null,
  runtimeTurn = null,
  executionContext = null,
  subjectScope = null,
} = {}) {
  const preValidationBackgroundWork = compactContinuedWork({ item: activeWorkItem, step, result: continuedResult, updated: activeWorkItem, eligibility, continuationPlan });
  const preValidationWorkResult = continuationWorkResult({ eligibility, continuedResult, backgroundWork: preValidationBackgroundWork });
  validateRuntimeInvariantsBeforeSideEffects({ runtimeTurn, canonicalTurnEnvelope, workResult: preValidationWorkResult });

  const updatedItem = eligibility?.ok
    ? await appendWorkItemStep({ dataRoot, id: activeWorkItem.id, step, result: continuedResult })
    : activeWorkItem;
  const backgroundWork = compactContinuedWork({ item: activeWorkItem, step, result: continuedResult, updated: updatedItem, eligibility, continuationPlan });
  await logger.router({ stage: 'background-work-continue', intent, backgroundWork, continuationPlan, eligibility });
  const content = describeWorkStep({ step, updatedItem, result: continuedResult, eligibility });
  await appendRuntimeSessionTurn({ sessionRoot, sessionId, role: 'assistant', content, runId: logger.runId, traceDir: logger.traceDir, metadata: { ...(subjectScope ? { subjectScope } : {}), decision: eligibility?.ok ? 'continued_work' : 'blocked', backgroundWork } });
  const actionRoute = session.actionRoute ?? { kind: session.kind, route: session.kind, reason: session.reason ?? null };
  const activeKind = structuredWorkItemKind(activeWorkItem, session);
  const workflowSession = { ...session, kind: activeKind, workspaceRoot: activeWorkItem.workspaceRoot };
  const workflowActionRoute = { ...actionRoute, kind: activeKind };
  const workflow = workbenchWorkflow({ session: workflowSession, actionRoute: workflowActionRoute, workspaceRoot: activeWorkItem.workspaceRoot });
  const decision = eligibility?.ok ? 'continued_work' : 'blocked';
  const workResult = continuationWorkResult({ eligibility, continuedResult, backgroundWork });
  const outcome = buildOutcome({ decision, sessionId, session: workflowSession, backgroundWork, workResult });
  const workbenchStatus = buildWorkbenchStatus({
    decision,
    session: workflowSession,
    actionRoute: workflowActionRoute,
    workflow,
    backgroundWork,
    blockers: backgroundWork.blockers,
    warnings: session.warnings || [],
    runId: logger.runId,
    traceDir: logger.traceDir,
  });
  await appendValidatedRuntimeReceipt({
    sessionRoot,
    dataRoot,
    sessionId,
    logger,
    receiptInput: { decision, backgroundWork, workResult, outcome, turnPlan, plannerObservability, routeDecision, canonicalTurnEnvelope, runtimeTurn, executionContext, delegatedWork },
    invariantInput: { runtimeTurn, canonicalTurnEnvelope, workResult, memoryIntent: null, memory: null, memoryWrite: { written: false, reason: 'not_applicable' } },
    subjectScope,
  });
  return {
    ok: eligibility?.ok ? Boolean(continuedResult?.ok ?? true) : true,
    mode: 'ask',
    command,
    decision,
    runId: logger.runId,
    dataRoot,
    traceDir: logger.traceDir,
    selectedSkills,
    intent,
    sessionId,
    sessionContext: { sessionId: priorSession?.sessionId, priorTurns: priorSession?.turnCount },
    session: workflowSession,
    workbenchStatus,
    chatSupport: chatSupportStatus(workbenchStatus),
    debug: {
      actionRoute: workflowActionRoute,
      workbench: workflowSession.workbench,
      workbenchWorkflow: workflow,
      continuationPlan,
      delegatedWork,
    },
    backgroundWork,
    answerText: content,
    workResult: {
      runId: workResult.runId,
      traceDir: workResult.traceDir,
      decision: workResult.decision,
      blockers: workResult.blockers,
      warnings: workResult.warnings,
    },
    proposedActions: workResult.proposedActions ?? [],
    proposedActionCount: workResult.proposedActions?.length ?? 0,
    proposalExecution: compactExecution(workResult.proposalExecution),
    verification: workResult.verification,
    commit: workResult.commit,
    modelUsage: null,
    memoryStage,
    memory: null,
    handoffCandidate: null,
    memoryWrite: { written: false, reason: 'not_applicable' },
    outcome,
  };
}
