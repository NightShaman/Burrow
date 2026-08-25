function isExecutionDigest(entry) {
  return String(entry?.type || '') === 'execution_digest'
    && entry?.metadata?.executionDigest === true
    && (entry?.entersPrompt ?? false) === true
    && String(entry?.content || '').trim();
}

function isPromptChatMessage(entry) {
  return (isExecutionDigest(entry) || ((entry?.type ?? 'message') === 'message'
    && ['user', 'assistant', 'agent'].includes(String(entry?.role || ''))
    && (entry?.visibility ?? 'chat') === 'chat'
    && (entry?.entersPrompt ?? true) === true))
    && String(entry?.content || '').trim();
}

function isCanonicalExecutionEntry(entry) {
  return ['tool_call', 'tool_result'].includes(String(entry?.type || ''))
    && entry?.metadata?.canonicalExecution === true
    && String(entry?.content || '').trim();
}

function isCompressionEntry(entry) {
  return isPromptChatMessage(entry);
}

function compressionEntryText(entry) {
  if (isCanonicalExecutionEntry(entry)) {
    return `${entry.type === 'tool_call' ? 'tool call' : 'tool result'}: ${String(entry.content || '').trim()}`;
  }
  return `${entry.role}: ${String(entry.content || '').trim()}`;
}

function messageText(message) {
  return `${message.role}: ${String(message.content || '').trim()}`;
}

function messageChars(message) {
  return messageText(message).length;
}

function estimateTokensFromChars(chars = 0) {
  return Math.ceil(Number(chars || 0) / 4);
}

function normalizePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function normalizeThreshold(value, fallback = 0.75) {
  if (value === undefined || value === null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 && number < 1 ? number : fallback;
}

export const DEFAULT_CONTEXT_COMPRESSION_CONFIG = Object.freeze({
  contextThreshold: 0.75,
  freshTailCount: 48,
  freshTailMaxTokens: 24000,
  leafChunkTokens: 20000,
  summaryTargetTokens: 6000,
  summaryModel: null,
  maxSweepIterations: 4,
  sweepDeadlineMs: 120000,
});

export function normalizeContextCompressionConfig(config = {}) {
  return {
    contextThreshold: normalizeThreshold(config.contextThreshold, DEFAULT_CONTEXT_COMPRESSION_CONFIG.contextThreshold),
    freshTailCount: normalizePositiveInteger(config.freshTailCount, DEFAULT_CONTEXT_COMPRESSION_CONFIG.freshTailCount),
    freshTailMaxTokens: normalizePositiveInteger(config.freshTailMaxTokens, DEFAULT_CONTEXT_COMPRESSION_CONFIG.freshTailMaxTokens),
    leafChunkTokens: normalizePositiveInteger(config.leafChunkTokens, DEFAULT_CONTEXT_COMPRESSION_CONFIG.leafChunkTokens),
    summaryTargetTokens: normalizePositiveInteger(config.summaryTargetTokens, DEFAULT_CONTEXT_COMPRESSION_CONFIG.summaryTargetTokens),
    summaryModel: typeof config.summaryModel === 'string' && config.summaryModel.trim() ? config.summaryModel.trim() : null,
    maxSweepIterations: normalizePositiveInteger(config.maxSweepIterations, DEFAULT_CONTEXT_COMPRESSION_CONFIG.maxSweepIterations),
    sweepDeadlineMs: normalizePositiveInteger(config.sweepDeadlineMs, DEFAULT_CONTEXT_COMPRESSION_CONFIG.sweepDeadlineMs),
  };
}

export function planContextCompression({ transcript = [], config = {}, contextBudget = null } = {}) {
  const compression = normalizeContextCompressionConfig(config);
  const chatMessages = (Array.isArray(transcript) ? transcript : []).filter(isCompressionEntry).map((entry) => ({
    id: entry.id || null,
    ts: entry.ts || null,
    sessionId: entry.sessionId || null,
    role: entry.role ? String(entry.role) : null,
    type: entry.type || 'message',
    content: compressionEntryText(entry),
  }));

  const keptMessages = [];
  let keptChars = 0;
  const freshTailMaxChars = compression.freshTailMaxTokens > 0 ? compression.freshTailMaxTokens * 4 : Infinity;
  for (let index = chatMessages.length - 1; index >= 0; index -= 1) {
    const message = chatMessages[index];
    const chars = messageChars(message);
    const separatorChars = keptMessages.length ? 2 : 0;
    const latestMessage = keptMessages.length === 0;
    const underCount = keptMessages.length < compression.freshTailCount;
    const underTokenCap = keptChars + separatorChars + chars <= freshTailMaxChars;
    if (!latestMessage && (!underCount || !underTokenCap)) break;
    keptMessages.unshift(message);
    keptChars += separatorChars + chars;
  }

  const effectiveTokens = contextBudget?.contextTokens ?? contextBudget?.effectiveTokens ?? null;
  const estimatedPromptTokens = contextBudget?.estimatedTokens ?? null;
  const usageRatio = Number.isFinite(Number(effectiveTokens)) && Number(effectiveTokens) > 0 && Number.isFinite(Number(estimatedPromptTokens))
    ? Number(estimatedPromptTokens) / Number(effectiveTokens)
    : contextBudget?.usageRatio ?? null;
  const pressure = contextBudget?.pressure || (usageRatio === null ? 'unknown' : usageRatio >= 1 ? 'blocked' : usageRatio >= 0.9 ? 'compress' : usageRatio >= compression.contextThreshold ? 'watch' : 'ok');
  const pressureTriggers = pressure === 'compress' || pressure === 'blocked' || (Number.isFinite(Number(usageRatio)) && Number(usageRatio) >= compression.contextThreshold);

  const preferredEligibleCount = Math.max(0, chatMessages.length - keptMessages.length);
  // freshTailCount/freshTailMaxTokens describe the preferred raw survivor, not
  // an absolute floor. The final assembled request can be under pressure from
  // profiles, tools, skills, or support context while every transcript entry
  // still fits inside that preferred tail. Only then move enough of the oldest
  // raw tail into the summary candidate to make compaction actionable; when a
  // normal older candidate already exists, preserve the configured tail.
  // Always retain the newest entry as an unreducible continuity anchor.
  if (pressureTriggers && preferredEligibleCount === 0 && keptMessages.length > 1) {
    const targetTokens = Number.isFinite(Number(effectiveTokens)) && Number(effectiveTokens) > 0
      ? Math.floor(Number(effectiveTokens) * compression.contextThreshold)
      : null;
    const estimatedOverage = targetTokens !== null && Number.isFinite(Number(estimatedPromptTokens))
      ? Math.max(0, Number(estimatedPromptTokens) - targetTokens)
      : 0;
    // A newly written summary consumes prompt budget too. Include its target
    // allowance so one pressure sweep has a reasonable chance of reducing the
    // assembled request rather than replacing raw history with an equally large
    // summary.
    const requiredSourceTokens = Math.max(1, estimatedOverage + compression.summaryTargetTokens);
    let movedChars = 0;
    while (keptMessages.length > 1 && estimateTokensFromChars(movedChars) < requiredSourceTokens) {
      const moved = keptMessages.shift();
      movedChars += messageChars(moved) + (movedChars ? 2 : 0);
    }
  }

  const eligibleMessages = chatMessages.slice(0, Math.max(0, chatMessages.length - keptMessages.length));
  const eligibleChars = eligibleMessages.reduce((total, message, index) => total + messageChars(message) + (index ? 2 : 0), 0);
  const estimatedEligibleTokens = estimateTokensFromChars(eligibleChars);
  // The fresh-tail boundary is a post-compression survivor target. Do not let it
  // trigger compression by itself; known-capacity models first get a full active
  // conversation budget, then compression runs only when the assembled prompt is
  // actually under pressure. Unknown-capacity sessions still use the bounded
  // safety trigger because they cannot prove the larger window exists.
  const retentionBoundary = eligibleMessages.length > 0;
  const unknownCapacitySafety = usageRatio === null
    && estimatedEligibleTokens >= Math.min(compression.leafChunkTokens, Math.max(1, compression.summaryTargetTokens));
  const shouldCompress = eligibleMessages.length > 0 && (pressureTriggers || unknownCapacitySafety);

  return {
    shouldCompress,
    reason: !eligibleMessages.length ? 'no_eligible_messages'
      : pressureTriggers ? 'context_pressure'
        : unknownCapacitySafety ? 'unknown_capacity_safety'
          : 'below_threshold',
    config: compression,
    pressure,
    usageRatio,
    totalChatTurnCount: chatMessages.length,
    rawTailTurnCount: keptMessages.length,
    eligibleTurnCount: eligibleMessages.length,
    retentionBoundary,
    estimatedEligibleTokens,
    firstEligibleEntryId: eligibleMessages.at(0)?.id || null,
    lastEligibleEntryId: eligibleMessages.at(-1)?.id || null,
    firstKeptEntryId: keptMessages.at(0)?.id || null,
    latestEntryId: keptMessages.at(-1)?.id || null,
    sourceEntryIds: eligibleMessages.map((message) => message.id).filter(Boolean),
  };
}

export const __test__ = { estimateTokensFromChars, isPromptChatMessage, isExecutionDigest };
