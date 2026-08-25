import { buildContinuationPlan } from './work-item-service.mjs';
import { buildWorkbenchStatus } from './workbench-status.mjs';
import { workbenchWorkflow } from './workbench-workflow.mjs';
import { runWorkbenchStep } from './workbench-runner.mjs';
import { finalizeBlockedRuntimeResult } from './runtime-blocked-result.mjs';
import { finalizeContinuationRuntimeResult } from './runtime-continuation-finalizer.mjs';

export async function runContinuationBranch({
  rootDir,
  sessionRoot,
  dataRoot,
  logger,
  command,
  message,
  sessionId,
  conversationId,
  priorSession,
  route,
  selectedSkills,
  intent,
  session,
  activeWorkItem,
  requestedItemId,
  explicitContinue,
  normalizedArgs,
  workspaceFiles,
  resolvedWorkingRoot,
  turnPlan,
  plannerObservability,
  routeDecision,
  canonicalTurnEnvelope,
  runtimeTurn,
  executionContext,
  subagents,
  verifiedSubjectScope,
  commitTerminalResult,
  compatibilityObserver,
  runWorkbenchStepOverride = null,
} = {}) {
  if (explicitContinue && requestedItemId && !activeWorkItem) {
    const continuationPlan = buildContinuationPlan({ item: null, requestedItemId, sessionId, args: normalizedArgs, workspaceFiles });
    const backgroundWork = {
      continued: false,
      created: false,
      attached: false,
      itemId: continuationPlan.itemId,
      status: null,
      kind: null,
      step: continuationPlan.step,
      workspaceRoot: null,
      targetFiles: continuationPlan.targetFiles.length ? continuationPlan.targetFiles : undefined,
      blockers: continuationPlan.blockers,
      allowedNextSteps: [],
      stepResult: null,
    };
    await logger.router({ stage: 'background-work-continue', intent, backgroundWork, continuationPlan, eligibility: continuationPlan.eligibility });
    const content = `I can't continue that yet: work item not found (${requestedItemId}).`;
    const actionRoute = session.actionRoute ?? { kind: session.kind, route: session.kind, reason: session.reason ?? null };
    const workbenchStatus = buildWorkbenchStatus({ decision: 'blocked', session, actionRoute, workflow: workbenchWorkflow({ session, actionRoute, workspaceRoot: resolvedWorkingRoot }), backgroundWork, blockers: backgroundWork.blockers, warnings: session.warnings || [], runId: logger.runId, traceDir: logger.traceDir });
    return commitTerminalResult({
      branch: 'missing_work_item',
      finalize: () => finalizeBlockedRuntimeResult({ sessionRoot, dataRoot, logger, command, sessionId, priorSession, selectedSkills, intent, session, workbenchStatus, debug: { actionRoute, continuationPlan, turnPlan, plannerObservability, routeDecision, canonicalTurnEnvelope, runtimeTurn, subagents, compatibilityReads: compatibilityObserver.reads }, backgroundWork, blockedReason: 'work_item_not_found', blockers: backgroundWork.blockers, content, userTurn: null, assistantTurn: { role: 'assistant', content, metadata: { decision: 'blocked', backgroundWork } }, subjectScope: verifiedSubjectScope }),
    });
  }

  if (activeWorkItem && explicitContinue) {
    const continuationPlan = buildContinuationPlan({ item: activeWorkItem, sessionId, args: normalizedArgs, workspaceFiles });
    const step = continuationPlan.step;
    const eligibility = continuationPlan.eligibility;
    let continuedResult = null;
    if (eligibility.ok) {
      try {
        const runStep = runWorkbenchStepOverride || runWorkbenchStep;
        continuedResult = await runStep({ rootDir, step, message: activeWorkItem.message, workspaceRoot: continuationPlan.workspaceRoot, verifyCommand: normalizedArgs.verify_command || normalizedArgs.verifyCommand || null, runId: `${logger.runId}-work-${step}`, conversationId, args: { ...normalizedArgs, data_root: dataRoot, session_id: sessionId, conversation_id: conversationId, files: continuationPlan.targetFiles }, parentPermissions: null });
      } catch (error) {
        const detail = String(error?.message || error || 'unknown error');
        continuedResult = {
          ok: false,
          step,
          decision: 'workbench_step_failed',
          blockers: [`workbench_step_failed:${detail}`],
          error: { name: error?.name || 'Error', message: detail },
        };
        await logger.event?.('background-work-continue-failed', { step, itemId: activeWorkItem.id, error: continuedResult.error });
      }
    }
    return commitTerminalResult({
      branch: 'continuation',
      finalize: () => finalizeContinuationRuntimeResult({ sessionRoot, dataRoot, logger, command, message, sessionId, priorSession, selectedSkills, intent, session, activeWorkItem, continuationPlan, step, eligibility, continuedResult, subagents, turnPlan, plannerObservability, routeDecision, canonicalTurnEnvelope, runtimeTurn, executionContext, subjectScope: verifiedSubjectScope }),
    });
  }
  return null;
}
