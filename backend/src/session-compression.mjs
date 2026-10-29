import { conversationAuthority } from './conversation-authority.mjs';
import { summarizeSessionTurns } from './session-entry.mjs';
import { planContextCompression } from './context-compression.mjs';
import { contextStatesFromTranscript, renderContextStates } from './session-context-state.mjs';
import { providerTurnsFromTranscript, providerTurnForEntry, providerTurnChars } from './conversation-message-budget.mjs';
import { operationalTelemetry } from './operational-telemetry.mjs';
import { performance } from 'node:perf_hooks';

function isExecutionDigest(entry) {
  return String(entry?.type || '') === 'execution_digest'
    && entry?.metadata?.executionDigest === true
    && (entry?.entersPrompt ?? false) === true
    && String(entry?.content || '').trim();
}

function isPromptChatMessage(entry) {
  return (isExecutionDigest(entry) || ((entry?.type ?? 'message') === 'message'
    && ['user', 'assistant', 'agent'].includes(String(entry?.role || ''))
    && ((entry?.visibility ?? 'chat') === 'chat' || (entry?.metadata?.steering?.status === 'delivered' && entry?.metadata?.providerTurn))
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

function nowIso() {
  return new Date().toISOString();
}

export function compressionSummariesFromTranscript(transcript = []) {
  return (Array.isArray(transcript) ? transcript : [])
    .map((entry) => entry?.metadata?.compressionSummary || null)
    .filter((summary) => summary && summary.kind === 'context-compression-summary' && typeof summary.text === 'string')
    .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
}

export function buildCompressionSummaryRecord({ sessionId = 'default', transcript = [], plan, text = null, maxChars = 6000, clock = nowIso } = {}) {
  if (!plan?.shouldCompress) throw new Error('compression plan is not actionable');
  const messages = (Array.isArray(transcript) ? transcript : []).filter(isCompressionEntry);
  const sourceIds = new Set(plan.sourceEntryIds || []);
  const sourceMessages = messages.filter((message) => sourceIds.has(message.id));
  if (!sourceMessages.length) throw new Error('compression summary has no source entries');
  const summaryText = String(text ?? structuredCompressionSummary(sourceMessages, { maxChars, retainedStates: contextStatesFromTranscript(transcript) })).trim();
  if (!summaryText) throw new Error('compression summary text is required');
  if (summaryText.length > maxChars) throw Object.assign(new Error('compression_preservation_budget_exceeded'), { code: 'compression_preservation_budget_exceeded' });
  const first = sourceMessages.at(0);
  const last = sourceMessages.at(-1);
  return {
    kind: 'context-compression-summary',
    version: 2,
    sessionId: String(sessionId || 'default'),
    createdAt: clock(),
    source: 'bounded-conversation-recap',
    preservation: 'lossy-recap-originals-archived',
    text: summaryText,
    textChars: summaryText.length,
    sourceTurnCount: sourceMessages.length,
    firstSummarizedEntryId: first?.id || null,
    lastSummarizedEntryId: last?.id || null,
    firstKeptEntryId: plan.firstKeptEntryId || null,
    latestEntryId: plan.latestEntryId || null,
    sourceEntryIds: sourceMessages.map((message) => message.id).filter(Boolean),
    planner: {
      reason: plan.reason || null,
      pressure: plan.pressure || 'unknown',
      rawTailTurnCount: plan.rawTailTurnCount ?? null,
      eligibleTurnCount: plan.eligibleTurnCount ?? null,
      estimatedEligibleTokens: plan.estimatedEligibleTokens ?? null,
    },
  };
}

const HANDOFF_DISCLOSURE = '# Compacted Conversation Handoff\nOlder conversation is a lossy recap: prose may be omitted, not lossless evidence. Retrieve authoritative originals with session_search before relying on exact history. Later corrections override earlier statements.\n## Goal and constraints / Completed actions and active state\n## Latest unresolved user ask (inspect originals)\n## Explicit retained state is rendered separately\n';
const OMITTED_ITEM = '[older items omitted; retrieve archived originals]';

function summaryItems(messages = []) {
  return (Array.isArray(messages) ? messages : []).filter(isCompressionEntry).map((entry) => ({
    sourceEntryId: entry.id || null,
    text: compressionEntryText(entry),
  }));
}

// Conversation owns a lossy navigation recap, not inferred task truth. Render the
// wrapper once and omit whole source items; never splice unrelated prose together.
function renderSummaryItems(items = [], maxChars = 6000) {
  if (HANDOFF_DISCLOSURE.length > maxChars) throw Object.assign(new Error('compression_preservation_budget_exceeded'), { code: 'compression_preservation_budget_exceeded' });
  const normalized = items.map(item => ({ sourceEntryId: item?.sourceEntryId || null, text: String(item?.text || '').trim() })).filter(item => item.text);
  const full = HANDOFF_DISCLOSURE + normalized.map(item => item.text).join('\n');
  if (full.length <= maxChars) return full;
  const available = maxChars - HANDOFF_DISCLOSURE.length;
  if (OMITTED_ITEM.length > available) return HANDOFF_DISCLOSURE;
  const kept = []; let used = OMITTED_ITEM.length;
  // Prefer the newest complete items so corrections and unresolved work survive.
  for (let index = normalized.length - 1; index >= 0; index--) {
    const cost = normalized[index].text.length + 1;
    if (used + cost > available) continue;
    kept.unshift(normalized[index]); used += cost;
  }
  return HANDOFF_DISCLOSURE + [OMITTED_ITEM, ...kept.map(item => item.text)].join('\n');
}

export function structuredCompressionSummary(messages = [], { maxChars = 6000, retainedStates = [] } = {}) {
  return renderSummaryItems(summaryItems(messages), maxChars);
}

// Compatibility helper for callers outside the persisted structured path. Strip
// legacy wrappers before rendering one successor wrapper, and keep line items whole.
export function mergeCompressionSummaries({ previousSummary = '', nextSummary = '', maxChars = 6000 } = {}) {
  const strip = value => String(value || '').split('\n').map(line => line.trim()).filter(line => line && line !== '# Compacted Conversation Handoff' && !line.startsWith('Older conversation is a lossy recap:') && !line.startsWith('## ') && !line.startsWith('[older prose omitted;'));
  const seen = new Set();
  const items = [...strip(previousSummary), ...strip(nextSummary)].filter(text => !seen.has(text) && seen.add(text)).map(text => ({ sourceEntryId: null, text }));
  return renderSummaryItems(items, maxChars);
}

function tokenTargetToCharBudget(tokens, fallback = 6000) {
  const number = Number(tokens);
  return Number.isFinite(number) && number > 0 ? Math.ceil(number * 4) : fallback;
}

export async function appendCompressionSummary({ rootDir, sessionId = 'default', transcript = [], expectedGeneration = null, plan, text = null, maxChars = 6000, conversation = null, signal = null } = {}) {
  signal?.throwIfAborted();
  const sourceMessages = (plan.sourceEntryIds || []).length
    ? transcript.filter((entry) => (plan.sourceEntryIds || []).includes(entry?.id) && isCompressionEntry(entry))
    : [];
  const previous = compressionSummariesFromTranscript(transcript);
  const coveredIds = previous.flatMap(item => item.sourceEntryIds || []);
  let priorItems = [];
  // Rebuild covered items from authoritative originals on every cycle. Persisted
  // summaries keep IDs and bounded rendered text, never a second unbounded copy.
  if (coveredIds.length && typeof conversation?.originalEntries === 'function') {
    const entryIds = [...new Set(coveredIds)];
    const wanted = new Set(entryIds);
    const originals = await conversation.originalEntries(sessionId, { entryIds, signal });
    signal?.throwIfAborted();
    priorItems = summaryItems(originals.filter(entry => wanted.has(entry?.id)));
  } else {
    priorItems = previous.flatMap(item => Array.isArray(item.items) ? item.items : []);
  }
  const allItems = [...priorItems, ...summaryItems(sourceMessages)];
  const seenIds = new Set();
  const uniqueItems = allItems.filter(item => !item.sourceEntryId || (!seenIds.has(item.sourceEntryId) && seenIds.add(item.sourceEntryId)));
  const mergedText = text ?? renderSummaryItems(uniqueItems, maxChars);
  const summary = buildCompressionSummaryRecord({ sessionId, transcript, plan, text: mergedText, maxChars });
  summary.sourceEntryIds = [...new Set([...coveredIds, ...summary.sourceEntryIds])];
  summary.sourceTurnCount = summary.sourceEntryIds.length;
  summary.firstSummarizedEntryId = previous[0]?.firstSummarizedEntryId || summary.firstSummarizedEntryId;
  // Semantic compaction creates a compact successor transcript. The prior
  // transcript remains an auditable artifact, but is no longer normal prompt
  // context or normal history-read input.
  const sourceIds = new Set(plan.sourceEntryIds || []);
  // Canonical execution facts are durable history, not disposable prompt tail.
  // They remain in the active transcript even when their surrounding chat is
  // summarized for provider context.
  const retainedUserRuns = new Set(transcript.filter((entry) => ['user', 'agent'].includes(entry.role) && !sourceIds.has(entry.id)).map((entry) => entry.runId));
  const tailEntries = transcript.filter((entry) => !entry?.metadata?.compressionSummary && (entry.type !== 'provider_history' || retainedUserRuns.has(entry.runId)) && (String(entry?.type || '') === 'context_state' || isCanonicalExecutionEntry(entry) || !sourceIds.has(entry?.id)));
  if (!conversation) throw new Error('conversation_store_required');
  const authority = conversation;
  signal?.throwIfAborted();
  const rotation = await authority.compact(sessionId, { summary, tailEntries, expectedEntries: transcript, expectedGeneration, signal });
  signal?.throwIfAborted();
  if (rotation?.stale) return { stale: true, summary, rotation };
  return { entry: rotation.summaryEntry, summary, rotation };
}

// Comparable conversation-only estimates, not a claim about the next assembled
// provider request. Historical dispatch snapshots include their support/image
// estimate; non-conversation prompt sections are deliberately outside this scope.
function conversationTokenEstimate(transcript = [], summary = null, sourceEntryIds = null) {
  const turns = providerTurnsFromTranscript(transcript);
  const removed = sourceEntryIds === null ? null : new Set(sourceEntryIds);
  let chars = 0;
  for (const entry of transcript) {
    const priorSummary = entry?.metadata?.compressionSummary;
    if (priorSummary) {
      if (!removed) chars += String(priorSummary.text || '').length + 2;
    } else if (isCompressionEntry(entry) && !removed?.has(entry.id)) {
      const turn = providerTurnForEntry(entry, turns);
      chars += (turn ? providerTurnChars(turn) : compressionEntryText(entry).length) + 2;
    }
  }
  if (summary) chars += String(summary.text || '').length + 2;
  return Math.ceil(chars / 4);
}

const COMPACTION_REASONS = new Set(['manual', 'context_pressure', 'uncovered_history', 'unknown_capacity_safety', 'below_threshold', 'no_eligible_messages', 'compression_preservation_budget_exceeded', 'stale_transcript', 'session_generation_stale', 'cancelled']);
const compactionReason = reason => COMPACTION_REASONS.has(reason) ? reason : 'other';

export async function runSessionCompression(options = {}) {
  const startedAt = performance.now();
  let started = false, beforeTokens = null, afterTokens = null;
  const fields = () => ({ sessionId: options.sessionId || 'default', ...(options.logger?.runId ? { runId: options.logger.runId } : {}),
    trigger: options.force ? 'manual' : 'automatic', tokenScope: 'conversation', beforeTokens, afterTokens,
    beforeTokenSource: beforeTokens === null ? 'unknown' : 'estimated', afterTokenSource: afterTokens === null ? 'unknown' : 'estimated' });
  // Optional observation must neither affect storage nor create a second owner.
  const observe = (phase, details = {}) => {
    try {
      if (phase === 'assessed') beforeTokens = conversationTokenEstimate(details.transcript);
      if (phase === 'stale') beforeTokens = null;
      if (phase === 'completed') afterTokens = conversationTokenEstimate(details.transcript, details.summary, details.plan.sourceEntryIds);
      if (phase === 'started') {
        started = true;
        operationalTelemetry('context-compaction-started', { ...fields(), reason: compactionReason(details.reason), outcome: 'started', durationMs: 0 });
      }
    } catch { /* Estimates are optional. */ }
  };
  try {
    const result = await compressSession(options, observe);
    if (!result.compressed && result.reason !== 'stale_transcript') afterTokens = beforeTokens;
    operationalTelemetry(started ? 'context-compaction-completed' : 'context-compression-skip', {
      ...fields(), reason: compactionReason(result.reason), outcome: result.compressed ? 'success' : 'noop', durationMs: Math.max(0, performance.now() - startedAt),
    });
    return result;
  } catch (error) {
    const cancelled = options.signal?.aborted || error?.name === 'AbortError';
    operationalTelemetry('context-compaction-failed', { ...fields(), afterTokens: null, afterTokenSource: 'unknown',
      reason: cancelled ? 'cancelled' : compactionReason(error?.code || error?.message), outcome: cancelled ? 'cancelled' : 'failure', durationMs: Math.max(0, performance.now() - startedAt) });
    throw error;
  }
}

async function compressSession({ rootDir, sessionId = 'default', config = {}, contextBudget = null, force = false, maxChars = null, logger = null, stores = null, agentId = 'hatchet', conversation = null, transcriptSnapshot = null, transcriptGeneration = null, expectedGeneration = null, signal = null } = {}, observe) {
  signal?.throwIfAborted();
  if (!conversation && !stores?.conversations) throw new Error('conversation_store_required');
  if (force) contextBudget = { ...contextBudget, pressure: 'compress', reason: 'manual' };
  const authority = conversation || conversationAuthority({ store: stores?.conversations || null, agentId });
  let resolvedGeneration = transcriptGeneration;
  let transcript;
  if (Array.isArray(transcriptSnapshot)) {
    transcript = transcriptSnapshot;
  } else if (typeof authority.sessionSnapshot === 'function') {
    const snapshot = await authority.sessionSnapshot(sessionId, { signal });
    transcript = snapshot.entries;
    resolvedGeneration = snapshot.metadata?.generation ?? null;
  } else {
    transcript = await authority.entriesAll(sessionId, { signal });
  }
  signal?.throwIfAborted();
  // A manual command owns its initial generation even if a non-HTTP producer
  // resets the session without sharing its controller. Never adopt that reset.
  if (expectedGeneration !== null && Number(resolvedGeneration ?? 0) !== expectedGeneration) {
    observe('stale');
    throw Object.assign(new Error('session_generation_stale'), { statusCode: 409 });
  }
  observe('assessed', { transcript });
  const existingSummaries = compressionSummariesFromTranscript(transcript);
  // The active successor already contains the current semantic summary. Only
  // its unsummarized chat tail is eligible for the next rotation.
  const candidateTranscript = transcript.filter((entry) => !entry?.metadata?.compressionSummary);
  const plan = planContextCompression({ transcript: candidateTranscript, config, contextBudget });
  if (force && plan.shouldCompress) plan.reason = 'manual';
  const result = {
    ok: true,
    compressed: false,
    reason: plan.reason,
    plan,
    existingSummaryCount: existingSummaries.length,
    coveredSourceCount: existingSummaries.reduce((count, summary) => count + Number(summary.sourceTurnCount || 0), 0),
  };
  if (!plan.shouldCompress) {
    await logger?.event?.('context-compression-skip', result);
    signal?.throwIfAborted();
    return result;
  }
  // A preparation snapshot is safe for assessment, not a mutation authority.
  // Refresh/replan before rotation so intervening durable entries survive.
  if (Array.isArray(transcriptSnapshot)) return compressSession({ rootDir, sessionId, config, contextBudget, force, maxChars, logger, stores, agentId, conversation: authority, expectedGeneration, signal }, observe);
  const lifecycle = { sessionId, reason: plan.reason, compressed: false };
  await logger?.event?.('context-compaction-started', lifecycle);
  signal?.throwIfAborted();
  observe('started', { reason: plan.reason });
  let appended;
  try {
    appended = await appendCompressionSummary({ rootDir, sessionId, transcript, expectedGeneration: resolvedGeneration, plan, maxChars: maxChars ?? tokenTargetToCharBudget(config.summaryTargetTokens, 6000), conversation: authority, signal });
    signal?.throwIfAborted();
  } catch (error) {
    signal?.throwIfAborted();
    if (error?.name === 'AbortError') throw error;
    if (error.code !== 'compression_preservation_budget_exceeded') {
      await logger?.event?.('context-compaction-failed', { ...lifecycle, error: error?.message || String(error) });
      signal?.throwIfAborted();
      throw error;
    }
    const skipped = { ...result, reason: error.code };
    await logger?.event?.('context-compaction-completed', { ...lifecycle, reason: skipped.reason });
    signal?.throwIfAborted();
    await logger?.event?.('context-compression-skip', skipped);
    signal?.throwIfAborted();
    return skipped;
  }
  if (appended.stale) {
    const skipped = { ...result, reason: 'stale_transcript', plan: appended.rotation?.currentEntries ? planContextCompression({ transcript: appended.rotation.currentEntries.filter((entry) => !entry?.metadata?.compressionSummary), config, contextBudget }) : plan };
    await logger?.event?.('context-compaction-completed', { ...lifecycle, reason: skipped.reason });
    signal?.throwIfAborted();
    await logger?.event?.('context-compression-skip', skipped);
    signal?.throwIfAborted();
    return skipped;
  }
  const { entry, summary, rotation } = appended;
  observe('completed', { transcript, plan, summary });
  const completed = { ...result, compressed: true, entryId: entry.id, summary, rotation: { archiveName: rotation.archiveName, retainedCount: rotation.retainedCount } };
  await logger?.event?.('context-compaction-completed', { ...lifecycle, compressed: true });
  signal?.throwIfAborted();
  await logger?.event?.('context-compression', { compressed: true, entryId: entry.id, summary: { ...summary, text: undefined } });
  signal?.throwIfAborted();
  return completed;
}

export const __test__ = { isPromptChatMessage, structuredCompressionSummary };
