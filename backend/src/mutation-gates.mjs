import { finalAnswerAfterToolLoopPrompt } from './runtime-final-synthesis-prompt.mjs';
import { createModelAdapter } from './model-adapter.mjs';
import { executedToolResultPrompt } from './tool-continuation-prompt.mjs';
import path from 'node:path';
import { actionFromNativeToolCall, nativeToolSchemas, parseActionProposal } from './action-proposal.mjs';
import { reviewProposalActions } from './action-safety.mjs';
import { executeReviewedProposalActions } from './proposal-executor.mjs';
import { evaluateVerification, normalizeVerificationEvidence } from './verification.mjs';
import { runExec } from './harness/exec.mjs';
import { compactToolReceipts } from './runtime-result-shapes.mjs';
import { normalizeExecutionPolicyInput } from './execution-policy.mjs';
import { normalizeProviderMessages } from './provider-messages.mjs';
import { serializeContinuationEvidence } from './continuation-evidence.mjs';
import { hasExecutedInspectionEvidence, missingInspectionTargets, shouldFollowReadOnlyInspection, targetedUiInspectionMissingFallback, shouldForceInspectionEvidence, runDefaultReadOnlyInspection, pendingInspectionFallback } from './inspection-evidence.mjs';
import { recordMaterialProgress } from './tool-loop-detection.mjs';

export function hasExecutedMutationEvidence(toolResults = []) {
  return (toolResults || []).some((result) => result?.ok === true && ['files_write', 'files_edit', 'files_patch'].includes(String(result.tool || '')));
}

function mutationOnlyToolSchemas() {
  return nativeToolSchemas({ includeMutations: true })
    .filter((tool) => ['files_write', 'files_edit', 'files_patch'].includes(tool.function?.name));
}

function execOnlyToolSchemas() {
  return nativeToolSchemas({ includeMutations: false })
    .filter((tool) => tool.function?.name === 'shell_exec');
}

function proposalHasMutationAction(proposal = null) {
  return (proposal?.actions || []).some((action) => ['files_write', 'files_edit', 'files_patch'].includes(action.tool));
}

function hasMutationToolResult(toolResults = []) {
  return (toolResults || []).some((result) => ['files_write', 'files_edit', 'files_patch'].includes(String(result?.tool || '')));
}

function failedMutationToolResult(toolResults = []) {
  return (toolResults || []).find((result) => result?.ok === false && ['files_write', 'files_edit', 'files_patch'].includes(String(result?.tool || ''))) || null;
}

function hasFailedMutationToolResult(toolResults = []) {
  return Boolean(failedMutationToolResult(toolResults));
}

const MUTATION_REPAIR_MAX_ATTEMPTS = 5;

function mutationFailureSummary(result = {}) {
  if (!result) return 'unknown mutation failure';
  return [
    `Tool: ${result.tool || 'mutation'}`,
    `OK: ${result.ok ? 'true' : 'false'}`,
    result.filePath ? `Path: ${result.filePath}` : null,
    result.touchedFiles?.length ? `Touched files: ${result.touchedFiles.join(', ')}` : null,
    result.failureClass ? `Failure class: ${result.failureClass}` : null,
    result.gitApplyExitCode != null ? `git apply exit code: ${result.gitApplyExitCode}` : null,
    result.error ? `Error:\n${String(result.error).slice(0, 4000)}` : null,
  ].filter(Boolean).join('\n');
}

function structuredFollowupInput({ prompt, content }) {
  const messages = Array.isArray(prompt?.modelMessages) && prompt.modelMessages.length
    ? normalizeProviderMessages([...prompt.modelMessages, { role: 'user', content }])
    : null;
  return messages ? { messages } : { prompt: content };
}

function continuationPrompt({ prompt, message, toolResults, modelConfig, contextThreshold, tools, instructions, label = 'Executed continuation evidence:' }) {
  const buildPrompt = (evidence = '') => [prompt.text, '', ...instructions, '', 'User request:', message, '', label, evidence || '(no executed continuation evidence)'].join('\n');
  const evidence = serializeContinuationEvidence({ toolResults, modelConfig, contextThreshold, tools, buildPrompt, preparePrompt: (content) => {
    const input = structuredFollowupInput({ prompt, content });
    return input.messages ? { modelMessages: input.messages } : { text: input.prompt };
  } });
  return buildPrompt(evidence);
}

export async function completeMutationAfterInspection({ adapter, prompt, message, toolResults, modelConfig, contextThreshold, traceLogger }) {
  const followupPrompt = continuationPrompt({ prompt, message, toolResults, modelConfig, contextThreshold, tools: nativeToolSchemas(), instructions: [
    'The user explicitly asked for a fix/change. Read-only inspection was only preflight, not completion.',
    'Use the executed inspection evidence below. If the change is safe and inside scope, call files_write, files_edit or files_patch now. If you cannot safely patch, report the specific blocker. Do not ask the user to paste files and do not stop at analysis.',
  ], label: 'Executed inspection results:' });
  return adapter.complete({ ...structuredFollowupInput({ prompt, content: followupPrompt }), tools: nativeToolSchemas(), toolChoice: 'auto', traceLogger });
}

export async function completeMutationRepairAfterNoAction({ adapter, prompt, message, toolResults, modelConfig, contextThreshold, traceLogger }) {
  const repairPrompt = continuationPrompt({ prompt, message, toolResults, modelConfig, contextThreshold, tools: mutationOnlyToolSchemas(), instructions: [
    'Mutation is required and inspection already succeeded. Prose is not a valid completion for this turn.',
    'You must call files_write, files_edit or files_patch now. Those are the only available tools.',
    'If you cannot safely make a change, do not answer in prose; emit no tool call and the runtime will fail clearly.',
  ], label: 'Executed inspection results:' });
  return adapter.complete({ ...structuredFollowupInput({ prompt, content: repairPrompt }), tools: mutationOnlyToolSchemas(), toolChoice: 'auto', traceLogger });
}

export async function completeMutationRepairAfterToolFailure({ adapter, prompt, message, inspectionToolResults, failedMutationResult, modelConfig, contextThreshold, traceLogger, attempt = 1 }) {
  if (!failedMutationResult) return null;
  const repairPrompt = continuationPrompt({ prompt, message, toolResults: [...inspectionToolResults, failedMutationResult], modelConfig, contextThreshold, tools: mutationOnlyToolSchemas(), instructions: [
    `Repair attempt: ${attempt}`,
    'Mutation is still required. The previous mutation tool call failed mechanically; this is retryable.',
    'Regenerate the change and call files_write, files_edit or files_patch now. Those are the only available tools.',
    'If files_patch failed because the patch was malformed or empty, produce a valid unified diff or use files_write with complete file content.',
  ], label: 'Executed continuation evidence:' });
  return adapter.complete({ ...structuredFollowupInput({ prompt, content: repairPrompt }), tools: mutationOnlyToolSchemas(), toolChoice: 'auto', traceLogger });
}

export async function completeVerificationAfterMutation({ adapter, prompt, message, toolResults, modelConfig, contextThreshold, traceLogger }) {
  const verificationPrompt = continuationPrompt({ prompt, message, toolResults, modelConfig, contextThreshold, tools: execOnlyToolSchemas(), instructions: [
    'A file mutation succeeded, but verification is still missing. Continue; do not stop at the changed file.',
    'Run an appropriate local verification command now using exec. Use the project evidence and package scripts when available.',
    'Only shell_exec is available. If no verification command can be run, emit no tool call and the runtime will fail clearly.',
  ], label: 'Executed continuation evidence:' });
  return adapter.complete({ ...structuredFollowupInput({ prompt, content: verificationPrompt }), tools: execOnlyToolSchemas(), toolChoice: 'auto', traceLogger });
}

function proposalFromNativeToolCalls(toolCalls = [], fallbackText = '', executionContext = null) {
  if (!Array.isArray(toolCalls) || !toolCalls.length) return null;
  const actions = toolCalls.map((call, index) => actionFromNativeToolCall(call, index));
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

export async function runProposalLoop({
  ok = true,
  mode = 'dry-run',
  prompt,
  message,
  workspaceRoot = null,
  rootDir,
  dataRoot = null,
  sessionId = null,
  conversationId = null,
  authorityDecision = null,
  executionPolicy: executionPolicyInput = null,
  modelConfig = null,
  contextThreshold = null,
  modelAdapter = null,
  traceLogger = null,
  executeProposals = false,
  allowReviewRequiredProposals = false,
  readOnlyInspectionFollowup = false,
  requireInspectionEvidence = false,
  requiresMutation = false,
  initialToolResults = [],
  inspectionTargets = [],
  executionContext = null,
} = {}) {
  const executionPolicy = normalizeExecutionPolicyInput(executionPolicyInput || authorityDecision);
  let model = null;
  let adapter = null;
  // Every model turn sees the normal surface. Runtime policy and action validation,
  // rather than schema pruning, decide whether a selected action can execute.
  const tools = executionContext?.toolSchemas || nativeToolSchemas();
  // Tests and embedded callers may supply an already-configured adapter. They
  // must not be gated on a separately supplied modelConfig; production adapter
  // construction still requires an explicit selected model.
  if (ok && mode === 'model' && (modelAdapter || modelConfig?.model)) {
    adapter = modelAdapter || createModelAdapter({ config: modelConfig });
    model = await adapter.complete({ ...(Array.isArray(prompt.modelMessages) && prompt.modelMessages.length ? { messages: normalizeProviderMessages(prompt.modelMessages) } : { prompt: prompt.text }), tools, toolChoice: 'auto', traceLogger });
  }

  const resolvedToolResults = [...initialToolResults];
  let proposal = proposalFromNativeToolCalls(model?.choice?.toolCalls, model?.choice?.text ?? '', executionContext) || (model ? parseActionProposal(model.choice?.text ?? '') : null);
  let proposalReview = reviewProposalActions({ actions: proposal?.actions ?? [], workspaceRoot, executionContext });
  let proposalExecution = executeProposals && proposal
    ? await executeReviewedProposalActions({
        actions: proposal.actions,
        reviews: proposalReview.reviews,
        workspaceRoot,
        rootDir,
        dataRoot,
        sessionId,
        conversationId,
        executionPolicy,
        modelConfig,
        executionContext,
        traceLogger,
        allowReviewRequired: allowReviewRequiredProposals,
        observedToolResults: resolvedToolResults,
        })
    : { executed: 0, skipped: [], toolResults: [] };
  resolvedToolResults.push(...proposalExecution.toolResults);

  if (executeProposals && shouldForceInspectionEvidence({ inspectionRequired: requireInspectionEvidence, inspectionTargets, proposalExecution, message })) {
    const defaultInspectionResults = compactToolReceipts(await runDefaultReadOnlyInspection({ workspaceRoot, rootDir, dataRoot, traceLogger, inspectionTargets }));
    proposalExecution = {
      executed: proposalExecution.executed + defaultInspectionResults.length,
      skipped: proposalExecution.skipped,
      toolResults: [...proposalExecution.toolResults, ...defaultInspectionResults],
      defaultInspection: true,
    };
    resolvedToolResults.push(...defaultInspectionResults);
  }

  const missingTargetsAfterInspection = missingInspectionTargets(proposalExecution.toolResults, inspectionTargets);
  const missingTargetFallback = missingTargetsAfterInspection.length
    ? `I could not inspect the exact requested file target${missingTargetsAfterInspection.length === 1 ? '' : 's'}: ${missingTargetsAfterInspection.join(', ')}. I should not answer from unrelated file evidence.`
    : null;

  if (!missingTargetFallback && requiresMutation && adapter && hasExecutedInspectionEvidence(proposalExecution.toolResults) && shouldFollowReadOnlyInspection({ mode, ok, model, proposalExecution })) {
    const preflightToolResults = proposalExecution.toolResults;
    const mutationFollowup = await completeMutationAfterInspection({ adapter, prompt, message, toolResults: preflightToolResults, modelConfig, contextThreshold, traceLogger });
    let mutationProposal = proposalFromNativeToolCalls(mutationFollowup?.choice?.toolCalls, mutationFollowup?.choice?.text ?? '', executionContext) || (mutationFollowup ? parseActionProposal(mutationFollowup.choice?.text ?? '') : null);
    let mutationReview = reviewProposalActions({ actions: mutationProposal?.actions ?? [], workspaceRoot, executionContext });
    let mutationExecution = executeProposals && mutationProposal
      ? await executeReviewedProposalActions({
          actions: mutationProposal.actions,
          reviews: mutationReview.reviews,
          workspaceRoot,
          rootDir,
          dataRoot,
          sessionId,
          executionPolicy,
          modelConfig,
          executionContext,
          traceLogger,
          allowReviewRequired: allowReviewRequiredProposals,
          observedToolResults: [...resolvedToolResults, ...proposalExecution.toolResults],
            })
      : { executed: 0, skipped: [], toolResults: [] };
    let mutationRepair = null;
    let mutationRepairFailed = false;
    let mutationRepairToolFailed = false;
    if (executeProposals && !hasExecutedMutationEvidence(mutationExecution.toolResults)) {
      let repairExecutionTotal = { executed: 0, skipped: [], toolResults: [] };
      let lastRepairProposal = null;
      let lastRepairReview = null;
      let lastFailure = failedMutationToolResult(mutationExecution.toolResults);
      const mutationRepairHistory = [];
      let mutationRepairProviderFailed = false;
      for (let attempt = 0; attempt < MUTATION_REPAIR_MAX_ATTEMPTS && !hasExecutedMutationEvidence(repairExecutionTotal.toolResults); attempt += 1) {
        const repairAttempt = attempt + 1;
        const repair = lastFailure
          ? await completeMutationRepairAfterToolFailure({
              adapter,
              prompt,
              message,
              inspectionToolResults: preflightToolResults,
              failedMutationResult: lastFailure,
              modelConfig,
              contextThreshold,
              traceLogger,
              attempt: repairAttempt,
            })
          : await completeMutationRepairAfterNoAction({ adapter, prompt, message, toolResults: preflightToolResults, modelConfig, contextThreshold, traceLogger });
        mutationRepair = repair || mutationRepair;
        if (repair && !repair.ok) {
          mutationRepairProviderFailed = true;
          mutationRepairHistory.push({ attempt: repairAttempt, status: 'provider_failed', failureClass: lastFailure?.failureClass || null, tool: lastFailure?.tool || null, error: repair.error || 'model_failed' });
          break;
        }
        const repairProposal = proposalFromNativeToolCalls(repair?.choice?.toolCalls, repair?.choice?.text ?? '', executionContext) || (repair ? parseActionProposal(repair.choice?.text ?? '') : null);
        const repairReview = reviewProposalActions({ actions: repairProposal?.actions ?? [], workspaceRoot, executionContext });
        const repairExecution = executeProposals && repairProposal
          ? await executeReviewedProposalActions({
              actions: repairProposal.actions,
              reviews: repairReview.reviews,
              workspaceRoot,
              rootDir,
              dataRoot,
              sessionId,
              executionPolicy,
              modelConfig,
                    executionContext,
              traceLogger,
              allowReviewRequired: allowReviewRequiredProposals,
              observedToolResults: [...resolvedToolResults, ...proposalExecution.toolResults, ...mutationExecution.toolResults, ...repairExecutionTotal.toolResults],
                    })
          : { executed: 0, skipped: [], toolResults: [] };

        const failedRepairMutation = failedMutationToolResult(repairExecution.toolResults);
        repairExecutionTotal = {
          executed: repairExecutionTotal.executed + repairExecution.executed,
          skipped: [...(repairExecutionTotal.skipped || []), ...(repairExecution.skipped || [])],
          toolResults: [...repairExecutionTotal.toolResults, ...repairExecution.toolResults],
        };
        mutationRepairHistory.push({
          attempt: repairAttempt,
          status: hasExecutedMutationEvidence(repairExecution.toolResults) ? 'mutation_succeeded' : failedRepairMutation ? 'mutation_tool_failed' : 'no_mutation_action',
          tool: failedRepairMutation?.tool || (proposalHasMutationAction(repairProposal) ? 'mutation' : null),
          failureClass: failedRepairMutation?.failureClass || null,
          error: failedRepairMutation?.error ? String(failedRepairMutation.error).slice(0, 500) : null,
        });
        lastRepairProposal = repairProposal || lastRepairProposal;
        lastRepairReview = repairReview || lastRepairReview;

        if (hasExecutedMutationEvidence(repairExecution.toolResults)) break;
        if (!proposalHasMutationAction(repairProposal) && !hasMutationToolResult(repairExecution.toolResults)) break;

        const nextFailure = failedMutationToolResult(repairExecution.toolResults);
        if (!nextFailure) break;
        lastFailure = nextFailure;
      }

      mutationRepairFailed = !proposalHasMutationAction(lastRepairProposal) && !hasMutationToolResult(repairExecutionTotal.toolResults);
      mutationRepairToolFailed = !hasExecutedMutationEvidence(repairExecutionTotal.toolResults) && (hasFailedMutationToolResult(repairExecutionTotal.toolResults) || mutationRepairProviderFailed);
      mutationProposal = lastRepairProposal || mutationProposal;
      mutationReview = lastRepairReview || mutationReview;
      mutationExecution = {
        executed: mutationExecution.executed + repairExecutionTotal.executed,
        skipped: [...(mutationExecution.skipped || []), ...(repairExecutionTotal.skipped || [])],
        toolResults: [...mutationExecution.toolResults, ...repairExecutionTotal.toolResults],
        mutationRepairHistory,
        mutationRepairProviderFailed,
      };
    }
    proposal = mutationProposal || proposal;
    proposalReview = mutationReview;
    proposalExecution = {
      executed: proposalExecution.executed + mutationExecution.executed,
      skipped: [...(proposalExecution.skipped || []), ...(mutationExecution.skipped || [])],
      toolResults: [...proposalExecution.toolResults, ...mutationExecution.toolResults],
      defaultInspection: proposalExecution.defaultInspection,
      mutationFollowup: true,
      mutationRepair: Boolean(mutationRepair),
      mutationRepairFailed,
      mutationRepairToolFailed,
      mutationRepairProviderFailed: Boolean(mutationExecution.mutationRepairProviderFailed),
      mutationRepairHistory: mutationExecution.mutationRepairHistory || [],
      preflightToolResults,
    };
    resolvedToolResults.push(...mutationExecution.toolResults);
    model = mutationRepair || mutationFollowup || model;
  }

  let inspectionFollowup = null;
  const missingUiEvidenceFallback = targetedUiInspectionMissingFallback({ message, toolResults: proposalExecution.toolResults });
  if (missingTargetFallback) {
    proposal = { ok: true, format: 'plain-text', answerText: missingTargetFallback, actions: [], errors: [], raw: null };
  } else if (missingUiEvidenceFallback) {
    proposal = { ok: true, format: 'plain-text', answerText: missingUiEvidenceFallback, actions: [], errors: [], raw: null };
  } else if (readOnlyInspectionFollowup && shouldFollowReadOnlyInspection({ mode, ok, model, proposalExecution })) {
    let iterations = 0;
    let inspectionNoProgress = false;
    const observedEvidence = new Set();
    recordMaterialProgress(observedEvidence, proposalExecution.toolResults);
    while (inspectionFollowup?.ok !== false && !inspectionNoProgress) {
      iterations += 1;
      const followupPrompt = executedToolResultPrompt({
        basePrompt: prompt.text,
        message,
        toolResults: proposalExecution.toolResults,
        iteration: iterations,
        modelConfig,
        contextThreshold,
      });
      // Continuing inspection keeps the normal full surface; action review and
      // execution policy, not a narrowed tool list, decide what may execute.
      const continuationTools = executionContext?.toolSchemas || nativeToolSchemas();
      inspectionFollowup = await adapter.complete({ ...structuredFollowupInput({ prompt, content: followupPrompt }), tools: continuationTools, toolChoice: 'auto', traceLogger });
      if (!inspectionFollowup?.ok) break;
      const followupProposal = proposalFromNativeToolCalls(inspectionFollowup.choice?.toolCalls, inspectionFollowup.choice?.text ?? '', executionContext) || parseActionProposal(inspectionFollowup.choice?.text ?? '');
      if (!followupProposal?.actions?.length) {
        model = { ...inspectionFollowup, inspectionFollowup: true, initialModel: model };
        proposal = followupProposal;
        break;
      }
      const followupReview = reviewProposalActions({ actions: followupProposal.actions, workspaceRoot, executionContext });
      const followupExecution = executeProposals
        ? await executeReviewedProposalActions({
            actions: followupProposal.actions,
            reviews: followupReview.reviews,
            workspaceRoot,
            rootDir,
            dataRoot,
            sessionId,
            conversationId,
            executionPolicy,
            modelConfig,
                executionContext,
            traceLogger,
            allowReviewRequired: allowReviewRequiredProposals,
            observedToolResults: [...resolvedToolResults, ...proposalExecution.toolResults],
                })
        : { executed: 0, skipped: [], toolResults: [] };
      proposalExecution = {
        ...proposalExecution,
        executed: proposalExecution.executed + followupExecution.executed,
        skipped: [...proposalExecution.skipped, ...followupExecution.skipped],
        toolResults: [...proposalExecution.toolResults, ...followupExecution.toolResults],
        inspectionContinuation: true,
      };
      resolvedToolResults.push(...followupExecution.toolResults);
      // Terminal observations (for example a completed child reported again
      // through status-only tools) add no evidence. Synthesize now rather
      // than treating polling as another continuation opportunity.
      inspectionNoProgress = recordMaterialProgress(observedEvidence, followupExecution.toolResults) === 0;
      proposal = followupProposal;
      proposalReview = followupReview;
      model = inspectionFollowup;
    }
    if (inspectionNoProgress && inspectionFollowup?.ok && inspectionFollowup.choice?.toolCalls?.length) {
      const finalPrompt = finalAnswerAfterToolLoopPrompt({
        basePrompt: prompt.text,
        message,
        toolResults: proposalExecution.toolResults,
        skipped: proposalExecution.skipped,
        modelConfig,
        contextThreshold,
      });
      const finalModel = await adapter.complete({ ...structuredFollowupInput({ prompt, content: finalPrompt }), traceLogger });
      if (finalModel?.ok) {
        const finalProposal = proposalFromNativeToolCalls(finalModel.choice?.toolCalls, finalModel.choice?.text ?? '', executionContext) || parseActionProposal(finalModel.choice?.text ?? '');
        model = { ...finalModel, inspectionFollowup: true, inspectionNoProgress: true, initialModel: model };
        proposal = finalProposal?.actions?.length
          ? { ok: true, format: 'plain-text', answerText: finalModel.choice?.text || 'I collected the available evidence but could not safely complete the final synthesis.', actions: [], errors: [], raw: null }
          : finalProposal;
      } else {
        proposal = { ok: true, format: 'plain-text', answerText: `I collected the available inspection evidence, but the final synthesis failed: ${finalModel?.error || 'model error'}.`, actions: [], errors: [], raw: null };
      }
    } else if (inspectionFollowup && !inspectionFollowup.ok) {
      proposal = { ok: true, format: 'plain-text', answerText: `I inspected the requested local context, but the follow-up answer failed: ${inspectionFollowup.error || 'model error'}.`, actions: [], errors: [], raw: null };
    }
  } else {
    const fallback = pendingInspectionFallback({ proposal, proposalExecution });
    if (fallback) {
      proposal = { ok: true, format: 'plain-text', answerText: fallback, actions: [], errors: [], raw: null };
    }
  }

  return { model, proposal, proposalReview, proposalExecution, toolResults: resolvedToolResults, inspectionFollowup };
}

export async function runVerificationGate({
  ok = true,
  mode = 'dry-run',
  action = 'plan',
  model = null,
  artifacts = [],
  checks = [],
  toolResults = [],
  verifyCommand = null,
  verifyCwd = null,
  workspaceRoot = null,
  rootDir = null,
  traceLogger = null,
} = {}) {
  const resolvedToolResults = [...toolResults];
  if (ok && mode === 'model' && verifyCommand) {
    const verifyReview = reviewProposalActions({ actions: [{ index: 0, tool: 'shell_exec', command: verifyCommand, errors: [] }], workspaceRoot }).reviews[0];
    if (verifyReview.status !== 'allowed') {
      resolvedToolResults.push({ tool: 'shell_exec', ok: false, command: verifyCommand, verificationCheck: true, error: `verify_command_not_allowed:${verifyReview.status}`, safetyReview: verifyReview });
    } else {
      const verifyResult = await runExec({
        command: verifyCommand,
        cwd: verifyCwd || workspaceRoot || rootDir,
        traceLogger,
        artifactPrefix: 'verify-command',
      });
      resolvedToolResults.push(...compactToolReceipts([{ ...verifyResult, verificationCheck: true }]));
    }
  }

  const normalizationRoot = workspaceRoot || rootDir;
  const verificationEvidence = normalizeVerificationEvidence({ artifacts, checks, toolResults: resolvedToolResults, normalizationRoot, baseRoot: rootDir });
  const verification = evaluateVerification({ mode, action, model, verificationEvidence, normalizationRoot, baseRoot: rootDir });
  const modelOk = model?.ok ?? true;
  const verificationOk = verification.ok;
  const decision = !ok
    ? 'blocked'
    : mode !== 'model'
      ? 'ready'
      : !modelOk
        ? 'model_failed'
        : !verificationOk
          ? 'verification_failed'
          : 'answered';

  return {
    toolResults: resolvedToolResults,
    verification,
    modelOk,
    verificationOk,
    decision,
  };
}

function authorizedCommitPathsFromToolResults(toolResults = [], workspaceRoot = null) {
  if (!workspaceRoot) return [];
  const root = path.resolve(workspaceRoot);
  const paths = new Set();
  for (const result of toolResults || []) {
    if (!result?.ok) continue;
    if (['files_write', 'files_edit'].includes(result.tool) && result.filePath) paths.add(path.relative(root, path.resolve(result.filePath)));
    if (result.tool === 'files_patch') {
      for (const file of result.touchedFiles || []) {
        const resolved = path.isAbsolute(file) ? path.resolve(file) : path.resolve(result.baseRoot || root, file);
        paths.add(path.relative(root, resolved));
      }
    }
  }
  return [...paths].filter((file) => file && !file.startsWith('..') && !path.isAbsolute(file));
}

function changedPathsFromGitStatus(stdout = '') {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .map((file) => file.split(' -> ').pop());
}

export async function runCommitGate({
  commitChanges = false,
  ok = true,
  mode = 'dry-run',
  modelOk = true,
  verificationOk = true,
  workspaceRoot = null,
  rootDir = null,
  message = '',
  commitMessage = null,
  toolResults = [],
  traceLogger = null,
} = {}) {
  let commit = null;
  if (commitChanges && ok && mode === 'model' && modelOk && verificationOk) {
    if (!workspaceRoot) {
      commit = { ok: false, skipped: true, reason: 'git_context_required' };
    } else {
      const status = await runExec({
        command: 'git status --short',
        cwd: workspaceRoot,
        traceLogger,
        artifactPrefix: 'commit-status-before',
      });
      const authorizedPaths = authorizedCommitPathsFromToolResults(toolResults, workspaceRoot);
      const changedPaths = changedPathsFromGitStatus(status.stdout);
      const unauthorizedPaths = changedPaths.filter((file) => !authorizedPaths.includes(file));
      if (!status.stdout.trim()) {
        commit = { ok: true, skipped: true, reason: 'no_changes', status, authorizedPaths };
      } else if (!authorizedPaths.length) {
        commit = { ok: false, skipped: true, reason: 'no_authorized_commit_paths', status, authorizedPaths, unauthorizedPaths: changedPaths };
      } else if (unauthorizedPaths.length) {
        commit = { ok: false, skipped: true, reason: 'unauthorized_dirty_paths', status, authorizedPaths, unauthorizedPaths };
      } else {
        const add = await runExec({
          command: `git add -- ${authorizedPaths.map((file) => JSON.stringify(file)).join(' ')}`,
          cwd: workspaceRoot,
          traceLogger,
          artifactPrefix: 'commit-git-add',
        });
        const resolvedCommitMessage = commitMessage || `Burrow verified changes: ${String(message || 'model run').slice(0, 80)}`;
        const commitResult = add.ok ? await runExec({
          command: `git commit -m ${JSON.stringify(resolvedCommitMessage)}`,
          cwd: workspaceRoot,
          env: {
            GIT_AUTHOR_NAME: 'Burrow',
            GIT_AUTHOR_EMAIL: 'burrow@example.invalid',
            GIT_COMMITTER_NAME: 'Burrow',
            GIT_COMMITTER_EMAIL: 'burrow@example.invalid',
          },
          traceLogger,
          artifactPrefix: 'commit-git-commit',
        }) : null;
        commit = { ok: Boolean(add.ok && commitResult?.ok), skipped: false, reason: add.ok ? null : 'git_add_failed', status, add, commit: commitResult, authorizedPaths };
      }
    }
  } else if (commitChanges) {
    commit = { ok: false, skipped: true, reason: verificationOk ? 'not_committable' : 'verification_failed' };
  }

  return {
    commit,
    commitOk: commitChanges ? Boolean(commit?.ok) : true,
    decisionOverride: commitChanges && !commit?.ok ? 'commit_failed' : null,
  };
}


export { proposalFromNativeToolCalls };
