import { appendWorkItemStep } from './work-item-store.mjs';
import { recentFileReferentsFromToolResults, withRecentFileReferents } from './file-referents.mjs';
import { appendRuntimeActivity, appendRuntimeSessionTurn } from './runtime-session-writer.mjs';
import { appendValidatedRuntimeReceipt, validateCompletedRuntimeInvariantsBeforeSideEffects, validateRuntimeInvariantsBeforeSideEffects } from './runtime-receipt-finalizer.mjs';
import { buildOutcome, changedPathsFromToolResults, compactExecution } from './runtime-result-shapes.mjs';
import { completionEvidence } from './completion-addendum.mjs';

function skippedActionSummaries(skipped = []) {
  return [...new Set((skipped || []).map((item) => `${item.tool || 'action'}:${item.status || 'skipped'}`))];
}

function failedMutationSummary(toolResults = []) {
  const failed = (toolResults || []).find((result) => result?.ok === false && ['files_write', 'files_patch'].includes(result.tool));
  if (!failed) return null;
  const error = String(failed.error || 'mutation tool failed').trim();
  const failureClass = failed.failureClass ? `${failed.failureClass}: ` : '';
  return `No change was made. The model emitted a ${failed.tool} mutation action, but it failed: ${failureClass}${error}`;
}

export function summarizeWorkLoopResult(result) {
  if (!result) return null;
  if (result.decision === 'blocked') return `Blocked: ${(result.blockers || []).join(', ') || 'boundary hit'}.`;
  if (result.decision === 'model_failed') return `Model failed: ${result.model?.error || 'model error'}.`;
  const changed = changedPathsFromToolResults(result.proposalExecution?.toolResults || []);
  const skipped = skippedActionSummaries(result.proposalExecution?.skipped || []);
  if (result.decision === 'verification_failed') {
    const reason = result.verification?.reason || 'verification failed';
    if (changed.length) return `Changed: ${changed.join(', ')}. Verification failed: ${reason}. Not complete.`;
    if (skipped.length) return `Skipped ${skipped.length} proposed action${skipped.length === 1 ? '' : 's'} (${skipped.join(', ')}). Verification failed: ${reason}. Not complete.`;
    if (reason === 'mutation_tool_failed') {
      return failedMutationSummary(result.proposalExecution?.toolResults || []) || 'No change was made. The model emitted a mutation action, but the mutation tool failed.';
    }
    if (reason === 'model_emitted_no_mutation_action') {
      return 'No change was made. Mutation execution was allowed and tools were available, but the model emitted no mutation action.';
    }
    if (reason === 'verification_missing_check') {
      return 'Changed files were produced, but no passing verification check ran. Not complete.';
    }
    if (reason === 'model_answer_without_artifact_or_check') {
      return 'I did not make a verified change. The model answered without producing a file change or check artifact, so I’m not claiming this is fixed.';
    }
    return `I could not verify the requested local change: ${reason}.`;
  }
  const executed = result.proposalExecution?.executed ?? 0;
  const checks = result.verification?.evidence?.checks ?? 0;
  const parts = [];
  if (result.answerText) parts.push(result.answerText);
  const readOnlyExecuted = (result.proposalExecution?.toolResults || [])
    .filter((toolResult) => toolResult.ok && ['files_read', 'shell_exec'].includes(toolResult.tool))
    .length;
  const shouldMentionExecution = executed && changed.length;
  if (shouldMentionExecution) parts.push(`Executed ${executed} local action${executed === 1 ? '' : 's'}.`);
  if (!result.answerText && readOnlyExecuted && !changed.length) parts.push('I inspected the local context.');
  if (changed.length) parts.push(`Changed: ${[...new Set(changed)].join(', ')}.`);
  if (skipped.length) parts.push(`Skipped ${skipped.length} proposed action${skipped.length === 1 ? '' : 's'} (${skipped.join(', ')}).`);
  if (result.verification?.required) parts.push(result.verification.ok ? `Verification passed (${checks} check${checks === 1 ? '' : 's'}).` : `Verification failed: ${result.verification.reason}.`);
  return parts.join(' ') || (result.ok ? 'Done.' : `Blocked: ${result.decision}.`);
}

function observedKindFromWorkResult(workResult = {}) {
  const toolResults = workResult?.proposalExecution?.toolResults || [];
  const mutationExecuted = toolResults.some((result) => result?.ok && ['files_write', 'files_patch'].includes(result.tool));
  if (mutationExecuted) return 'mutate';
  return 'answer';
}

function workItemActivityContent(backgroundWork = {}) {
  if (!backgroundWork) return null;
  if (backgroundWork.created) return `Work item created: ${backgroundWork.step || backgroundWork.status || 'pending'}`;
  if (backgroundWork.continued) return `Work item continued: ${backgroundWork.step || 'next step'}`;
  if (backgroundWork.blockers?.length) return `Work item blocked: ${backgroundWork.blockers[0]}`;
  if (backgroundWork.step) return `Work item updated: ${backgroundWork.step}`;
  return null;
}

export async function finalizeWorkLoopRuntimeResult({
  sessionRoot,
  dataRoot,
  logger,
  command,
  message,
  sessionId,
  priorSession = null,
  route = null,
  selectedSkills = [],
  intent = null,
  session = null,
  actionRoute = null,
  workspaceRoot = null,
  workResult = null,
  trackedWorkItem = null,
  trackedBackgroundWork = null,
  trackedWorkCreated = false,
  trackedWorkStep = null,
  compactTrackedWorkItem,
  turnPlan = null,
  plannerObservability = null,
  routeDecision = null,
  canonicalTurnEnvelope = null,
  runtimeTurn = null,
  delegatedWork = null,
  fileDeicticResolution = null,
  executionContext = null,
  subjectScope = null,
} = {}) {
  validateRuntimeInvariantsBeforeSideEffects({ runtimeTurn, canonicalTurnEnvelope, workResult });
  const content = summarizeWorkLoopResult(workResult);
  const completion = completionEvidence({ toolResults: workResult.proposalExecution?.toolResults || [], verification: workResult.verification, decision: workResult.decision });
  const recentFiles = recentFileReferentsFromToolResults(workResult.proposalExecution?.toolResults ?? [], {
    workspaceRoot,
    runId: workResult.runId,
    traceDir: workResult.traceDir,
  });
  const assistantMetadata = withRecentFileReferents({ ...(subjectScope ? { subjectScope } : {}), decision: workResult.decision, workRunId: workResult.runId, proposedActions: workResult.proposedActions?.length ?? 0, executedActions: workResult.proposalExecution?.executed ?? 0, verification: workResult.verification }, recentFiles);
  await appendRuntimeSessionTurn({ sessionRoot, sessionId, role: 'assistant', content, runId: logger.runId, traceDir: logger.traceDir, metadata: assistantMetadata });
  const observedKind = observedKindFromWorkResult(workResult);
  let updatedTrackedWorkItem = trackedWorkItem;
  let updatedTrackedBackgroundWork = trackedBackgroundWork;
  if (trackedWorkItem && trackedWorkStep) {
    updatedTrackedWorkItem = await appendWorkItemStep({ dataRoot, id: trackedWorkItem.id, step: trackedWorkStep, result: workResult });
    updatedTrackedBackgroundWork = compactTrackedWorkItem({ item: updatedTrackedWorkItem, created: trackedWorkCreated, step: trackedWorkStep, result: workResult });
    await appendRuntimeActivity({
      dataRoot,
      sessionId,
      logger,
      content: workItemActivityContent(updatedTrackedBackgroundWork),
      metadata: { backgroundWork: updatedTrackedBackgroundWork, workItemId: updatedTrackedWorkItem.id, workRunId: workResult.runId },
    });
  }
  const outcome = buildOutcome({
    decision: workResult.decision,
    sessionId,
    session,
    backgroundWork: updatedTrackedBackgroundWork,
    workResult,

    recentFiles,
  });
  const workbenchStatus = null;
  await appendValidatedRuntimeReceipt({
    sessionRoot,
    dataRoot,
    sessionId,
    logger,
    receiptInput: { decision: workResult.decision, backgroundWork: updatedTrackedBackgroundWork, workResult, recentFiles, outcome, turnPlan, plannerObservability, routeDecision, canonicalTurnEnvelope, runtimeTurn, executionContext, delegatedWork, completionEvidence: completion },
    invariantInput: { runtimeTurn, canonicalTurnEnvelope, workResult, memory: workResult.memory },
    subjectScope,
  });
  return {
    ok: workResult.ok,
    mode: 'ask',
    command,
    decision: workResult.decision,
    runId: logger.runId,
    dataRoot,
    traceDir: logger.traceDir,
    selectedSkills,
    intent,
    route,
    sessionId,
    sessionContext: { sessionId: priorSession?.sessionId, priorTurns: priorSession?.turnCount },
    session,
    observedResultKind: observedKind,
    workbenchStatus,
    chatSupport: null,
    debug: { actionRoute, observedResultKind: observedKind, actionReview: route?.action?.review, fileDeicticResolution, workResult, outcome, turnPlan, plannerObservability, routeDecision, canonicalTurnEnvelope, runtimeTurn, delegatedWork },
    backgroundWork: updatedTrackedBackgroundWork,
    answerText: content,
    completionEvidence: completion,
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
    modelUsage: workResult.modelUsage,
    outcome,
    prompt: workResult.prompt,
  };
}
