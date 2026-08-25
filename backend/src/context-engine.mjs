import { buildConversationContext } from './conversation-context.mjs';
import { AGENT_PROFILE_KINDS, AgentProfileStore, profileFilesFromDocuments } from './agent-profile-store.mjs';
import { assertContextBoundary } from './context-boundary.mjs';
import { readSessionEntries } from './session-store.mjs';
import { compressionSummariesFromTranscript } from './session-compression.mjs';
import { planContextCompression } from './context-compression.mjs';
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
} = {}) {
  assertContextBoundary({ rootDir, dataRoot, agentWorkspaceRoot, agentDataRoot, cacheRoot });
  const resolvedTranscript = Array.isArray(transcript)
    ? transcript
    // Read the complete active transcript so the token-derived context budget
    // can choose the useful window. Rotated compacted/reset history remains
    // excluded here; explicit history/search paths own that data.
    : await readSessionEntries({ rootDir: dataRoot, sessionId, limit: 0 });
  let profileFiles = null;
  if (includeProfileFiles && agentRuntime?.agentId && agentRuntime?.settingsDatabasePath) {
    const store = new AgentProfileStore({ databasePath: agentRuntime.settingsDatabasePath });
    try {
      const documents = store.list(agentRuntime.agentId);
      profileFiles = documents.length === AGENT_PROFILE_KINDS.length
        ? profileFilesFromDocuments(documents, { agentId: agentRuntime.agentId })
        : { profileDir: 'sqlite:agent_profile_documents', files: [{ id: 'profile-unavailable', name: 'PROFILE_UNAVAILABLE.md', path: `sqlite:agent_profile_documents/${agentRuntime.agentId}`, content: 'Agent profile documents are unavailable. Do not borrow another agent profile; report this configuration blocker if it affects the task.', chars: 125 }], chars: 125 };
    } finally { store.close(); }
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

function latestCanonicalContextMeterFromTranscript(transcript = []) {
  const entries = Array.isArray(transcript) ? transcript : [];
  // A native tool continuation transmits only its incremental transport
  // payload. It is not a complete measure of the provider's active context,
  // so its smaller size must never replace the run's initial full request.
  // The newest run wins; within that run, its initial request is canonical.
  const byRun = new Map();
  for (const entry of entries) {
    const meter = entry?.metadata?.contextMeter;
    const estimatedTokens = finiteNumber(meter?.estimatedTokens);
    if (estimatedTokens === null) continue;
    const runId = entry?.runId || `entry:${entry?.id || byRun.size}`;
    const measurement = {
      estimatedTokens,
      providerInputTokens: finiteNumber(meter?.providerInputTokens),
      modelCall: finiteNumber(meter?.modelCall),
      continuation: Boolean(meter?.continuation),
      updatedAt: meter?.updatedAt || entry?.ts || null,
      source: meter?.source || 'provider-request-estimate',
      runId: entry?.runId || null,
      provenance: meter?.provenance || (meter?.continuation ? 'continuation-payload' : 'initial-full-request'),
    };
    const existing = byRun.get(runId);
    if (!existing) {
      byRun.set(runId, measurement);
    } else {
      const highWater = Math.max(existing.estimatedTokens, measurement.estimatedTokens, existing.providerInputTokens ?? 0, measurement.providerInputTokens ?? 0);
      byRun.set(runId, {
        ...(measurement.estimatedTokens >= existing.estimatedTokens ? measurement : existing),
        estimatedTokens: highWater,
        highWaterEstimatedTokens: highWater,
        highWaterProviderInputTokens: Math.max(existing.providerInputTokens ?? 0, measurement.providerInputTokens ?? 0) || null,
        continuation: measurement.continuation,
        provenance: measurement.continuation ? 'run-high-water-continuation' : measurement.provenance,
      });
    }
  }
  return [...byRun.values()].at(-1) || null;
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

export function inspectContextEngineResult({ sessionId = 'default', context, transcript = [], contextWindow = null, contextTokens = null } = {}) {
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
  const latestReceipt = latestContextBuildReceiptFromTranscript(transcript);
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
    : reconstructedBudget;
  return {
    sessionId: String(sessionId || 'default'),
    promptSectionOrder: resolvedContext.promptSectionOrder || [],
    promptSections,
    // Inspection owns this explicit user-requested projection; it is not a
    // provider receipt and must not be mistaken for one.
    support: resolvedContext.support || {},
    recentMessages: resolvedContext.recentMessages || [],
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

export async function inspectSessionContext({ rootDir, dataRoot = rootDir, sessionId = 'default', limits = {}, includeProfileFiles = false, agentRuntime = null, contextWindow = null, contextTokens = null, agentWorkspaceRoot = null, agentDataRoot = null, cacheRoot = null } = {}) {
  assertContextBoundary({ rootDir, dataRoot, agentWorkspaceRoot, agentDataRoot, cacheRoot });
  const transcript = await readSessionEntries({ rootDir: dataRoot, sessionId, limit: 0 });
  const context = await buildTurnContext({ rootDir, dataRoot, sessionId, transcript, limits, includeProfileFiles, agentRuntime, agentWorkspaceRoot, agentDataRoot, cacheRoot });
  return inspectContextEngineResult({ sessionId, context, transcript, contextWindow, contextTokens });
}

function finiteNumber(value) {
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
export async function inspectSessionContextStatus({ rootDir, dataRoot = rootDir, sessionId = 'default', limits = {}, contextConfig = {}, contextWindow = null, contextTokens = null, liveContext = null, agentRuntime = null, agentWorkspaceRoot = null, agentDataRoot = null, cacheRoot = null } = {}) {
  assertContextBoundary({ rootDir, dataRoot, agentWorkspaceRoot, agentDataRoot, cacheRoot });
  const transcript = await readSessionEntries({ rootDir: dataRoot, sessionId, limit: 0 });
  const context = await buildTurnContext({ rootDir, dataRoot, sessionId, transcript, limits, includeProfileFiles: false, agentRuntime, agentWorkspaceRoot, agentDataRoot, cacheRoot });
  const inspection = inspectContextEngineResult({ sessionId, context, transcript, contextWindow, contextTokens });
  const budget = inspection.contextBudget || {};
  const summaries = compressionSummariesFromTranscript(transcript);
  const next = planContextCompression({ transcript: transcript.filter((entry) => !entry?.metadata?.compressionSummary), config: contextConfig, contextBudget: budget });
  const usageRatio = finiteNumber(budget.usageRatio);
  // Older receipts redacted token telemetry. Do not pair their preserved ratio
  // with a reconstructed estimate and pretend the two describe one prompt.
  const exactReceiptTokens = finiteNumber(inspection.contextBuildReceipt?.budget?.estimatedTokens);
  const hasFreshReceipt = exactReceiptTokens !== null;
  const receiptEstimatedTokens = hasFreshReceipt
    ? exactReceiptTokens
    : finiteNumber(budget.estimatedTokens);
  const rawCapacityTokens = finiteNumber(budget.contextTokens) ?? finiteNumber(budget.contextWindow);
  // Missing provider metadata is unknown capacity, not a zero-token model.
  // Never turn that absence into a fake 100% blocked meter.
  const capacityTokens = rawCapacityTokens !== null && rawCapacityTokens > 0 ? rawCapacityTokens : null;
  const liveEstimatedTokens = finiteNumber(liveContext?.estimatedTokens);
  const persistedMeter = latestCanonicalContextMeterFromTranscript(transcript);
  const liveIsContinuation = liveContext?.continuation === true;
  const liveCanonicalTokens = liveEstimatedTokens;
  // The active meter is a run-scoped high-water mark. Continuation payloads
  // remain transient for compression planning, but their observed pressure may
  // raise the displayed value without ever lowering it.
  const meterKind = liveCanonicalTokens !== null ? 'live' : (hasFreshReceipt ? 'receipt' : 'persisted');
  const sameRunPersistedTokens = liveIsContinuation && (!liveContext?.runId || !persistedMeter?.runId || persistedMeter.runId === liveContext.runId)
    ? finiteNumber(persistedMeter?.estimatedTokens)
    : null;
  const displayedTokens = liveCanonicalTokens !== null
    ? Math.max(liveCanonicalTokens, sameRunPersistedTokens ?? 0)
    : (hasFreshReceipt ? receiptEstimatedTokens : finiteNumber(persistedMeter?.estimatedTokens) ?? receiptEstimatedTokens);
  const displayedRatio = displayedTokens !== null && capacityTokens !== null ? displayedTokens / capacityTokens : null;
  const displayedPressure = displayedRatio === null ? 'unknown' : contextBudgetPressure(displayedRatio);
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
      estimatedTokens: displayedTokens,
      capacityTokens,
      usageRatio: displayedRatio,
      percent: displayedRatio === null ? null : Math.round(Math.max(0, Math.min(1, displayedRatio)) * 100),
      pressure: displayedPressure,
      source: meterKind === 'live' ? (liveContext.source || 'live-provider-request') : ((meterKind === 'persisted') ? (persistedMeter?.source || 'provider-request-estimate') : (budget.source || 'reconstructed')),
      provenance: meterKind === 'live' ? (liveContext.provenance || (liveIsContinuation ? 'run-high-water-continuation' : 'run-high-water-initial')) : (persistedMeter?.provenance || null),
      lastTurnAt: meterKind === 'live' ? (liveContext.updatedAt || null) : ((meterKind === 'persisted') ? persistedMeter?.updatedAt || null : (inspection.contextBuildReceipt?.entryId ? transcript.find((entry) => entry.id === inspection.contextBuildReceipt.entryId)?.ts || null : null)),
      ...(liveEstimatedTokens !== null ? { active: true, modelCall: finiteNumber(liveContext.modelCall), continuation: liveIsContinuation, providerInputTokens: finiteNumber(liveContext.providerInputTokens) } : {}),
      ...((meterKind === 'persisted' || meterKind === 'continuation-baseline') ? { modelCall: persistedMeter?.modelCall || null, continuation: meterKind === 'continuation-baseline' ? true : Boolean(persistedMeter?.continuation), providerInputTokens: persistedMeter?.providerInputTokens || null, runId: persistedMeter?.runId || null } : {}),
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
