import { buildTurnContext, conversationContextFromEngine } from './context-engine.mjs';
import { assemblePrompt } from './prompt-assembler.mjs';
import { compressContextForPromptPressure, prepareSessionTurnContext } from './context-preparation.mjs';
import { inspectAssembledPromptBudget } from './prompt-budget.mjs';
import { normalizeContextCompressionConfig } from './context-compression.mjs';

export const PREPARED_CONTEXT_VERSION = 1;
export const __test__ = { readEvidenceTargetTokens, contextThresholdState, contextBuildEvent }

export function normalizePreparedContext(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('prepared_context_invalid');
  if (input.version !== PREPARED_CONTEXT_VERSION) throw new Error('prepared_context_version_invalid');
  if (!['session-preparation', 'caller-supplied-engine'].includes(input.source)) throw new Error('prepared_context_source_invalid');
  if (!input.turnContext || typeof input.turnContext !== 'object') throw new Error('prepared_context_turn_context_invalid');
  if (typeof input.prepared !== 'boolean') throw new Error('prepared_context_prepared_invalid');
  if (input.source === 'session-preparation' && input.prepared !== true) throw new Error('prepared_context_source_invalid');
  if (input.source === 'caller-supplied-engine' && input.prepared !== false) throw new Error('prepared_context_source_invalid');
  return input;
}

export function preparedContextFromEngine(turnContext) {
  return normalizePreparedContext({
    version: PREPARED_CONTEXT_VERSION,
    source: 'caller-supplied-engine',
    prepared: false,
    turnContext,
    conversationContext: turnContext?.conversation || null,
    compressionResult: null,
    preCompressionInspection: null,
  });
}

export async function prepareContextForTurn(options = {}) {
  return normalizePreparedContext(await prepareSessionTurnContext(options));
}

function readEvidenceTargetTokens({ baselineBudget, modelConfig, contextThreshold } = {}) {
  const contextTokens = Number(baselineBudget?.contextTokens || modelConfig?.contextTokens || modelConfig?.contextWindow);
  if (!Number.isFinite(contextTokens) || contextTokens <= 0) return 0;
  return Math.max(0, Math.floor(contextTokens * contextThreshold));
}

async function assembleReadEvidenceWithinBudget({ assemble, context, supportContext, baselineBudget, modelConfig, tools, contextThreshold } = {}) {
  const targetTokens = readEvidenceTargetTokens({ baselineBudget, modelConfig, contextThreshold });
  if (!targetTokens) return assemble(context, 0);
  let low = 0;
  // `workingContextChars` bounds the entire rendered section, including its
  // ledger, ReadEvidence preamble, and per-file headers—not just excerpts.
  // Reserve bounded markup space for every retained item so a non-empty
  // allocation can actually render an excerpt.
  let high = (supportContext?.workingContext?.readEvidence || []).reduce((total, item) => total + String(item?.excerpt || '').length + 1024, 0);
  let best = await assemble(context, 0);
  while (low <= high) {
    const candidateChars = Math.floor((low + high) / 2);
    const candidate = await assemble(context, candidateChars);
    const inspection = inspectAssembledPromptBudget({ prompt: candidate, modelConfig, tools });
    if (inspection.estimatedTokens <= targetTokens) {
      best = candidate;
      low = candidateChars + 1;
    } else high = candidateChars - 1;
  }
  return best;
}

function compactCompressionOutcome(result = null, { attempted = false, source = 'not-prepared' } = {}) {
  return {
    source,
    attempted,
    compressed: result?.compressed ?? false,
    reason: result?.reason || null,
  };
}

function contextThresholdState({ usageRatio = null, contextThreshold = null } = {}) {
  const usage = Number(usageRatio);
  const threshold = Number(contextThreshold);
  if (!Number.isFinite(usage) || !Number.isFinite(threshold) || threshold <= 0) return 'unknown';
  if (usage >= threshold) return 'threshold_exceeded';
  if (usage >= threshold * 0.9) return 'approaching_threshold';
  return 'below_threshold';
}

function contextBuildEvent({ phase, budget = null, compression = null, contextThreshold = null } = {}) {
  return {
    phase,
    estimatedTokens: Number.isFinite(Number(budget?.estimatedTokens)) ? Number(budget.estimatedTokens) : null,
    contextTokens: Number.isFinite(Number(budget?.contextTokens)) ? Number(budget.contextTokens) : null,
    usageRatio: Number.isFinite(Number(budget?.usageRatio)) ? Number(budget.usageRatio) : null,
    windowPressure: budget?.pressure || 'unknown',
    compressionThreshold: Number.isFinite(Number(contextThreshold)) ? Number(contextThreshold) : null,
    compressionState: contextThresholdState({ usageRatio: budget?.usageRatio, contextThreshold }),
    compression: compactCompressionOutcome(compression, { attempted: compression?.attempted ?? Boolean(compression), source: phase }),
  };
}

function assertPromptFitsProviderBudget({ budget, promptPressureCompression } = {}) {
  const contextTokens = Number(budget?.contextTokens);
  const estimatedTokens = Number(budget?.estimatedTokens);
  if (!Number.isFinite(contextTokens) || contextTokens <= 0 || !Number.isFinite(estimatedTokens) || estimatedTokens <= contextTokens) return;
  // The adapter may replay the initial static prefix exactly during a native
  // continuation. Consequently the preparation boundary—not a lossy adapter
  // limiter—owns the final model-window invariant.
  const error = new Error('context_preparation_prompt_over_budget');
  error.statusCode = 413;
  error.details = {
    contextTokens,
    estimatedTokens,
    pressure: budget?.pressure || 'blocked',
    compressionReason: promptPressureCompression?.reason || null,
  };
  throw error;
}

/**
 * ContextBuilder is the one normal-path façade for initial transcript shaping,
 * normal and prompt-pressure compression, bounded provider collection, final
 * prompt assembly, and truthful receipts.
 * The underlying providers remain independently testable.
 */
export async function buildContextForTurn({
  rootDir,
  dataRoot = rootDir,
  sessionId = 'default',
  preparedContext = null,
  contextOptions = {},
  kernel = '',
  selectedSkills = [],
  promptSkills = selectedSkills,
  modelProfile = null,
  supportContext = null,
  task = '',
  attachments = [],
  attachmentManifest = [],
  attachmentArtifactRoot = null,
  limits = {},
  traceLogger = null,
  outputMode = 'plain',
  modelConfig = null,
  tools = null,
  promptPressure = null,
  ...unsupported
} = {}) {
  if ('contextEngine' in unsupported) throw new Error('context_engine_retired_use_prepared_context');
  if ('initialContextPreparation' in unsupported) throw new Error('initial_context_preparation_retired_use_prepared_context');
  if (!rootDir) throw new Error('rootDir is required');
  if (!task || typeof task !== 'string') throw new Error('task is required');

  const normalizedPreparedContext = preparedContext ? normalizePreparedContext(preparedContext) : null;
  let turnContext = normalizedPreparedContext?.turnContext || await buildTurnContext({
    rootDir,
    dataRoot,
    sessionId,
    ...contextOptions,
  });

  const assemble = async (context, workingContextChars = 0) => assemblePrompt({
    rootDir,
    kernel,
    selectedSkills,
    promptSkills,
    conversationContext: conversationContextFromEngine(context),
    modelProfile,
    modelConfig,
    profileFiles: context.support?.profileFiles || null,
    supportContext,
    task,
    attachments,
    // Keep current uploads distinct from persisted references. The prompt may
    // render both, but receipts must not pretend old reopenable artifacts were
    // uploaded again on this turn.
    retainedAttachmentManifest: Array.isArray(turnContext?.conversation?.attachmentManifest) ? turnContext.conversation.attachmentManifest : [],
    currentAttachmentManifest: Array.isArray(attachmentManifest) ? attachmentManifest : [],
    attachmentArtifactRoot,
    limits: { ...limits, workingContextChars },
    traceLogger,
    outputMode,
  });

  const contextConfig = normalizeContextCompressionConfig(promptPressure?.contextConfig || contextOptions.contextConfig || {});
  const contextEvents = [];
  if (normalizedPreparedContext?.preCompressionInspection?.contextBudget) {
    contextEvents.push(contextBuildEvent({
      phase: 'session_preparation',
      budget: normalizedPreparedContext.preCompressionInspection.contextBudget,
      contextThreshold: contextConfig.contextThreshold,
      compression: { ...normalizedPreparedContext.compressionResult, attempted: normalizedPreparedContext.prepared === true },
    }));
  }
  let baselinePrompt = await assemble(turnContext, 0);
  const baselineBudget = inspectAssembledPromptBudget({ prompt: baselinePrompt, modelConfig, tools });
  contextEvents.push(contextBuildEvent({
    phase: 'initial_assembly', budget: baselineBudget, contextThreshold: contextConfig.contextThreshold,
    compression: { attempted: false, compressed: false, reason: 'not_evaluated' },
  }));
  let prompt = await assembleReadEvidenceWithinBudget({ assemble, context: turnContext, supportContext, baselineBudget, modelConfig, tools, contextThreshold: contextConfig.contextThreshold });
  let promptPressureCompression = { compressed: false, reason: 'not_requested' };
  if (promptPressure) {
    promptPressureCompression = await compressContextForPromptPressure({
      ...promptPressure,
      rootDir: promptPressure.rootDir || dataRoot,
      dataRoot: promptPressure.dataRoot || dataRoot,
      sessionId,
      modelConfig,
      prompt,
      tools: promptPressure.tools || tools,
      support: promptPressure.support || contextOptions.support || {},
      logger: promptPressure.logger || traceLogger,
    });
    contextEvents.push(contextBuildEvent({
      phase: 'prompt_pressure_decision', budget: baselineBudget, contextThreshold: contextConfig.contextThreshold,
      compression: { ...promptPressureCompression, attempted: true },
    }));
    if (promptPressureCompression.turnContext) {
      turnContext = promptPressureCompression.turnContext;
      baselinePrompt = await assemble(turnContext, 0);
      const compressedBaselineBudget = inspectAssembledPromptBudget({ prompt: baselinePrompt, modelConfig, tools });
      prompt = await assembleReadEvidenceWithinBudget({ assemble, context: turnContext, supportContext, baselineBudget: compressedBaselineBudget, modelConfig, tools, contextThreshold: contextConfig.contextThreshold });
      contextEvents.push(contextBuildEvent({
        phase: 'post_compression_rebuild', budget: inspectAssembledPromptBudget({ prompt, modelConfig, tools }), contextThreshold: contextConfig.contextThreshold,
        compression: { ...promptPressureCompression, attempted: true },
      }));
    }
  }

  const budget = inspectAssembledPromptBudget({ prompt, modelConfig, tools });
  contextEvents.push(contextBuildEvent({
    phase: 'final_model_request', budget, contextThreshold: contextConfig.contextThreshold,
    compression: { ...promptPressureCompression, attempted: Boolean(promptPressure) },
  }));
  assertPromptFitsProviderBudget({ budget, promptPressureCompression });
  const providers = {
    compression: {
      initial: compactCompressionOutcome(normalizedPreparedContext?.compressionResult, {
        attempted: normalizedPreparedContext?.prepared === true,
        source: normalizedPreparedContext?.source || 'not-prepared',
      }),
      promptPressure: compactCompressionOutcome(promptPressureCompression, { attempted: Boolean(promptPressure), source: 'prompt-pressure' }),
    },
    sessionRecall: {
      requested: Boolean(supportContext?.sessionRecall?.shouldRecall),
      used: Boolean(supportContext?.sessionRecall?.used),
      scope: supportContext?.sessionRecall?.scope || null,
      sourceCount: Number(supportContext?.sessionRecall?.count || 0),
      searchedSessionCount: Number(supportContext?.sessionRecall?.searchedSessionCount || 0),
    },
    runEvidence: {
      candidateCount: Number(supportContext?.runEvidence?.candidateCount || 0),
      selectedCount: Array.isArray(supportContext?.runEvidence?.selected) ? supportContext.runEvidence.selected.length : 0,
      omittedCount: Number(supportContext?.runEvidence?.omittedCount || 0),
      chars: Number(supportContext?.runEvidence?.chars || 0),
      reason: supportContext?.runEvidence?.reason || null,
      selected: (supportContext?.runEvidence?.selectedDetails || []).map((item) => ({ runId: item.runId, sessionId: item.sessionId, reason: item.reason, crossSession: item.crossSession })),
      omitted: (supportContext?.runEvidence?.omittedDetails || []).slice(0, 64).map((item) => ({ runId: item.runId, sessionId: item.sessionId, reason: item.reason, crossSession: item.crossSession })),
    },
    workingContinuity: {
      scope: supportContext?.workingContext?.continuity?.scope || null,
      reason: supportContext?.workingContext?.continuity?.reason || 'unavailable',
      included: (supportContext?.workingContext?.continuity?.records || []).map((record) => ({ id: record.id, kind: record.kind, state: record.state, sourceRefs: record.sourceRefs || [], selectionReason: record.selectionReason || null, expiresAt: record.expiresAt || null })),
      omittedCount: Number(supportContext?.workingContext?.continuity?.omittedCount || 0),
      candidateCount: Number(supportContext?.workingContext?.continuity?.candidateCount || 0),
      chars: Number(supportContext?.workingContext?.continuity?.chars || 0),
    },
  };
  const contextBuildReceipt = {
    ...prompt.contextBuildReceipt,
    budget: {
      ...budget,
      compressionThreshold: contextConfig.contextThreshold,
      compressionState: contextThresholdState({ usageRatio: budget.usageRatio, contextThreshold: contextConfig.contextThreshold }),
    },
    contextEvents: contextEvents.slice(-8),
    providers,
  };
  const assembledPrompt = { ...prompt, contextBuildReceipt };
  await traceLogger?.event?.('context-build-receipt', contextBuildReceipt);
  return {
    turnContext,
    conversationContext: conversationContextFromEngine(turnContext),
    prompt: assembledPrompt,
    contextBuildReceipt,
    budget,
    promptPressureCompression,
  };
}
