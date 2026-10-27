import { conversationAuthority } from './conversation-authority.mjs';
import { summarizeSessionTurns } from './session-entry.mjs';
import { planContextCompression } from './context-compression.mjs';
import { contextStatesFromTranscript, renderContextStates } from './session-context-state.mjs';

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

export async function appendCompressionSummary({ rootDir, sessionId = 'default', transcript = [], expectedGeneration = null, plan, text = null, maxChars = 6000, conversation = null } = {}) {
  const sourceMessages = (plan.sourceEntryIds || []).length
    ? transcript.filter((entry) => (plan.sourceEntryIds || []).includes(entry?.id) && isCompressionEntry(entry))
    : [];
  const previous = compressionSummariesFromTranscript(transcript);
  const coveredIds = previous.flatMap(item => item.sourceEntryIds || []);
  let priorItems = [];
  // Rebuild covered items from authoritative originals on every cycle. Persisted
  // summaries keep IDs and bounded rendered text, never a second unbounded copy.
  if (coveredIds.length && typeof conversation?.originalEntries === 'function') {
    const wanted = new Set(coveredIds);
    priorItems = summaryItems((await conversation.originalEntries(sessionId)).filter(entry => wanted.has(entry?.id)));
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
  const rotation = await authority.compact(sessionId, { summary, tailEntries, expectedEntries: transcript, expectedGeneration });
  if (rotation?.stale) return { stale: true, summary, rotation };
  return { entry: rotation.summaryEntry, summary, rotation };
}

export async function runSessionCompression({ rootDir, sessionId = 'default', config = {}, contextBudget = null, force = false, maxChars = null, logger = null, stores = null, agentId = 'hatchet', conversation = null, transcriptSnapshot = null, transcriptGeneration = null } = {}) {
  if (!conversation && !stores?.conversations) throw new Error('conversation_store_required');
  if (force) contextBudget = { ...contextBudget, pressure: 'compress', reason: 'manual' };
  const authority = conversation || conversationAuthority({ store: stores?.conversations || null, agentId });
  let resolvedGeneration = transcriptGeneration;
  let transcript;
  if (Array.isArray(transcriptSnapshot)) {
    transcript = transcriptSnapshot;
  } else if (typeof authority.sessionSnapshot === 'function') {
    const snapshot = await authority.sessionSnapshot(sessionId);
    transcript = snapshot.entries;
    resolvedGeneration = snapshot.metadata?.generation ?? null;
  } else {
    transcript = await authority.entriesAll(sessionId);
  }
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
    return result;
  }
  // A preparation snapshot is safe for assessment, not a mutation authority.
  // Refresh/replan before rotation so intervening durable entries survive.
  if (Array.isArray(transcriptSnapshot)) return runSessionCompression({ rootDir, sessionId, config, contextBudget, force, maxChars, logger, stores, agentId, conversation: authority });
  const lifecycle = { sessionId, reason: plan.reason, compressed: false };
  await logger?.event?.('context-compaction-started', lifecycle);
  let appended;
  try {
    appended = await appendCompressionSummary({ rootDir, sessionId, transcript, expectedGeneration: resolvedGeneration, plan, maxChars: maxChars ?? tokenTargetToCharBudget(config.summaryTargetTokens, 6000), conversation: authority });
  } catch (error) {
    if (error.code !== 'compression_preservation_budget_exceeded') {
      await logger?.event?.('context-compaction-failed', { ...lifecycle, error: error?.message || String(error) });
      throw error;
    }
    const skipped = { ...result, reason: error.code };
    await logger?.event?.('context-compaction-completed', { ...lifecycle, reason: skipped.reason });
    await logger?.event?.('context-compression-skip', skipped);
    return skipped;
  }
  if (appended.stale) {
    const skipped = { ...result, reason: 'stale_transcript', plan: appended.rotation?.currentEntries ? planContextCompression({ transcript: appended.rotation.currentEntries.filter((entry) => !entry?.metadata?.compressionSummary), config, contextBudget }) : plan };
    await logger?.event?.('context-compaction-completed', { ...lifecycle, reason: skipped.reason });
    await logger?.event?.('context-compression-skip', skipped);
    return skipped;
  }
  const { entry, summary, rotation } = appended;
  const completed = { ...result, compressed: true, entryId: entry.id, summary, rotation: { archiveName: rotation.archiveName, retainedCount: rotation.retainedCount } };
  await logger?.event?.('context-compaction-completed', { ...lifecycle, compressed: true });
  await logger?.event?.('context-compression', { compressed: true, entryId: entry.id, summary: { ...summary, text: undefined } });
  return completed;
}

export const __test__ = { isPromptChatMessage, structuredCompressionSummary };
