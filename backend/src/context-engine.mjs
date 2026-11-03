import { buildConversationContext } from './conversation-context.mjs';
import { AGENT_PROFILE_KINDS, AgentProfileStore, profileFilesFromDocuments } from './agent-profile-store.mjs';
import { assertContextBoundary } from './context-boundary.mjs';
import { conversationAuthority } from './conversation-authority.mjs';
import { compressionSummariesFromTranscript } from './session-compression.mjs';
import { planContextCompression } from './context-compression.mjs';
import { operationalTelemetry } from './operational-telemetry.mjs';
import {
  assertContextEngineContract,
  createContextEngineResult,
} from './chat-runtime-contracts.mjs';

export const DEFAULT_CONTEXT_LIMITS = Object.freeze({
  rawRecentChars: 6_000,
  priorSummaryChars: 4_000,
});

function normalizeLimits(limits = {}) {
  return {
    rawRecentChars: limits.rawRecentChars ?? limits.conversationChars ?? limits.recentDialogueChars ?? DEFAULT_CONTEXT_LIMITS.rawRecentChars,
    priorSummaryChars: limits.priorSummaryChars ?? DEFAULT_CONTEXT_LIMITS.priorSummaryChars,
    minRawRecentTurns: limits.minRawRecentTurns,
    maxRawRecentTurns: limits.maxRawRecentTurns,
    maxPromptExecutionDigests: limits.maxPromptExecutionDigests,
  };
}

function sideChannelExclusionsFromConversation(conversation = {}) {
  const counts = conversation.excludedCounts || {};
  const chars = conversation.excludedChars || {};
  return {
    counts: {
      events: counts.events ?? conversation.stats?.excludedEventCount ?? 0,
      receipts: counts.receipts ?? conversation.stats?.excludedReceiptCount ?? 0,
      debug: counts.debug ?? conversation.stats?.excludedDebugCount ?? 0,
    },
    chars: {
      events: chars.events ?? conversation.stats?.excludedEventChars ?? 0,
      receipts: chars.receipts ?? conversation.stats?.excludedReceiptChars ?? 0,
      debug: chars.debug ?? conversation.stats?.excludedDebugChars ?? 0,
    },
  };
}

export function buildContextEngineResult({ transcript = [], limits = {}, support = {}, promptSections = [] } = {}) {
  const resolvedLimits = normalizeLimits(limits);
  const conversation = buildConversationContext({ transcript, limits: resolvedLimits });
  const result = createContextEngineResult({
    recentMessages: conversation.recentMessages,
    priorSummary: conversation.priorSummary,
    support,
    promptSections,
    stats: conversation.stats,
    sideChannelExclusions: sideChannelExclusionsFromConversation(conversation),
  });
  return {
    ...result,
    conversation,
    priorMessages: conversation.priorMessages,
    summaryProvenance: conversation.summaryProvenance,
    limits: resolvedLimits,
  };
}

export async function buildTurnContext({
  rootDir,
  dataRoot = rootDir,
  sessionId = 'default',
  transcript = null,
  limits = {},
  support = {},
  promptSections = [],
  agentRuntime = null,
  includeProfileFiles = true,
  agentWorkspaceRoot = null,
  agentDataRoot = null,
  cacheRoot = null,
  stores = null,
  agentId = 'hatchet',
} = {}) {
  assertContextBoundary({ rootDir, dataRoot, agentWorkspaceRoot, agentDataRoot, cacheRoot });
  const resolvedTranscript = Array.isArray(transcript)
    ? transcript
    // Read the complete active transcript so the token-derived context budget
    // can choose the useful window. Rotated compacted/reset history remains
    // excluded here; explicit history/search paths own that data.
    : await conversationAuthority({ store: stores?.conversations || null, agentId }).entriesAll(sessionId);
  let profileFiles = null;
  // A mod-owned agent never borrows the ordinary agent/global profile, even
  // during inspection or a compression rebuild. Its owner supplies it per turn.
  if (includeProfileFiles && agentRuntime?.agentId && !agentRuntime?.agent?.modAgent) {
    const store = stores?.profiles;
    if (!store) throw new Error('agent_profile_store_required');
    try {
      const documents = await store.list(agentRuntime.agentId);
      // DREAM_MEMORY remains operator-readable legacy state, but is retired from
      // runtime prompt injection. Dreaming now publishes individual Brains.
      const promptDocuments = documents.filter(document => document.kind !== 'DREAM_MEMORY');
      profileFiles = documents.length === AGENT_PROFILE_KINDS.length
        ? profileFilesFromDocuments(promptDocuments, { agentId: agentRuntime.agentId, globalDocuments: await store.listGlobal(), globalProfile: await store.globalProfile(agentRuntime.agentId) })
        : { profileDir: 'postgres:agent_profile_documents', files: [{ id: 'profile-unavailable', name: 'PROFILE_UNAVAILABLE.md', path: `postgres:agent_profile_documents/${agentRuntime.agentId}`, content: 'Agent profile documents are unavailable. Do not borrow another agent profile; report this configuration blocker if it affects the task.', chars: 125 }], chars: 125 };
    } finally { /* composed store remains open */ }
  }
  const context = buildContextEngineResult({
    transcript: resolvedTranscript,
    limits,
    support: profileFiles?.files?.length ? { ...support, profileFiles } : support,
    promptSections,
  });
  assertContextEngineContract(context);
  return context;
}

function renderedMessageChars(messages = []) {
  return messages.reduce((total, message, index) => {
    const rendered = `${message.role}: ${String(message.content || '').trim()}`;
    return total + rendered.length + (index ? 2 : 0);
  }, 0);
}

function entryInstant(entry = {}) {
  const value = Date.parse(entry.ts ?? entry.timestamp ?? entry.at ?? entry.createdAt ?? '');
  return Number.isFinite(value) ? value : null;
}

function activeTranscriptAfterReset(transcript = [], resetAt = null) {
  const resetInstant = Date.parse(resetAt || '');
  const entries = Array.isArray(transcript) ? transcript : [];
  if (!Number.isFinite(resetInstant)) return entries;
  return entries.filter((entry) => {
    const instant = entryInstant(entry);
    return instant === null || instant > resetInstant;
  });
}

// Rotation prepends the summary *before* retained tail/telemetry and assigns
// fresh storage cursors. Neither summary position nor sequence is a freshness
// boundary. Use the planner's last retained chat identity first; clocks are only
// a fallback for telemetry emitted later in that same run (or legacy summaries).
function currentContextMeasurements(transcript = []) {
  const entries = Array.isArray(transcript) ? transcript : [];
  const summary = compressionSummariesFromTranscript(entries).at(-1);
  if (!summary) return { entries, acceptsLive: () => true, compacted: false };
  const boundary = summary.latestEntryId
    ? entries.findIndex(entry => entry?.id === summary.latestEntryId) : -1;
  const successorRuns = new Set(entries.slice(boundary + 1)
    .filter(entry => entry?.type === 'message' && ['user', 'agent'].includes(entry.role) && entry.runId)
    .map(entry => entry.runId));
  const compactedAt = entryInstant({ ts: summary.createdAt });
  const fresh = (entry, index = null) => {
    if (boundary >= 0 && index !== null && index <= boundary) return false;
    if (boundary >= 0 && entry?.runId && successorRuns.has(entry.runId)) return true;
    const instant = entryInstant(entry);
    // Ambiguous/missing clocks cannot prove a successor measurement. In
    // particular, a retained old live high-water must not resurrect the meter.
    return instant !== null && compactedAt !== null && instant > compactedAt;
  };
  return {
    entries: entries.filter((entry, index) => fresh(entry, index)),
    acceptsLive: live => fresh({ runId: live?.runId, ts: live?.updatedAt }),
    compacted: true,
  };
}

function latestRuntimeReceiptFromTranscript(transcript = []) {
  const entries = Array.isArray(transcript) ? transcript : [];
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    const metadata = entry?.metadata || {};
    const receipt = metadata.receiptRef || metadata.receipt || null;
    const memoryIntent = metadata.memoryIntent || metadata.outcome?.memory || receipt?.memoryIntent || null;
    const contextBuildReceipt = receipt?.contextBuildReceipt || null;
    if (!memoryIntent && !contextBuildReceipt) continue;
    return { entry, memoryIntent, contextBuildReceipt };
  }
  return null;
}

function latestMemoryProvenanceFromTranscript(transcript = []) {
  const latest = latestRuntimeReceiptFromTranscript(transcript);
  if (!latest?.memoryIntent) return { source: 'none', recall: null, handoff: null, writeback: null };
  const { entry, memoryIntent } = latest;
  return {
    source: 'latest-runtime-receipt',
    entryId: entry.id || null,
    runId: entry.runId || null,
    traceDir: entry.traceDir || null,
    recall: memoryIntent.recall || null,
    handoff: memoryIntent.handoff || null,
    writeback: memoryIntent.writeback || null,
  };
}

function latestContextBuildReceiptFromTranscript(transcript = []) {
  const latest = latestRuntimeReceiptFromTranscript(transcript);
  if (!latest?.contextBuildReceipt) return null;
  return {
    ...latest.contextBuildReceipt,
    source: 'latest-runtime-receipt',
    entryId: latest.entry.id || null,
    runId: latest.entry.runId || null,
    traceDir: latest.entry.traceDir || null,
  };
}

function latestContextMeterFromTranscript(transcript = []) {
  // Store order is authoritative. A smaller prepared continuation/terminal
  // request replaces a larger predecessor; this is not a run peak.
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    const meter = entry?.metadata?.contextMeter;
    if (finiteNumber(meter?.estimatedTokens) === null) continue;
    return { ...meter, runId: entry.runId || meter.runId || null,
      updatedAt: meter.updatedAt || entry.ts || null, entryId: entry.id || null, entryIndex: index };
  }
  return null;
}

// Public diagnostic projection, never the estimate used by request admission.
// Missing/legacy correlation is historical, not invented current API usage.
export function contextUsageProjection(meter = {}, { reconstructed = false } = {}) {
  const correlated = Boolean(meter.requestId && ['request-estimate', 'response'].includes(meter.stage));
  const providerInputTokens = correlated && meter.stage === 'response' ? finiteNumber(meter.providerInputTokens) : null;
  const requestEstimatedTokens = finiteNumber(meter.requestEstimatedTokens) ?? finiteNumber(meter.estimatedTokens);
  const measured = providerInputTokens !== null && providerInputTokens >= 0;
  const text = value => typeof value === 'string' && value.length ? value.slice(0, 256) : null;
  return {
    estimatedTokens: measured ? providerInputTokens : finiteNumber(meter.estimatedTokens),
    requestEstimatedTokens,
    scope: reconstructed ? 'reconstructed' : correlated ? 'latest-request' : 'historical',
    source: measured ? 'provider-input-tokens' : (meter.source === 'provider-input-tokens' ? 'provider-request-estimate' : meter.source || 'provider-request-estimate'),
    provenance: correlated ? (meter.stage === 'response' ? 'latest-request-response' : 'latest-request-estimate') : meter.provenance || null,
    lastTurnAt: meter.updatedAt || null,
    runId: text(meter.runId),
    modelCall: finiteNumber(meter.modelCall),
    continuation: Boolean(meter.continuation),
    requestId: correlated ? text(meter.requestId) : null,
    stage: correlated ? meter.stage : null,
    providerInputTokens,
    provider: correlated ? text(meter.provider) : null,
    providerName: correlated ? text(meter.providerName) : null,
    connectionId: correlated ? text(meter.connectionId) : null,
    logicalConnectionId: correlated ? text(meter.logicalConnectionId) : null,
    model: correlated ? text(meter.model) : null,
    api: correlated ? text(meter.api) : null,
    responseModel: correlated && meter.stage === 'response' ? text(meter.responseModel) : null,
    responseId: correlated && meter.stage === 'response' ? text(meter.responseId) : null,
    responseStatus: correlated && meter.stage === 'response' ? finiteNumber(meter.responseStatus) : null,
    responseOk: correlated && meter.stage === 'response' && typeof meter.responseOk === 'boolean' ? meter.responseOk : null,
  };
}

function estimateTokensFromChars(chars = 0) {
  return Math.ceil(Number(chars || 0) / 4);
}

function contextBudgetPressure(usageRatio = 0) {
  if (usageRatio >= 1) return 'blocked';
  if (usageRatio >= 0.9) return 'compress';
  if (usageRatio >= 0.75) return 'watch';
  return 'ok';
}

function contextBudgetState({ promptSections = [], contextWindow = null, contextTokens = null } = {}) {
  const sectionChars = promptSections.reduce((total, section) => total + Number(section.chars || 0), 0);
  const estimatedTokens = estimateTokensFromChars(sectionChars);
  const nativeWindow = Number.isFinite(Number(contextWindow)) && Number(contextWindow) > 0 ? Number(contextWindow) : null;
  const effectiveWindow = Number.isFinite(Number(contextTokens)) && Number(contextTokens) > 0
    ? Number(contextTokens)
    : nativeWindow;
  const remainingTokens = effectiveWindow === null ? null : Math.max(0, effectiveWindow - estimatedTokens);
  const usageRatio = effectiveWindow === null ? null : estimatedTokens / effectiveWindow;
  return {
    contextWindow: nativeWindow,
    contextTokens: effectiveWindow,
    estimatedChars: sectionChars,
    estimatedTokens,
    remainingTokens,
    usageRatio,
    pressure: usageRatio === null ? 'unknown' : contextBudgetPressure(usageRatio),
  };
}

function observeContextPressure({ sessionId, runId = null, usageTokens, budgetTokens, usageRatio, pressure, source, measured = false }) {
  try {
    const known = value => value != null && typeof value !== 'boolean' && Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
    const usage = known(usageTokens), capacity = known(budgetTokens);
    operationalTelemetry('context-pressure', { sessionId: String(sessionId || 'default'), ...(runId ? { runId } : {}),
      usageTokens: usage, budgetTokens: capacity > 0 ? capacity : null, usageRatio: known(usageRatio),
      tokenSource: usage === null ? 'unknown' : measured ? 'measured' : 'estimated', source,
      pressure: ['ok', 'watch', 'compress', 'blocked'].includes(pressure) ? pressure : 'unknown' });
  } catch { /* Observation cannot change context construction. */ }
}

export function inspectContextEngineResult({ sessionId = 'default', context, transcript = [], contextWindow = null, contextTokens = null, observeTelemetry = true } = {}) {
  const resolvedContext = context || buildContextEngineResult({ transcript });
  const conversation = conversationContextFromEngine(resolvedContext);
  const sectionSizes = {
    conversation: renderedMessageChars(resolvedContext.recentMessages || []),
    'prior-conversation-summary': String(resolvedContext.priorSummary || '').length,
    skills: JSON.stringify(resolvedContext.support?.selectedSkills || []).length,
    'current-message': JSON.stringify(resolvedContext.support?.task || {}).length,
    task: JSON.stringify(resolvedContext.support?.task || {}).length,
  };
  const promptSections = (resolvedContext.promptSectionOrder || []).map((id) => ({ id, chars: sectionSizes[id] ?? 0 }));
  const reconstructedBudget = contextBudgetState({ promptSections, contextWindow, contextTokens });
  // A fresh turn records the exact assembled-prompt budget. Prefer it over
  // reconstructed dialogue-only inspection so the UI meter reflects what the
  // model actually received: profile files, skills, memory, and support packs.
  const measurements = currentContextMeasurements(transcript);
  const latestReceipt = latestContextBuildReceiptFromTranscript(measurements.entries);
  const receiptBudget = latestReceipt?.budget;
  const receiptEstimatedTokens = Number(receiptBudget?.estimatedTokens);
  const receiptUsageRatio = Number(receiptBudget?.usageRatio);
  const hasReceiptBudget = receiptBudget && (Number.isFinite(receiptEstimatedTokens) || Number.isFinite(receiptUsageRatio));
  const budget = hasReceiptBudget
    ? (() => {
      const effectiveTokens = receiptBudget.contextTokens ?? receiptBudget.contextWindow ?? reconstructedBudget.contextTokens;
      const estimatedTokens = Number.isFinite(receiptEstimatedTokens) ? receiptEstimatedTokens : reconstructedBudget.estimatedTokens;
      const usageRatio = Number.isFinite(receiptUsageRatio)
        ? receiptUsageRatio
        : effectiveTokens === null ? null : estimatedTokens / effectiveTokens;
      return {
        ...reconstructedBudget,
        ...receiptBudget,
        contextWindow: receiptBudget.contextWindow ?? reconstructedBudget.contextWindow,
        contextTokens: receiptBudget.contextTokens ?? receiptBudget.contextWindow ?? reconstructedBudget.contextTokens,
        estimatedTokens,
        remainingTokens: effectiveTokens === null || !Number.isFinite(receiptEstimatedTokens) ? null : Math.max(0, effectiveTokens - estimatedTokens),
        usageRatio,
        pressure: usageRatio === null ? 'unknown' : contextBudgetPressure(usageRatio),
        source: 'latest-runtime-receipt',
      };
    })()
    : { ...reconstructedBudget, ...(measurements.compacted ? { source: 'reconstructed', provenance: 'post-compaction-estimate' } : {}) };
  // Receipt token provenance is preserved; reconstruction is a narrower
  // conversation/support estimate, never a fresh provider measurement.
  if (observeTelemetry) observeContextPressure({ sessionId, runId: latestReceipt?.runId,
    usageTokens: hasReceiptBudget ? receiptBudget.estimatedTokens : budget.estimatedTokens,
    budgetTokens: budget.contextTokens ?? budget.contextWindow, usageRatio: budget.usageRatio, pressure: budget.pressure,
    source: hasReceiptBudget ? 'runtime_receipt' : 'reconstructed', measured: receiptBudget?.source === 'provider-input-tokens' });
  return {
    sessionId: String(sessionId || 'default'),
    promptSectionOrder: resolvedContext.promptSectionOrder || [],
    promptSections,
    // Inspection owns this explicit user-requested projection; it is not a
    // provider receipt and must not be mistaken for one.
    support: resolvedContext.support || {},
    recentMessages: resolvedContext.recentMessages || [],
    promptEnteringEntries: conversation.promptEnteringEntries || [],
    rawRecentTurnCount: resolvedContext.stats?.rawRecentTurnCount ?? resolvedContext.recentMessages?.length ?? 0,
    totalChatTurnCount: resolvedContext.stats?.totalChatTurnCount ?? conversation.stats?.totalChatTurnCount ?? 0,
    priorSummary: {
      present: Boolean(resolvedContext.priorSummary),
      chars: String(resolvedContext.priorSummary || '').length,
      text: resolvedContext.priorSummary || '',
    },
    summary: {
      ...(resolvedContext.summaryProvenance || conversation.summaryProvenance || {}),
      firstKeptEntryId: resolvedContext.stats?.firstKeptEntryId ?? conversation.stats?.firstKeptEntryId ?? null,
      summarizedTurnCount: resolvedContext.stats?.summarizedTurnCount ?? conversation.stats?.summarizedTurnCount ?? 0,
    },
    sideChannelExclusions: resolvedContext.sideChannelExclusions || { counts: conversation.excludedCounts || {}, chars: conversation.excludedChars || {} },
    memoryProvenance: latestMemoryProvenanceFromTranscript(transcript),
    workingContinuity: latestReceipt?.providers?.workingContinuity || { scope: null, reason: 'unavailable', included: [], omittedCount: 0, candidateCount: 0, chars: 0 },
    // This is the compact receipt from the last actual assembled prompt, not
    // a reconstructed prompt. It intentionally excludes prompt text.
    contextBuildReceipt: latestReceipt,
    contextBudget: budget,
    compression: {
      active: Boolean(resolvedContext.priorSummary),
      pressure: budget.pressure,
      summarizedTurnCount: resolvedContext.stats?.summarizedTurnCount ?? conversation.stats?.summarizedTurnCount ?? 0,
      rawRecentTurnCount: resolvedContext.stats?.rawRecentTurnCount ?? resolvedContext.recentMessages?.length ?? 0,
      firstKeptEntryId: resolvedContext.stats?.firstKeptEntryId ?? conversation.stats?.firstKeptEntryId ?? null,
    },
    stats: resolvedContext.stats || {},
  };
}

export async function inspectSessionContext({ rootDir, dataRoot = rootDir, sessionId = 'default', limits = {}, includeProfileFiles = false, agentRuntime = null, contextWindow = null, contextTokens = null, agentWorkspaceRoot = null, agentDataRoot = null, cacheRoot = null, stores = null, conversationStore = stores?.conversations || null, agentId = agentRuntime?.agentId || 'hatchet' } = {}) {
  assertContextBoundary({ rootDir, dataRoot, agentWorkspaceRoot, agentDataRoot, cacheRoot });
  const authority = conversationAuthority({ store: conversationStore, agentId });
  const snapshot = await authority.sessionSnapshot(sessionId);
  const transcript = activeTranscriptAfterReset(snapshot.entries, snapshot.metadata?.resetAt);
  const context = await buildTurnContext({ rootDir, dataRoot, sessionId, transcript, limits, includeProfileFiles, agentRuntime, agentWorkspaceRoot, agentDataRoot, cacheRoot, stores, agentId });
  return inspectContextEngineResult({ sessionId, context, transcript, contextWindow, contextTokens });
}

function finiteNumber(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactCompressionSummary(summary = {}) {
  const planner = summary.planner || {};
  return {
    id: summary.firstSummarizedEntryId || summary.createdAt || null,
    createdAt: summary.createdAt || null,
    sourceTurnCount: Number(summary.sourceTurnCount || 0),
    firstSummarizedEntryId: summary.firstSummarizedEntryId || null,
    lastSummarizedEntryId: summary.lastSummarizedEntryId || null,
    firstKeptEntryId: summary.firstKeptEntryId || null,
    reason: planner.reason || null,
    pressure: planner.pressure || 'unknown',
    rawTailTurnCount: finiteNumber(planner.rawTailTurnCount),
    eligibleTurnCount: finiteNumber(planner.eligibleTurnCount),
    estimatedEligibleTokens: finiteNumber(planner.estimatedEligibleTokens),
  };
}

// A deliberately small projection for status bars and agent cards. Unlike the
// inspection endpoint it contains no transcript, prompt text, or provider body.
export async function inspectSessionContextStatus({ rootDir, dataRoot = rootDir, sessionId = 'default', limits = {}, contextConfig = {}, contextWindow = null, contextTokens = null, liveContext = null, agentRuntime = null, agentWorkspaceRoot = null, agentDataRoot = null, cacheRoot = null, stores = null, conversationStore = stores?.conversations || null, agentId = agentRuntime?.agentId || 'hatchet' } = {}) {
  assertContextBoundary({ rootDir, dataRoot, agentWorkspaceRoot, agentDataRoot, cacheRoot });
  const authority = conversationAuthority({ store: conversationStore, agentId });
  const snapshot = await authority.sessionSnapshot(sessionId);
  const transcript = activeTranscriptAfterReset(snapshot.entries, snapshot.metadata?.resetAt);
  const context = await buildTurnContext({ rootDir, dataRoot, sessionId, transcript, limits, includeProfileFiles: false, agentRuntime, agentWorkspaceRoot, agentDataRoot, cacheRoot, stores, agentId });
  const inspection = inspectContextEngineResult({ sessionId, context, transcript, contextWindow, contextTokens, observeTelemetry: false });
  const budget = inspection.contextBudget || {};
  const summaries = compressionSummariesFromTranscript(transcript);
  const next = planContextCompression({ transcript: transcript.filter((entry) => !entry?.metadata?.compressionSummary), config: contextConfig, contextBudget: budget });
  const rawCapacityTokens = finiteNumber(contextTokens) ?? finiteNumber(contextWindow)
    ?? finiteNumber(budget.contextTokens) ?? finiteNumber(budget.contextWindow);
  const capacityTokens = rawCapacityTokens !== null && rawCapacityTokens > 0 ? rawCapacityTokens : null;
  const measurements = currentContextMeasurements(transcript);
  if (!measurements.acceptsLive(liveContext)) liveContext = null;
  const liveEstimatedTokens = finiteNumber(liveContext?.estimatedTokens);
  const persistedMeter = latestContextMeterFromTranscript(measurements.entries);
  const receipt = inspection.contextBuildReceipt;
  const hasReceipt = finiteNumber(receipt?.budget?.estimatedTokens) !== null;
  const receiptIndex = !hasReceipt ? -1 : receipt.entryId
    ? measurements.entries.findIndex(entry => entry.id === receipt.entryId)
    : measurements.entries.findLastIndex(entry => (entry.metadata?.receiptRef || entry.metadata?.receipt)?.contextBuildReceipt);
  const meterIndex = persistedMeter?.entryIndex ?? -1;
  const meterKind = liveEstimatedTokens !== null ? 'live'
    : persistedMeter && meterIndex > receiptIndex ? 'persisted' : hasReceipt ? 'receipt'
      : persistedMeter ? 'persisted' : 'reconstructed';
  const meter = meterKind === 'live' ? liveContext : meterKind === 'persisted' ? persistedMeter
    : meterKind === 'receipt' ? { ...receipt.budget, runId: receipt.runId,
      updatedAt: receipt.budget.updatedAt || measurements.entries[receiptIndex]?.ts || null } : budget;
  const projected = contextUsageProjection(meter, { reconstructed: meterKind === 'reconstructed' });
  const displayedTokens = projected.estimatedTokens;
  const displayedRatio = displayedTokens !== null && capacityTokens !== null ? displayedTokens / capacityTokens : null;
  const displayedPressure = displayedRatio === null ? 'unknown' : contextBudgetPressure(displayedRatio);
  observeContextPressure({ sessionId, runId: projected.runId,
    usageTokens: displayedTokens, budgetTokens: capacityTokens, usageRatio: displayedRatio, pressure: displayedPressure,
    source: meterKind === 'receipt' ? 'runtime_receipt' : meterKind,
    measured: projected.source === 'provider-input-tokens' });
  const recall = inspection.contextBuildReceipt?.providers?.sessionRecall || {};
  return {
    sessionId: inspection.sessionId,
    runEvidence: inspection.contextBuildReceipt?.providers?.runEvidence || {
      candidateCount: 0, selectedCount: 0, omittedCount: 0, chars: 0, reason: null, selected: [], omitted: [],
    },
    recall: {
      requested: Boolean(recall.requested),
      used: Boolean(recall.used),
      scope: recall.scope || null,
      sourceCount: finiteNumber(recall.sourceCount) || 0,
      searchedSessionCount: finiteNumber(recall.searchedSessionCount) || 0,
    },
    context: {
      ...projected,
      capacityTokens,
      usageRatio: displayedRatio,
      percent: displayedRatio === null ? null : Math.round(Math.max(0, Math.min(1, displayedRatio)) * 100),
      pressure: displayedPressure,
      source: meterKind === 'reconstructed' ? budget.source || 'reconstructed' : projected.source,
      ...(meterKind === 'live' ? { active: true } : {}),
    },
    compaction: {
      active: summaries.length > 0,
      summarizedTurnCount: inspection.compression?.summarizedTurnCount || 0,
      rawRecentTurnCount: inspection.compression?.rawRecentTurnCount || 0,
      next: {
        ready: Boolean(next.shouldCompress),
        reason: next.reason,
        pressure: next.pressure,
        eligibleTurnCount: next.eligibleTurnCount,
        estimatedEligibleTokens: next.estimatedEligibleTokens,
      },
      last: summaries.length ? compactCompressionSummary(summaries.at(-1)) : null,
      history: summaries.slice(-10).reverse().map(compactCompressionSummary),
    },
  };
}

export function conversationContextFromEngine(contextEngineResult = {}) {
  return contextEngineResult.conversation || {
    recentMessages: contextEngineResult.recentMessages || [],
    priorSummary: contextEngineResult.priorSummary || '',
    priorMessages: contextEngineResult.priorMessages || [],
    summaryProvenance: contextEngineResult.summaryProvenance || null,
    excludedCounts: contextEngineResult.sideChannelExclusions?.counts || {},
    excludedChars: contextEngineResult.sideChannelExclusions?.chars || {},
    stats: contextEngineResult.stats || {},
  };
}
