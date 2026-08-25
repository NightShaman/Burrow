import { buildTurnContext, conversationContextFromEngine, inspectContextEngineResult } from './context-engine.mjs';
import { runSessionCompression } from './session-compression.mjs';
import { inspectAssembledPromptBudget } from './prompt-budget.mjs';
import { normalizeContextCompressionConfig } from './context-compression.mjs';
import { readSessionEntries } from './session-store.mjs';


function uncoveredHistoryDetails(turnContext = {}) {
  const priorMessages = Array.isArray(turnContext?.conversation?.priorMessages) ? turnContext.conversation.priorMessages : [];
  return {
    uncoveredTurnCount: priorMessages.length,
    firstUncoveredEntryId: priorMessages.at(0)?.id || null,
    lastUncoveredEntryId: priorMessages.at(-1)?.id || null,
  };
}

function assertNoLossyPriorTranscriptSummary(turnContext = {}) {
  const details = uncoveredHistoryDetails(turnContext);
  if (!details.uncoveredTurnCount) return;
  const error = new Error('context_preparation_uncovered_history');
  error.statusCode = 413;
  error.details = details;
  throw error;
}

function throwCompressionUnavailable({ compressionResult, turnContext }) {
  const details = uncoveredHistoryDetails(turnContext);
  if (!details.uncoveredTurnCount || compressionResult?.reason !== 'compression_failed') return;
  const error = new Error('context_compression_unavailable');
  error.statusCode = 503;
  error.retryable = true;
  error.cause = compressionResult.error;
  error.details = { ...details, compressionReason: compressionResult.reason, compressionError: compressionResult.error };
  throw error;
}

function tokenTargetToCharBudget(tokens, fallback = 4000) {
  const number = Number(tokens);
  return Number.isFinite(number) && number > 0 ? Math.ceil(number * 4) : fallback;
}

// History must share the effective provider budget with the system/profile,
// tools, memory, current user turn, and model output. This is deliberately a
// token-derived budget, not a tiny fixed dialogue excerpt.
export function activeConversationLimits({ modelConfig = null, contextConfig = {} } = {}) {
  const contextTokens = Number(modelConfig?.contextTokens);
  const contextWindow = Number(modelConfig?.contextWindow);
  const effectiveTokens = Number.isFinite(contextTokens) && contextTokens > 0
    ? contextTokens
    : Number.isFinite(contextWindow) && contextWindow > 0 ? contextWindow : null;
  const pressureThreshold = Number(contextConfig?.contextThreshold);
  const threshold = Number.isFinite(pressureThreshold) && pressureThreshold > 0 && pressureThreshold < 1 ? pressureThreshold : 0.75;
  const compression = normalizeContextCompressionConfig(contextConfig);
  // Known-capacity models get the threshold-scaled active conversation budget
  // before compression planning. freshTailMaxTokens is the post-compression
  // survivor size, not a pre-compression guillotine. Output/tool reserve belongs
  // to the later provider-request pressure check; subtracting it here can hide
  // uncovered-but-still-under-window history from the compression planner.
  // Without trustworthy model metadata retain the bounded fresh tail, but do
  // not manufacture capacity/pressure telemetry from the fallback.
  const conversationTokens = effectiveTokens === null
    ? compression.freshTailMaxTokens
    : Math.max(1, Math.floor(effectiveTokens * threshold));
  return {
    rawRecentChars: conversationTokens * 4,
    priorSummaryChars: tokenTargetToCharBudget(contextConfig?.summaryTargetTokens),
    ...(effectiveTokens === null ? { unknownCapacityFallback: true } : {}),
  };
}

function turnContextOptions({ rootDir, dataRoot, agentRuntime, sessionId, contextConfig, modelConfig, support, transcript, agentWorkspaceRoot, agentDataRoot, cacheRoot }) {
  return {
    rootDir,
    ...(Array.isArray(transcript) ? { transcript } : {}),
    dataRoot,
    agentRuntime,
    sessionId,
    limits: activeConversationLimits({ modelConfig, contextConfig }),
    support,
    agentWorkspaceRoot,
    agentDataRoot,
    cacheRoot,
  };
}

export async function prepareSessionTurnContext({
  rootDir,
  dataRoot,
  agentRuntime = null,
  sessionId,
  contextConfig = {},
  modelConfig = null,
  memoryStage = null,
  selectedSkills = [],
  transcript = null,
  logger = null,
  agentWorkspaceRoot = null,
  agentDataRoot = null,
  cacheRoot = null,
  compressionRunner = runSessionCompression,
} = {}) {
  const support = { memoryStage, selectedSkills };
  // Build and inspect against one resolved transcript. Otherwise the inspector
  // cannot see prior persisted assembled-prompt receipts when the caller lets
  // buildTurnContext load the session internally.
  // An empty array is the normal caller default, not evidence that a persisted
  // session has no history. A caller without a session data root can still use
  // an explicit empty transcript for ephemeral/CLI preparation.
  const useSuppliedTranscript = Array.isArray(transcript)
    && (transcript.length > 0 || !dataRoot);
  const resolvedTranscript = useSuppliedTranscript
    ? transcript
    : await readSessionEntries({ rootDir: dataRoot, sessionId, limit: 0 });
  const options = turnContextOptions({ rootDir, dataRoot, agentRuntime, sessionId, contextConfig, modelConfig, support, transcript: resolvedTranscript, agentWorkspaceRoot, agentDataRoot, cacheRoot });
  let turnContext = await buildTurnContext(options);
  const preCompressionInspection = inspectContextEngineResult({
    sessionId,
    context: turnContext,
    transcript: resolvedTranscript,
    contextWindow: modelConfig?.contextWindow,
    contextTokens: modelConfig?.contextTokens,
  });
  let compressionResult = null;
  try {
    compressionResult = await compressionRunner({ rootDir: dataRoot, sessionId, config: contextConfig, contextBudget: preCompressionInspection.contextBudget, logger });
  } catch (error) {
    compressionResult = { ok: false, compressed: false, reason: 'compression_failed', error: error?.message || String(error) };
    await logger?.event?.('context-compression-failed', compressionResult);
  }
  // Compression persists a successor transcript. Re-read it rather than
  // rebuilding from the pre-compression snapshot used for inspection.
  if (compressionResult.compressed) {
    turnContext = await buildTurnContext(turnContextOptions({
      rootDir, dataRoot, agentRuntime, sessionId, contextConfig, modelConfig, support,
      transcript: null, agentWorkspaceRoot, agentDataRoot, cacheRoot,
    }));
  }
  throwCompressionUnavailable({ compressionResult, turnContext });
  assertNoLossyPriorTranscriptSummary(turnContext);
  return {
    version: 1,
    source: 'session-preparation',
    prepared: true,
    turnContext,
    conversationContext: conversationContextFromEngine(turnContext),
    compressionResult,
    preCompressionInspection,
  };
}

export async function compressContextForPromptPressure({
  rootDir,
  dataRoot,
  agentRuntime = null,
  sessionId,
  contextConfig = {},
  modelConfig = null,
  prompt = null,
  tools = null,
  support = {},
  logger = null,
  agentWorkspaceRoot = null,
  agentDataRoot = null,
  cacheRoot = null,
} = {}) {
  const promptInspection = inspectAssembledPromptBudget({ prompt, modelConfig, tools });
  const compression = normalizeContextCompressionConfig(contextConfig);
  const usageRatio = Number(promptInspection.usageRatio);
  const shouldCompress = ['compress', 'blocked'].includes(promptInspection.pressure)
    || (Number.isFinite(usageRatio) && usageRatio >= compression.contextThreshold);
  if (!shouldCompress) return { compressed: false, reason: 'prompt_pressure_ok', promptInspection };
  let compressionResult = null;
  try {
    compressionResult = await runSessionCompression({ rootDir: dataRoot, sessionId, config: contextConfig, contextBudget: promptInspection, logger });
  } catch (error) {
    return { compressed: false, reason: 'compression_failed', error: error?.message || String(error), promptInspection };
  }
  if (!compressionResult.compressed) return { ...compressionResult, promptInspection };
  const turnContext = await buildTurnContext(turnContextOptions({ rootDir, dataRoot, agentRuntime, sessionId, contextConfig, modelConfig, support, agentWorkspaceRoot, agentDataRoot, cacheRoot }));
  return { ...compressionResult, promptInspection, turnContext, conversationContext: conversationContextFromEngine(turnContext) };
}
