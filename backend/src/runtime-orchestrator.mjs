import { finalAnswerAfterToolLoopPrompt } from './runtime-final-synthesis-prompt.mjs';
import { accumulateCompletionEvidence } from './completion-addendum.mjs';
import { compactSkippedToolActions, skippedToolSummary, executedToolResultPrompt } from './tool-continuation-prompt.mjs';
import path from 'node:path';
import { nativeToolSchemas, parseActionProposal } from './action-proposal.mjs';
import { reviewProposalActions } from './action-safety.mjs';
import { createModelAdapter } from './model-adapter.mjs';
import { executeReviewedProposalActions } from './proposal-executor.mjs';
import { createRuntimeTurnResult, assertRuntimeTurnContract } from './chat-runtime-contracts.mjs';
import { normalizeExecutionPolicyInput } from './execution-policy.mjs';
import { accumulateToolConsequences, summarizeToolResults } from './runtime-result-shapes.mjs';
import { inspectRuntimeObject } from './runtime-heap-diagnostics.mjs';
import { normalizeProviderMessages } from './provider-messages.mjs';
import { serializeContinuationEvidence } from './continuation-evidence.mjs';
import { inspectionResultSummary, shouldFollowReadOnlyInspection, hasExecutedInspectionEvidence, hasExecutedReadFileEvidence, missingInspectionTargets, shouldForceInspectionEvidence, defaultInspectionFileList, runDefaultReadOnlyInspection, pendingInspectionFallback } from './inspection-evidence.mjs';
import { CHAT_TOOL_HISTORY_LIMIT, CHAT_TOOL_RESULT_HISTORY_LIMIT, CHAT_TOOL_CALL_HISTORY_LIMIT, compactToolCalls, boundedToolArgumentValue, stableJson, fingerprint, toolPlanFingerprint, exactRepeatVerdict, loopReceiptText, appendBoundedChatHistory, appendBoundedMapEntry, compactPromptEvidenceResult, runtimeObservationFacts, materialEvidenceKeys, recordMaterialProgress, repeatedToolCallObservations, semanticInspectionObservations, logChatToolLoopHeapStage, normalizedToolOutcome } from './tool-loop-detection.mjs';
import { runProposalLoop, runVerificationGate, runCommitGate, completeMutationAfterInspection, completeMutationRepairAfterNoAction, completeMutationRepairAfterToolFailure, completeVerificationAfterMutation, proposalFromNativeToolCalls } from './mutation-gates.mjs';
import { prepareNativeToolContinuation } from './native-continuation-preparation.mjs';
import { adapterOutputArtifactsFromResult } from './model-output-artifacts.mjs';

// facts for the agent and operator; they are not instructions or tool gates.
export async function runRuntimeTurn({
  runtimeTurn,
  branch = 'plain-model',
  plainModelTurn = {},
  workLoopTurn = {},
} = {}) {
  assertRuntimeTurnContract(runtimeTurn);
  if (branch === 'work-loop') {
    const result = await runWorkLoopTurn(workLoopTurn);
    return { ...result, branch, runtimeTurn };
  }
  if (branch !== 'plain-model') throw new Error(`unsupported runtime turn branch: ${branch}`);
  const result = await runPlainModelTurn(plainModelTurn);
  return { ...result, branch, runtimeTurn };
}


function hasNativeToolCalls(model = null) {
  return Boolean(model?.ok && Array.isArray(model.choice?.toolCalls) && model.choice.toolCalls.length);
}

function compactLoopProposal(proposal = null) {
  if (!proposal) return null;
  return {
    ok: Boolean(proposal.ok),
    format: proposal.format || null,
    answerText: typeof proposal.answerText === 'string' ? proposal.answerText.slice(0, 4_000) : '',
    actions: (proposal.actions || []).slice(0, 32).map((action) => boundedToolArgumentValue(action)),
    errors: (proposal.errors || []).slice(0, 32).map((error) => String(error).slice(0, 1_000)),
  };
}

function compactLoopProposalReview(proposalReview = null) {
  if (!proposalReview) return null;
  return {
    ok: Boolean(proposalReview.ok),
    counts: boundedToolArgumentValue(proposalReview.counts || {}),
    reviews: (proposalReview.reviews || []).slice(0, 32).map((review) => ({
      index: review?.index ?? null,
      tool: review?.tool || null,
      status: review?.status || null,
      risk: (review?.risk || []).slice(0, 16).map((item) => String(item).slice(0, 256)),
      blockers: (review?.blockers || []).slice(0, 16).map((item) => String(item).slice(0, 1_000)),
      warnings: (review?.warnings || []).slice(0, 16).map((item) => String(item).slice(0, 1_000)),
    })),
  };
}

function ownershipMetrics(value) {
  return inspectRuntimeObject(value, { nodeBudget: 5_000, estimatedCharBudget: 2_000_000, stringSampleChars: 8_000 });
}

function allSkippedChatTools(chatToolLoop = {}) {
  return chatToolLoop.skipped || (chatToolLoop.iterations || []).flatMap((iteration) => iteration.proposalExecution?.skipped || []);
}

function skippedMutationOrUnverifiedExec(skipped = []) {
  return (skipped || []).filter((item) => ['files_write', 'files_patch'].includes(String(item.tool || '')));
}

function hasExecutedMutationEvidence(toolResults = []) {
  return (toolResults || []).some((result) => result?.ok === true && ['files_write', 'files_patch'].includes(String(result.tool || '')));
}

function mutationNotExecutedAnswer({ skipped = [], toolResults = [] } = {}) {
  const skippedMutations = skippedMutationOrUnverifiedExec(skipped);
  if (!skippedMutations.length || hasExecutedMutationEvidence(toolResults)) return null;
  const skippedText = skippedToolSummary(skippedMutations);
  const readOnlyCount = (toolResults || []).filter((result) => result?.ok === true && result?.tool === 'files_read').length;
  return [
    'I did not edit the file.',
    'A mutation tool call was requested but was NOT EXECUTED. Inspect the recorded skipped-tool receipt for its structural or configured hard-block reason.',
    skippedText,
    readOnlyCount ? `I only executed ${readOnlyCount} read-only inspection tool${readOnlyCount === 1 ? '' : 's'}.` : null,
  ].filter(Boolean).join('\n\n');
}


async function executeChatToolCalls({ model, workspaceRoot = null, rootDir = null, dataRoot = null, sessionId = null, conversationId = null, iteration = 0, traceLogger = null, executionPolicy = null, modelConfig = null, executionContext = null, abortSignal = null } = {}) {
  const proposal = proposalFromNativeToolCalls(model?.choice?.toolCalls, model?.choice?.text ?? '', executionContext);
  const proposalReview = reviewProposalActions({ actions: proposal?.actions ?? [], workspaceRoot, executionContext });
  const proposalExecution = proposal
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
        artifactPrefix: `chat-${iteration}`,
        allowReviewRequired: false,
        observedToolResults: [],
          abortSignal,
      })
    : { executed: 0, skipped: [], toolResults: [] };
  const resultsByAllowedAction = new Map();
  let resultIndex = 0;
  for (const action of proposal?.actions || []) {
    const review = proposalReview.reviews.find((item) => item.index === action.index);
    if (review?.status === 'allowed') resultsByAllowedAction.set(action.index, (proposalExecution.nativeToolResults || proposalExecution.toolResults)[resultIndex++] || null);
  }
  // Provider-native transcripts require one output for every input call. A
  // malformed or policy-denied call is a failed tool result, not a missing
  // result or a terminal human-facing pseudo-blocker. That lets the model
  // correct its arguments on the next turn.
  const callResults = (model?.choice?.toolCalls || []).map((call, index) => {
    const action = proposal?.actions?.find((item) => item.index === index) || null;
    const review = proposalReview.reviews.find((item) => item.index === index) || null;
    const executedResult = resultsByAllowedAction.get(index);
    if (executedResult) return executedResult;
    const reasons = review?.blockers?.length ? review.blockers : (action?.errors?.length ? action.errors : ['tool_call_not_executed']);
    return {
      tool: call?.name || action?.tool || null,
      ok: false,
      status: review?.status || 'not_executed',
      failureClass: action?.errors?.length ? 'invalid_tool_arguments' : 'tool_not_executed',
      error: reasons.join(', '),
      validationErrors: reasons,
      callId: call?.id || null,
    };
  });
  return { proposal, proposalReview, proposalExecution, toolCalls: model?.choice?.toolCalls || [], callResults };
}

function isImageAttachment(attachment = {}) {
  const type = String(attachment.type || attachment.mimeType || '').toLowerCase();
  const content = String(attachment.content || '').toLowerCase();
  return type.startsWith('image/') || content.startsWith('data:image/');
}

function modelSupportsVision({ modelConfig = null, modelAdapter = null } = {}) {
  if (modelAdapter?.supportsVision !== undefined) return Boolean(modelAdapter.supportsVision);
  const capabilities = modelConfig?.capabilities || {};
  return Boolean(modelConfig?.supportsVision || modelConfig?.vision || modelConfig?.multimodal || capabilities.vision || capabilities.images);
}

function compactImageAttachment(attachment = {}, index = 0) {
  return {
    index,
    name: String(attachment.name || `image-${index + 1}`),
    type: String(attachment.type || attachment.mimeType || 'image/*'),
    size: attachment.size ?? null,
    dataUrl: String(attachment.content || ''),
  };
}

function imageAttachments(attachments = []) {
  return attachments.filter(isImageAttachment).map(compactImageAttachment).filter((attachment) => attachment.dataUrl.startsWith('data:image/'));
}

function messageTextContent(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(messageTextContent).filter(Boolean).join('\n');
  if (typeof value !== 'object') return '';
  const type = String(value.type || '').toLowerCase();
  if (type === 'image_url' || type === 'input_image' || value.image_url || value.input_image) return '';
  return messageTextContent(value.text ?? value.content ?? value.message ?? value.output);
}

function imageFallbackPrompt(promptText, images = []) {
  if (!images.length) return promptText;
  const lines = images.map((image, index) => `- ${image.name || `image-${index + 1}`} (${image.type || 'image/*'}, ${image.size ?? 'unknown'} bytes)`);
  return `${promptText}\n\n# Image attachments\n\n${images.length} image attachment${images.length === 1 ? ' was' : 's were'} provided, but the selected model profile does not advertise vision support. Ask the user to switch to a vision-capable profile if image contents matter.\n${lines.join('\n')}`;
}

function multimodalUserMessages(promptText, images = [], baseMessages = []) {
  return [...baseMessages, {
    role: 'user',
    content: [
      { type: 'text', text: promptText },
      ...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
    ],
  }];
}

function modelInputForPlainTurn({ promptText, promptMessages = null, attachments = [], modelConfig = null, modelAdapter = null } = {}) {
  const images = imageAttachments(attachments);
  const messages = Array.isArray(promptMessages) && promptMessages.length ? promptMessages : null;
  if (!images.length) return { prompt: messages ? null : promptText, messages, imageCount: 0, images, vision: false, fallback: false };
  if (modelSupportsVision({ modelConfig, modelAdapter })) {
    // Images belong to the current request, not every historical user turn.
    // Keep prior user/assistant roles intact and make only the final user
    // message multimodal. Collapsing every user message into one image prompt
    // destroys the dialogue shape that the provider uses for continuity.
    if (messages) {
      const lastUserIndex = messages.reduce((latest, entry, index) => entry?.role === 'user' ? index : latest, -1);
      if (lastUserIndex >= 0) {
        const multimodalMessages = messages.map((entry, index) => index === lastUserIndex ? {
          ...entry,
          content: [
            { type: 'text', text: messageTextContent(entry.content) },
            ...images.map((image) => ({ type: 'image_url', image_url: { url: image.dataUrl } })),
          ],
        } : entry);
        return { prompt: null, messages: multimodalMessages, stableMessages: messages.slice(0, lastUserIndex), imageCount: images.length, images, vision: true, fallback: false };
      }
    }
    return { prompt: null, messages: multimodalUserMessages(promptText, images), stableMessages: [], imageCount: images.length, images, vision: true, fallback: false };
  }
  if (messages) {
    const last = messages.length - 1;
    return { prompt: null, messages: messages.map((entry, index) => index === last && entry.role === 'user' ? { ...entry, content: imageFallbackPrompt(String(entry.content || ''), images) } : entry), imageCount: images.length, images, vision: false, fallback: true };
  }
  return { prompt: imageFallbackPrompt(promptText, images), messages: null, imageCount: images.length, images, vision: false, fallback: true };
}

function currentUserGenerationInstruction(message = '', promptMessages = null) {
  if (String(message || '').trim()) return String(message).trim();
  const messages = Array.isArray(promptMessages) ? promptMessages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'user') continue;
    const content = messageTextContent(messages[index].content).trim();
    if (content) return content;
  }
  throw new Error('current user generation instruction is required');
}

function modelInputForFollowupPrompt(promptText, baseModelInput = null) {
  // Compatibility follow-ups still describe a bounded evidence window in prose,
  // but they must not discard the canonical role-structured request that led to
  // it. Keep the stable prefix and dialogue as messages, then append one
  // synthesized current user instruction. This gives fallback/final-synthesis
  // calls the same normalizer and manifest path as normal and vision requests.
  if (baseModelInput?.vision) return { prompt: null, messages: multimodalUserMessages(promptText, baseModelInput.images || [], baseModelInput.stableMessages || []) };
  if (Array.isArray(baseModelInput?.messages) && baseModelInput.messages.length) {
    return {
      prompt: null,
      messages: normalizeProviderMessages([
        ...baseModelInput.messages,
        { role: 'user', content: promptText },
      ]),
    };
  }
  return { prompt: promptText, messages: null };
}

export async function runPlainModelTurn({
  prompt,
  message = '',
  shouldCallModel = true,
  modelConfig = null,
  contextThreshold = null,
  modelAdapter = null,
  traceLogger = null,
  workspaceRoot = null,
  rootDir = null,
  dataRoot = null,
  sessionId = null,
  conversationId = null,
  enableChatToolLoop = false,
  stopOnNoProgress = false,
  loopWarningThreshold = 2,
  loopBlockThreshold = 3,
  authorityDecision = null,
  executionPolicy: executionPolicyInput = null,
  abortSignal = null,
  attachments = [],
  executionContext = null,
  onTextDelta = null,
  onThoughtDelta = null,
  onContextUsage = null,
} = {}) {
  if (!prompt?.text) throw new Error('prompt.text is required');
  if (!shouldCallModel) {
    return {
      model: null,
      proposal: null,
      answerText: null,
      chatToolLoop: { enabled: false, iterations: [], toolResults: [] },
      runtime: createRuntimeTurnResult({ blocker: 'model_not_called', metadata: { calledModel: false } }),
    };
  }

  let model = null;
  // Defined outside the provider-call setup so failed/no-callback turns still
  // return a harmless null meter value.
  let peakContextUsage = null;
  let modelInput = modelInputForPlainTurn({ promptText: prompt.text, promptMessages: prompt.modelMessages, attachments, modelConfig, modelAdapter });
  // Responses chains server-side by response ID. Chat Completions needs this
  // local, provider-native transcript so prior call/result pairs survive.
  let nativeTranscript = null;
  const executionPolicy = normalizeExecutionPolicyInput(executionPolicyInput || authorityDecision);
  const executionToolSchemas = executionContext?.toolSchemas || nativeToolSchemas();
  let closePeerExchangeAfterReply = false;
  const continuationToolSchemas = () => closePeerExchangeAfterReply
    ? executionToolSchemas.filter((tool) => tool?.function?.name !== 'agent_send_message')
    : executionToolSchemas;
  // Execution is not capped by history. These are bounded receipts only; raw
  // tool output lives in artifacts and the current evidence window, so a model
  // that keeps selecting tools cannot retain an ever-growing heap.
  const chatToolLoop = {
    enabled: Boolean(enableChatToolLoop),
    stopOnNoProgress: Boolean(stopOnNoProgress),
    loopWarningThreshold,
    loopBlockThreshold,
    iterations: [],
    toolResults: [],
    skipped: [],
    loopWarnings: [],
    terminal: null,
    omittedIterations: 0,
    omittedToolResults: 0,
    semanticInspectionStalls: [],
  };
  const promptEvidenceResults = [];
  const completedToolCallHistory = [];
  let outputOnlyArtifact = false;
  try {
    const adapter = modelAdapter || createModelAdapter({ config: modelConfig || {} });
    outputOnlyArtifact = ['image', 'audio'].includes(adapter.outputKind);
    // Output-only generators are not conversational agents. Their paid request
    // receives only the current user instruction plus adapter-owned generation
    // options: never the assembled SOUL/profile/skill/memory/history prompt,
    // tools, planner context, attachments, or a follow-up model turn.
    if (outputOnlyArtifact) {
      modelInput = { prompt: currentUserGenerationInstruction(message, prompt.modelMessages), messages: null, imageCount: 0, images: [], vision: false, fallback: false };
      chatToolLoop.enabled = false;
    } else {
      modelInput = modelInputForPlainTurn({ promptText: prompt.text, promptMessages: prompt.modelMessages, attachments, modelConfig, modelAdapter: adapter });
    }
    const toolArgs = enableChatToolLoop && !outputOnlyArtifact ? { tools: continuationToolSchemas(), toolChoice: 'auto' } : {};
    if (abortSignal?.aborted) throw abortSignal.reason || new Error('agent_stopped');
    await logChatToolLoopHeapStage(traceLogger, 'chat-tool-loop-before-model-call', {
      iteration: 0,
      modelInput,
      chatToolLoop,
      promptEvidenceResults,
    });
    let modelCall = 0;
    const withModelCall = (callback) => typeof callback === 'function'
      ? async (event) => callback({ ...event, modelCall })
      : null;
    const emitTextDelta = withModelCall(onTextDelta);
    const emitThoughtDelta = withModelCall(onThoughtDelta);
    // A terminal synthesis request is intentionally small. Keep the largest
    // actual request from this run as the completed-session meter instead of
    // letting that final answer overwrite the tool-loop high-water mark.
    const emitContextUsage = typeof onContextUsage === 'function'
      ? async (event) => {
          const usage = { ...event, modelCall };
          if (!peakContextUsage || Number(usage.estimatedTokens) >= Number(peakContextUsage.estimatedTokens)) peakContextUsage = usage;
          await onContextUsage(usage);
        }
      : null;
    modelCall += 1;
    model = await adapter.complete({ prompt: modelInput.prompt || (modelInput.vision ? undefined : prompt.text), messages: modelInput.messages || undefined, traceLogger, signal: abortSignal || undefined, ...(!outputOnlyArtifact && emitTextDelta ? { onTextDelta: emitTextDelta } : {}), ...(!outputOnlyArtifact && emitThoughtDelta ? { onThoughtDelta: emitThoughtDelta } : {}), ...(!outputOnlyArtifact && emitContextUsage ? { onContextUsage: emitContextUsage, modelCall } : {}), ...toolArgs });
    nativeTranscript = modelInput.messages || [{ role: 'user', content: modelInput.prompt || prompt.text }];
    await logChatToolLoopHeapStage(traceLogger, 'chat-tool-loop-after-model-response', {
      iteration: 0,
      model,
      chatToolLoop,
      promptEvidenceResults,
    });

    let iteration = 0;
    let toolLoopNoProgress = false;
    let terminalLoopVerdict = null;
    let pendingLoopWarning = null;
    const observedEvidence = new Set();
    const semanticInspectionHistory = new Map();
    while (enableChatToolLoop && !outputOnlyArtifact && hasNativeToolCalls(model) && (!stopOnNoProgress || !toolLoopNoProgress)) {
      const loopVerdict = exactRepeatVerdict(model.choice.toolCalls, completedToolCallHistory, { loopWarningThreshold, loopBlockThreshold });
      if (loopVerdict?.action === 'block') {
        terminalLoopVerdict = loopVerdict;
        chatToolLoop.terminal = {
          outcome: 'loop_blocked',
          actor: 'runtime',
          detector: 'identical_tool_call_and_result',
          tool: loopVerdict.tool,
          attemptedCount: loopVerdict.attemptedCount,
          repeatedCompletedCalls: loopVerdict.repeatedCompletedCalls,
          callFingerprint: loopVerdict.callFingerprint,
        };
        await traceLogger?.event?.('chat-tool-loop-blocked', chatToolLoop.terminal);
        break;
      }
      pendingLoopWarning = loopVerdict?.action === 'warn' ? loopVerdict : null;
      iteration += 1;
      const toolObservations = repeatedToolCallObservations(model.choice.toolCalls, chatToolLoop.iterations);
      await traceLogger?.event?.('chat-tool-loop-observation', {
        iteration,
        planFingerprint: toolPlanFingerprint(model.choice.toolCalls),
        calls: toolObservations,
        repeatedCalls: toolObservations.filter((item) => item.repeatCount > 1).length,
      });
      // Full tool results have one short-lived owner: this iteration. Build all
      // retained state from compact receipts before the native continuation, then
      // release both the executor envelope and raw result graph immediately after
      // the adapter has serialized the paired provider continuation.
      let executed = await executeChatToolCalls({ model, workspaceRoot, rootDir, dataRoot, sessionId, conversationId, iteration, traceLogger, executionPolicy, modelConfig, executionContext, abortSignal });
      let rawToolResults = executed.callResults || [];
      const nativeToolCalls = executed.toolCalls;
      const compactCalls = compactToolCalls(model.choice.toolCalls);
      const compactResults = rawToolResults.map((result) => compactPromptEvidenceResult(result));
      const resultSummaries = summarizeToolResults(rawToolResults);
      const proposal = executed.proposal;
      const proposalReview = executed.proposalReview;
      const skipped = compactSkippedToolActions(executed.proposalExecution.skipped || []);
      const compactExecution = {
        executed: executed.proposalExecution?.executed ?? resultSummaries.length,
        skipped,
        toolResults: resultSummaries,
        defaultInspection: Boolean(executed.proposalExecution?.defaultInspection),
      };
      const compactProposal = compactLoopProposal(proposal);
      const compactProposalReview = compactLoopProposalReview(proposalReview);
      const semanticObservations = semanticInspectionObservations(compactCalls, semanticInspectionHistory);
      compactCalls.forEach((call, index) => {
        const result = rawToolResults[index];
        if (!result) return;
        appendBoundedChatHistory(completedToolCallHistory, {
          callFingerprint: call.callFingerprint,
          outcomeFingerprint: fingerprint(normalizedToolOutcome(result)),
        }, CHAT_TOOL_CALL_HISTORY_LIMIT, 'omittedCompletedToolCalls');
      });
      await traceLogger?.event?.('chat-tool-loop-ownership', {
        iteration,
        rawToolResults: {
          count: rawToolResults.length,
          directTextChars: rawToolResults.reduce((sum, result) => sum + ['content', 'stdout', 'stderr', 'summary', 'preview', 'error'].reduce((inner, key) => inner + (typeof result?.[key] === 'string' ? result[key].length : 0), 0), 0),
        },
        compactResults: ownershipMetrics(compactResults),
        resultSummaries: ownershipMetrics(resultSummaries),
        compactProposal: ownershipMetrics(compactProposal),
        compactProposalReview: ownershipMetrics(compactProposalReview),
        compactExecution: ownershipMetrics(compactExecution),
      });
      await logChatToolLoopHeapStage(traceLogger, 'chat-tool-loop-after-tool-subagent-result', {
        iteration,
        model,
        toolResults: resultSummaries,
        chatToolLoop,
        promptEvidenceResults,
      });
      appendBoundedChatHistory(chatToolLoop.iterations, {
        iteration,
        toolCalls: compactCalls,
        proposal: compactProposal,
        proposalReview: compactProposalReview,
        proposalExecution: compactExecution,
      }, CHAT_TOOL_HISTORY_LIMIT, 'omittedIterations');
      chatToolLoop.omittedIterations = chatToolLoop.iterations.omittedIterations || 0;
      for (const item of skipped) appendBoundedChatHistory(chatToolLoop.skipped, item, CHAT_TOOL_HISTORY_LIMIT, 'omittedSkipped');
      chatToolLoop.consequences = accumulateCompletionEvidence(accumulateToolConsequences(chatToolLoop.consequences, rawToolResults), rawToolResults);
      for (const result of resultSummaries) appendBoundedChatHistory(chatToolLoop.toolResults, result, CHAT_TOOL_RESULT_HISTORY_LIMIT, 'omittedToolResults');
      chatToolLoop.omittedToolResults = chatToolLoop.toolResults.omittedToolResults || 0;
      for (const result of compactResults) appendBoundedChatHistory(promptEvidenceResults, result, CHAT_TOOL_HISTORY_LIMIT, 'omittedPromptEvidenceResults');
      chatToolLoop.omittedPromptEvidenceResults = promptEvidenceResults.omittedPromptEvidenceResults || 0;
      if (rawToolResults.some((result) => result?.tool === 'agent_send_message' && result?.messageMode === 'request_reply_complete' && result?.reply?.ok)) {
        closePeerExchangeAfterReply = true;
      }
      const noMaterialProgress = recordMaterialProgress(observedEvidence, rawToolResults) === 0;
      const semanticStalls = semanticObservations.filter((item) => item.count >= 3);
      for (const stall of semanticStalls) {
        const diagnostic = { iteration, ...stall, materialProgress: !noMaterialProgress };
        appendBoundedChatHistory(chatToolLoop.semanticInspectionStalls, diagnostic, 32, 'omittedSemanticInspectionStalls');
        await traceLogger?.event?.('chat-tool-loop-semantic-inspection-stall', diagnostic);
      }
      toolLoopNoProgress = Boolean((stopOnNoProgress && noMaterialProgress) || terminalLoopVerdict?.action === 'block');
      await traceLogger?.event?.('chat-tool-loop-evidence-window', {
        iteration,
        planFingerprint: toolPlanFingerprint(model.choice.toolCalls),
        materialProgress: !noMaterialProgress,
        toolResultCount: promptEvidenceResults.length,
        projectionAuthority: 'continuation_evidence_provider_budget',
      });
      await logChatToolLoopHeapStage(traceLogger, 'chat-tool-loop-after-iteration-state-commit', {
        iteration,
        model,
        chatToolLoop,
        promptEvidenceResults,
      });

      const warningNotice = pendingLoopWarning ? loopReceiptText(pendingLoopWarning) : null;
      if (pendingLoopWarning) {
        const warning = {
          outcome: 'loop_warning',
          actor: 'runtime',
          detector: 'identical_tool_call_and_result',
          tool: pendingLoopWarning.tool,
          attemptedCount: pendingLoopWarning.attemptedCount,
          repeatedCompletedCalls: pendingLoopWarning.repeatedCompletedCalls,
          callFingerprint: pendingLoopWarning.callFingerprint,
        };
        chatToolLoop.loopWarnings.push(warning);
        await traceLogger?.event?.('chat-tool-loop-warning', warning);
      }
      const followupPrompt = toolLoopNoProgress
        ? finalAnswerAfterToolLoopPrompt({ basePrompt: prompt.text, message, toolResults: promptEvidenceResults, skipped: chatToolLoop.skipped, modelConfig, contextThreshold })
        : executedToolResultPrompt({ basePrompt: prompt.text, message, toolResults: promptEvidenceResults, skipped: chatToolLoop.skipped, toolCalls: model.choice.toolCalls, iteration, runtimeNotice: warningNotice, modelConfig, contextThreshold });
      // Native continuations preserve the provider's assistant function call ↔
      // function output pairing. The prose receipt prompt remains a compatibility
      // fallback for adapters that do not implement this capability and for the
      // explicit tool-less final synthesis path.
      const useNativeContinuation = !toolLoopNoProgress && typeof adapter.continueWithToolResults === 'function';
      const followupInput = useNativeContinuation ? null : modelInputForFollowupPrompt(followupPrompt, modelInput);
      await logChatToolLoopHeapStage(traceLogger, 'chat-tool-loop-after-continuation-prompt-build', { iteration, followupPrompt: useNativeContinuation ? '[provider-native tool continuation]' : followupPrompt, followupInput, chatToolLoop, promptEvidenceResults });
      if (abortSignal?.aborted) throw abortSignal.reason || new Error('agent_stopped');
      await logChatToolLoopHeapStage(traceLogger, 'chat-tool-loop-before-model-call', { iteration, followupInput, chatToolLoop, promptEvidenceResults });
      modelCall += 1;
      const nativeContinuation = useNativeContinuation
        ? prepareNativeToolContinuation({
            baseMessages: normalizeProviderMessages(nativeTranscript),
            toolCalls: nativeToolCalls,
            toolResults: rawToolResults,
            modelConfig,
            tools: continuationToolSchemas(),
          })
        : null;
      if (nativeContinuation?.compacted) await traceLogger?.event?.('native-continuation-prepared', {
        compacted: true,
        estimatedTokens: nativeContinuation.inspection?.estimatedTokens ?? null,
        contextTokens: nativeContinuation.inspection?.contextTokens ?? null,
      });
      model = useNativeContinuation
        ? await adapter.continueWithToolResults({
            previousModel: model,
            baseMessages: normalizeProviderMessages(nativeTranscript),
            toolCalls: nativeToolCalls,
            toolResults: rawToolResults,
            preparedMessages: nativeContinuation.messages,
            tools: continuationToolSchemas(),
            toolChoice: 'auto',
            traceLogger,
            signal: abortSignal || undefined,
            ...(emitTextDelta ? { onTextDelta: emitTextDelta } : {}),
            ...(emitThoughtDelta ? { onThoughtDelta: emitThoughtDelta } : {}),
            ...(emitContextUsage ? { onContextUsage: emitContextUsage, modelCall } : {}),
          })
        : await adapter.complete({
            prompt: followupInput.prompt || undefined,
            messages: followupInput.messages || undefined,
            ...(toolLoopNoProgress ? {} : { tools: continuationToolSchemas(), toolChoice: 'auto' }),
            traceLogger,
            signal: abortSignal || undefined,
            ...(emitTextDelta ? { onTextDelta: emitTextDelta } : {}),
            ...(emitThoughtDelta ? { onThoughtDelta: emitThoughtDelta } : {}),
            ...(emitContextUsage ? { onContextUsage: emitContextUsage, modelCall } : {}),
          });
      // The adapter has now transformed raw results into bounded native receipts.
      // Do not let the executor envelope or original tool graph survive into the
      // next iteration through loop state, diagnostics, or closures.
      rawToolResults = null;
      executed = null;
      if (useNativeContinuation && Array.isArray(model?.nativeTranscript)) {
        nativeTranscript = normalizeProviderMessages([
          ...model.nativeTranscript.filter((entry) => {
            const content = String(entry?.content || '');
            return true;
          }),
        ]);
      }
      await logChatToolLoopHeapStage(traceLogger, 'chat-tool-loop-after-model-response', {
        iteration,
        model,
        chatToolLoop,
        promptEvidenceResults,
      });
    }

    if (toolLoopNoProgress) chatToolLoop.noProgress = true;
    if (terminalLoopVerdict && !chatToolLoop.terminal) {
      chatToolLoop.terminal = {
        outcome: 'loop_blocked',
        actor: 'runtime',
        detector: 'identical_tool_call_and_result',
        tool: terminalLoopVerdict.tool,
        attemptedCount: terminalLoopVerdict.attemptedCount,
        repeatedCompletedCalls: terminalLoopVerdict.repeatedCompletedCalls,
        callFingerprint: terminalLoopVerdict.callFingerprint,
      };
    }
    if (terminalLoopVerdict) {
      const finalPrompt = finalAnswerAfterToolLoopPrompt({
        basePrompt: prompt.text,
        message,
        toolResults: promptEvidenceResults,
        skipped: chatToolLoop.skipped,
        runtimeNotice: loopReceiptText(terminalLoopVerdict, { terminal: true }),
        modelConfig,
        contextThreshold,
      });
      const finalInput = modelInputForFollowupPrompt(finalPrompt, modelInput);
      if (abortSignal?.aborted) throw abortSignal.reason || new Error('agent_stopped');
      modelCall += 1;
      model = await adapter.complete({
        prompt: finalInput.prompt || undefined,
        messages: finalInput.messages || undefined,
        traceLogger,
        signal: abortSignal || undefined,
        ...(emitTextDelta ? { onTextDelta: emitTextDelta } : {}),
        ...(emitThoughtDelta ? { onThoughtDelta: emitThoughtDelta } : {}),
        ...(emitContextUsage ? { onContextUsage: emitContextUsage, modelCall } : {}),
      });
    }

  } catch (error) {
    model = { ok: false, error: String(error?.message || error), usage: null, choice: { text: '' } };
  }

  const proposal = model ? parseActionProposal(model.choice?.text ?? '') : null;
  // Keep source bytes/file handles on this ephemeral internal field only. They
  // are persisted by the plain-chat finalizer before any session serialization.
  const generatedArtifactSources = adapterOutputArtifactsFromResult(model);
  if (model && typeof model === 'object') {
    delete model.outputArtifacts;
    delete model.output_artifacts;
  }
  const outputArtifacts = [];
  const skipped = allSkippedChatTools(chatToolLoop);
  const answerText = proposal?.answerText ?? null;
  const runtime = createRuntimeTurnResult({
    finalText: answerText || '',
    blocker: model?.ok ? null : (model?.error || 'model_failed'),
    evidence: chatToolLoop.toolResults,
    sideChannels: [{ type: 'receipt', content: { modelOk: model?.ok ?? null, proposedActions: proposal?.actions?.length ?? 0, chatToolCalls: chatToolLoop.iterations.reduce((sum, item) => sum + item.toolCalls.length, 0), executedChatTools: chatToolLoop.consequences?.executed || 0, terminal: chatToolLoop.terminal } }],
    metadata: { calledModel: true, modelUsage: model?.usage ?? null, ...(outputArtifacts.length ? { outputArtifacts } : {}), attachments: { images: modelInput.imageCount || 0, visionUsed: Boolean(modelInput.vision), visionFallback: Boolean(modelInput.fallback) }, chatToolLoop: { enabled: chatToolLoop.enabled, iterations: chatToolLoop.iterations.length, toolResults: chatToolLoop.toolResults.length, noProgress: Boolean(chatToolLoop.noProgress), loopWarnings: chatToolLoop.loopWarnings.length, terminal: chatToolLoop.terminal, semanticInspectionStalls: chatToolLoop.semanticInspectionStalls.length, omittedPromptEvidenceResults: chatToolLoop.omittedPromptEvidenceResults || 0 } },
  });

  return { model, proposal, answerText, outputArtifacts, generatedArtifactSources, chatToolLoop, contextUsage: peakContextUsage || model?.contextUsage || null, runtime };
}

export const __test__ = Object.freeze({
  boundedToolArgumentValue,
  stableJson,
  fingerprint,
  toolPlanFingerprint,
  compactToolCalls,
  executedToolResultPrompt,
});

export async function runWorkLoopTurn(args = {}) {
  const { runBurrow } = await import('./runner.mjs');
  const workResult = await runBurrow(args);
  return {
    workResult,
    runtime: createRuntimeTurnResult({
      finalText: workResult.answerText || '',
      blocker: workResult.decision === 'blocked' ? (workResult.blockers || []).join(', ') || 'blocked' : null,
      evidence: workResult.proposalExecution?.toolResults || [],
      sideChannels: [
        { type: 'receipt', content: { decision: workResult.decision, runId: workResult.runId } },
        ...(workResult.verification ? [{ type: 'debug', content: { verification: workResult.verification } }] : []),
      ],
      metadata: {
        decision: workResult.decision,
        proposedActions: workResult.proposedActions?.length ?? 0,
        executedActions: workResult.proposalExecution?.executed ?? 0,
        defaultInspection: Boolean(workResult.proposalExecution?.defaultInspection),
        commit: workResult.commit ? { ok: workResult.commit.ok, skipped: workResult.commit.skipped, reason: workResult.commit.reason } : null,
      },
    }),
  };
}

// Compatibility surface: callers historically imported orchestration helpers here.
export {
  inspectionResultSummary, shouldFollowReadOnlyInspection, hasExecutedInspectionEvidence,
  hasExecutedReadFileEvidence, missingInspectionTargets, shouldForceInspectionEvidence, defaultInspectionFileList,
  runDefaultReadOnlyInspection, pendingInspectionFallback,
  compactToolCalls, boundedToolArgumentValue, stableJson, fingerprint, toolPlanFingerprint, exactRepeatVerdict,
  loopReceiptText, appendBoundedChatHistory, appendBoundedMapEntry, compactPromptEvidenceResult,
  runtimeObservationFacts, materialEvidenceKeys, recordMaterialProgress,
  repeatedToolCallObservations, semanticInspectionObservations, logChatToolLoopHeapStage,
  runProposalLoop, runVerificationGate, runCommitGate, completeMutationAfterInspection,
  completeMutationRepairAfterNoAction, completeMutationRepairAfterToolFailure,
  completeVerificationAfterMutation,
};
