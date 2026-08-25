// Public compatibility adapter for the legacy `runBurrow(...)` entrypoint.
// Route/policy/prompt setup and result-shape compatibility stay here;
// model/proposal/verification/commit execution is delegated to RuntimeOrchestrator.
import path from 'node:path';
import { routeRequest } from './request-router.mjs';
import { resolveRuntimeTraceRoot, resolveSkillsConfig } from './config.mjs';
import { planTurn } from './turn-planner.mjs';
import { buildContextForTurn, prepareContextForTurn, preparedContextFromEngine } from './context-builder.mjs';
import { createTraceLogger } from './trace-logger.mjs';
import { completeVerificationAfterMutation, runCommitGate, runProposalLoop, runVerificationGate } from './runtime-orchestrator.mjs';
import { actionFromNativeToolCall, parseActionProposal } from './action-proposal.mjs';
import { reviewProposalActions } from './action-safety.mjs';
import { createModelAdapter } from './model-adapter.mjs';
import { executeReviewedProposalActions } from './proposal-executor.mjs';
import { createExecutionContext, resolveExecutionTarget } from './execution-context.mjs';
import { normalizeExecutionPolicyInput } from './execution-policy.mjs';
import { normalizeProviderMessages } from './provider-messages.mjs';
import { inspectAssembledPromptBudget } from './prompt-budget.mjs';
import { serializeFinalAnswerEvidence } from './final-answer-evidence.mjs';

function unique(values) {
  return [...new Set((values || []).filter(Boolean))];
}

function proposalFromNativeToolCalls(toolCalls = [], fallbackText = '') {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return null;
  const actions = toolCalls.map(actionFromNativeToolCall);
  const errors = actions.flatMap((action) => action.errors.map((message) => `action_${action.index}:${message}`));
  return {
    ok: errors.length === 0,
    format: 'native-tools',
    answerText: fallbackText || '',
    actions,
    errors,
    raw: { toolCalls },
  };
}

function successfulMutation(toolResults = []) {
  return (toolResults || []).some((result) => result?.ok === true && ['files_write', 'files_patch'].includes(result.tool));
}

function verificationMissingCheck(verification = {}) {
  return Boolean(verification?.required && !verification?.ok && verification.reason === 'model_answer_without_artifact_or_check' && (verification.evidence?.artifacts || 0) > 0 && (verification.evidence?.checks || 0) === 0 && !verification.evidence?.failedChecks);
}

function finalWorkAnswerPrompt({ basePrompt = '', message = '', result = {}, toolEvidence = '' } = {}) {
  return [
    basePrompt,
    '',
    'The local work loop has ended. Answer the user directly now using only the runtime-owned evidence below.',
    'Do not call tools. Do not invent filesystem facts. Do not claim a fix is correct unless the evidence proves it.',
    'If a patch/write succeeded, describe what changed and the verification result. If a patch/write failed, say no verified change was made and give the concrete failure.',
    'The runtime evidence below is authoritative over any earlier model narration.',
    '',
    'User request:',
    message,
    '',
    'Runtime decision:',
    result.decision || 'unknown',
    '',
    'Executed tool evidence:',
    toolEvidence || '(no executed tool evidence)',
  ].join('\n');
}

function proposalHasUsableAnswer(proposal = null) {
  const answer = String(proposal?.answerText || '').trim();
  if (!answer) return false;
  if (proposal?.format === 'json' && proposal?.raw && !Object.prototype.hasOwnProperty.call(proposal.raw, 'answer')) return false;
  return true;
}

function proposalAnswerText(proposal = null) {
  return proposalHasUsableAnswer(proposal) ? proposal.answerText : null;
}

async function completeFinalWorkAnswer({ mode, ok, modelOk, proposal, proposalExecution, prompt, message, partialResult, modelAdapter, modelConfig, contextThreshold, traceLogger } = {}) {
  if (mode !== 'model' || !ok || !modelOk) return null;
  if (proposalHasUsableAnswer(proposal)) return null;
  if (!proposal?.actions?.length && !(proposalExecution?.toolResults || []).length) return null;
  try {
    const adapter = modelAdapter || createModelAdapter({ config: modelConfig || {} });
    if (!Number.isFinite(Number(contextThreshold)) || contextThreshold <= 0 || contextThreshold >= 1) throw new Error('resolved_context_threshold_required');
    const baseInspection = inspectAssembledPromptBudget({ prompt: { text: finalWorkAnswerPrompt({ basePrompt: prompt.text, message, result: partialResult }) }, modelConfig });
    const finalEvidence = await serializeFinalAnswerEvidence({
      toolResults: partialResult.proposalExecution?.toolResults || [],
      verification: partialResult.verification || null,
      allowRaw: baseInspection.contextTokens !== null,
      fits: async (evidence) => {
        const candidate = finalWorkAnswerPrompt({ basePrompt: prompt.text, message, result: partialResult, toolEvidence: evidence });
        const inspection = inspectAssembledPromptBudget({ prompt: { text: candidate }, modelConfig });
        return inspection.contextTokens !== null && inspection.estimatedTokens <= Math.floor(inspection.contextTokens * contextThreshold);
      },
    });
    const finalPrompt = finalWorkAnswerPrompt({ basePrompt: prompt.text, message, result: partialResult, toolEvidence: finalEvidence });
    const final = await adapter.complete({
      ...(Array.isArray(prompt.modelMessages) && prompt.modelMessages.length
        ? { messages: normalizeProviderMessages([...prompt.modelMessages, { role: 'user', content: finalPrompt }]) }
        : { prompt: finalPrompt }),
      traceLogger,
    });
    if (!final?.ok) return null;
    const parsed = parseActionProposal(final.choice?.text ?? '');
    const answerText = String(parsed?.answerText || final.choice?.text || '').trim();
    return answerText ? { model: final, answerText } : null;
  } catch {
    return null;
  }
}

function canonicalInspectionTargetsFromActions(actions = [], { workspaceRoot = null, rootDir = null } = {}) {
  const baseRoot = workspaceRoot ? path.resolve(workspaceRoot) : null;
  return unique((actions || [])
    .filter((action) => action?.kind === 'inspect' && action.target && action.targetKind === 'file')
    .filter((action) => path.isAbsolute(action.target) || baseRoot)
    .map((action) => path.resolve(path.isAbsolute(action.target) ? action.target : path.join(baseRoot, action.target))));
}



export const RUNNER_COMPATIBILITY_CONTRACT = Object.freeze({
  entrypoint: 'runBurrow',
  role: 'compatibility-adapter',
  status: 'kept',
  runtimeBoundary: 'RuntimeOrchestrator',
  retireWhen: 'callers are migrated behind runtime turn contract with behavior coverage',
});

export async function runBurrow({
  rootDir,
  message,
  mode = 'dry-run',
  runId,
  dataRoot = null,
  sessionId = null,
  conversationId = null,
  authorityDecision = null,
  executionPolicy: executionPolicyInput = null,
  workspaceRoot = null,
  target = null,
  files = [],
  action = 'plan',
  traceLogger = null,
  artifacts = [],
  checks = [],
  toolResults = [],
  verifyCommand = null,
  verifyCwd = null,
  executeProposals = false,
  allowReviewRequiredProposals = false,
  allowMutationProposals = false,
  requiresMutation = false,
  commitChanges = false,
  commitMessage = null,
  readOnlyInspectionFollowup = false,
  requireInspectionEvidence = false,
  inspectionTargets = null,
  modelConfig = null,
  modelAdapter = null,
  skillConfig = null,
  transcript = [],
  contextEngine = null,
  workingContext = null,
  contextThreshold = null,
} = {}) {
  if (!rootDir) throw new Error('rootDir is required');
  if (!message || typeof message !== 'string') throw new Error('message is required');
  if (mode !== 'dry-run' && mode !== 'model') throw new Error(`unsupported mode: ${mode}`);
  // CLI model work has the same explicit-selection contract as UI chat. A
  // supplied test/embedded adapter is already a concrete model dependency.
  if (mode === 'model' && !modelAdapter && !modelConfig?.model) throw new Error('model selection required');

  const logger = traceLogger || createTraceLogger({ rootDir: await resolveRuntimeTraceRoot(rootDir), runId, sessionId });
  const resolvedTarget = target ? await resolveExecutionTarget(target) : null;
  const executionContext = createExecutionContext({
    sessionId,
    conversationId,
    workspaceRoot,
    target: resolvedTarget,
    dataRoot,
    cacheRoot: traceLogger?.traceDir || null,
  });
  const executionPolicy = normalizeExecutionPolicyInput(executionPolicyInput || authorityDecision);
  const resolvedSkillConfig = skillConfig || resolveSkillsConfig({});
  const workspaceContext = { workspaceRoot, files };
  const turnPlan = planTurn({
    message,
    action,
    memoryContext: {},
    workspaceContext,
    skillConfig: resolvedSkillConfig,
  });
  const route = await routeRequest({
    rootDir,
    message,
    memoryContext: {},
    skillConfig: resolvedSkillConfig,
    workspaceContext,
    turnPlan,
  });
  const policy = { ok: true, blockers: [], warnings: [], review: route.action?.review || null };
  await logger.router({
    stage: 'runner-route',
    mode,
    route,
    policy,
  });

  const preparedContext = contextEngine
    ? preparedContextFromEngine(contextEngine)
    : await prepareContextForTurn({
      rootDir,
      dataRoot,
      sessionId,
      contextConfig: {},
      modelConfig,
      selectedSkills: route.promptPlan.promptSkills.map((skill) => skill.id),
      transcript,
      logger,
    });
  const contextBuild = await buildContextForTurn({
    rootDir,
    dataRoot,
    sessionId,
    preparedContext,
    kernel: 'You are Hatchet. For direct questions about who or what you are, identify yourself as Hatchet and do not mention Burrow, the runtime, or the app unless the user explicitly asks about that product or runtime. Burrow is only the local runtime/app you operate through. Follow eligible global and agent-owned skill instructions when relevant.',
    selectedSkills: route.promptPlan.selectedSkills,
    promptSkills: route.promptPlan.promptSkills,
    modelProfile: null,
    supportContext: { workingContext },
    task: message,
    outputMode: mode === 'model' ? 'proposal' : 'plain',
    traceLogger: logger,
    modelConfig,
  });
  const prompt = contextBuild.prompt;

  const blockers = unique([
    ...policy.blockers,
  ]);
  const warnings = unique(policy.warnings);
  const ok = blockers.length === 0;
  const actionRequiresMutation = ['write', 'edit', 'patch', 'delete'].includes(action);
  const resolvedInspectionTargets = Array.isArray(inspectionTargets)
    ? inspectionTargets
    : canonicalInspectionTargetsFromActions(turnPlan.intentFacts?.actions || [], { workspaceRoot, rootDir });
  const proposalLoop = await runProposalLoop({
    ok,
    mode,
    prompt,
    message,
    workspaceRoot,
    rootDir,
    dataRoot,
    sessionId,
    conversationId,
    executionPolicy,
    modelConfig,
    contextThreshold,
    modelAdapter,
    traceLogger: logger,
    executeProposals,
    allowReviewRequiredProposals,
    allowMutationProposals,
    readOnlyInspectionFollowup,
    requireInspectionEvidence,
    inspectionTargets: resolvedInspectionTargets,
    requiresMutation: requiresMutation || actionRequiresMutation,
    initialToolResults: toolResults,
    executionContext,
  });
  const {
    model,
    proposal,
    proposalReview,
    proposalExecution,
    toolResults: proposalToolResults,
    inspectionFollowup,
  } = proposalLoop;
  let verificationGate = await runVerificationGate({
    ok,
    mode,
    action,
    model,
    artifacts,
    checks,
    toolResults: proposalToolResults,
    verifyCommand,
    verifyCwd,
    workspaceRoot,
    rootDir,
    traceLogger: logger,
  });

  if (mode === 'model' && ok && !verifyCommand && successfulMutation(proposalExecution?.toolResults) && verificationMissingCheck(verificationGate.verification)) {
    const adapter = modelAdapter || createModelAdapter({ config: modelConfig || {} });
    const verificationRepair = await completeVerificationAfterMutation({ adapter, prompt, message, toolResults: verificationGate.toolResults, modelConfig, contextThreshold, traceLogger: logger });
    const verificationProposal = proposalFromNativeToolCalls(verificationRepair?.choice?.toolCalls, verificationRepair?.choice?.text ?? '') || (verificationRepair ? parseActionProposal(verificationRepair.choice?.text ?? '') : null);
    const verificationReview = reviewProposalActions({ actions: verificationProposal?.actions ?? [], workspaceRoot });
    const verificationExecution = verificationProposal
      ? await executeReviewedProposalActions({
          actions: (verificationProposal.actions || []).filter((item) => item.tool === 'shell_exec'),
          reviews: verificationReview.reviews,
          workspaceRoot,
          rootDir,
          dataRoot,
          sessionId,
          executionPolicy,
          modelConfig,
          traceLogger: logger,
          allowReviewRequired: true,
          allowMutations: false,
          observedToolResults: verificationGate.toolResults,
        })
      : { executed: 0, skipped: [], toolResults: [] };
    proposalExecution.verificationRepair = true;
    proposalExecution.verificationRepairModel = verificationRepair || null;
    proposalExecution.skipped = [...(proposalExecution.skipped || []), ...(verificationExecution.skipped || [])];
    proposalExecution.toolResults = [...(proposalExecution.toolResults || []), ...verificationExecution.toolResults];
    verificationGate = await runVerificationGate({
      ok,
      mode,
      action,
      model: verificationRepair || model,
      artifacts,
      checks,
      toolResults: [...verificationGate.toolResults, ...verificationExecution.toolResults],
      verifyCommand,
      verifyCwd,
      workspaceRoot,
      rootDir,
      traceLogger: logger,
    });
    if (verificationMissingCheck(verificationGate.verification)) {
      verificationGate.verification.reason = 'verification_missing_check';
    }
  }

  const {
    toolResults: resolvedToolResults,
    verification: rawVerification,
    modelOk,
    verificationOk: rawVerificationOk,
    decision: baseDecision,
  } = verificationGate;
  const mutationRepairFailed = Boolean(proposalExecution?.mutationRepairFailed);
  const mutationRepairToolFailed = Boolean(proposalExecution?.mutationRepairToolFailed);
  const verification = mutationRepairFailed || mutationRepairToolFailed
    ? {
        ...rawVerification,
        required: true,
        ok: false,
        reason: mutationRepairFailed ? 'model_emitted_no_mutation_action' : 'mutation_tool_failed',
        requiredEvidence: rawVerification.requiredEvidence || ['diff_or_tool_artifact', 'passing_check'],
      }
    : rawVerification;
  const verificationOk = mutationRepairFailed || mutationRepairToolFailed ? false : rawVerificationOk;
  const commitGate = await runCommitGate({
    commitChanges,
    ok,
    mode,
    modelOk,
    verificationOk,
    workspaceRoot,
    rootDir,
    message,
    commitMessage,
    toolResults: resolvedToolResults,
    traceLogger: logger,
  });
  const { commit } = commitGate;
  const finalOk = ok && modelOk && verification.ok && commitGate.commitOk;
  const decision = mutationRepairFailed || mutationRepairToolFailed
    ? 'verification_failed'
    : commitGate.decisionOverride && baseDecision === 'answered'
      ? commitGate.decisionOverride
      : baseDecision;

  const skippedActions = proposalExecution?.skipped ?? [];
  const result = {
    ok: finalOk,
    mode,
    decision,
    blockers,
    warnings,
    runId: logger.runId,
    traceDir: logger.traceDir,
    selectedSkills: route.skills.selected.map((skill) => skill.id),
    promptChars: prompt.stats.totalChars,
    promptSections: prompt.stats.sections,
    route,
    policy,
    prompt,
    answerText: proposalAnswerText(proposal),
    modelUsage: model?.usage ?? null,
    inspectionFollowup: inspectionFollowup ? { ok: inspectionFollowup.ok, usage: inspectionFollowup.usage ?? null } : null,
    proposedActions: proposal?.actions ?? [],
    proposal,
    proposalReview,
    proposalExecution,
    skippedActions,
    verification,
    commit,
    model,
  };
  const finalAnswer = await completeFinalWorkAnswer({ mode, ok, modelOk, proposal, proposalExecution, prompt, message, partialResult: result, modelAdapter, modelConfig, contextThreshold, traceLogger: logger });
  if (finalAnswer?.answerText) {
    result.answerText = finalAnswer.answerText;
    result.finalAnswerModel = finalAnswer.model;
    result.modelUsage = {
      initial: model?.usage ?? null,
      final: finalAnswer.model?.usage ?? null,
    };
  }

  await logger.router({
    stage: 'runner-result',
    ok: result.ok,
    decision: result.decision,
    blockers: result.blockers,
    warnings: result.warnings,
    promptChars: result.promptChars,
    verification: result.verification,
    proposedActions: result.proposedActions?.length ?? 0,
    proposalReview: result.proposalReview?.counts ?? {},
    proposalExecution: { executed: result.proposalExecution?.executed ?? 0, skipped: result.proposalExecution?.skipped?.length ?? 0 },
    commit: result.commit ? { ok: result.commit.ok, skipped: result.commit.skipped, reason: result.commit.reason } : null,
  });

  return result;
}
