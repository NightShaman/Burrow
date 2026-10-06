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
    version: 1,
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

export function structuredCompressionSummary(messages = [], { maxChars = 6000, retainedStates = [] } = {}) {
  const source = (Array.isArray(messages) ? messages : []).filter(isCompressionEntry);
  return boundedRecap(source.map(compressionEntryText).join('\n'), maxChars);
}

// Conversation owns a lossy navigation recap, not inferred task truth. Explicit
// lifecycle state is rendered independently and must never be clipped to fit it.
function boundedRecap(value, maxChars) {
  const disclosure = '# Compacted Conversation Handoff\nOlder conversation is a lossy recap: prose may be omitted, not lossless evidence. Retrieve authoritative originals with session_search before relying on exact history. Later corrections override earlier statements.\n## Goal and constraints / Completed actions and active state\n## Latest unresolved user ask (inspect originals)\n## Explicit retained state is rendered separately\n';
  if (disclosure.length > maxChars) throw Object.assign(new Error('compression_preservation_budget_exceeded'), { code: 'compression_preservation_budget_exceeded' });
  const text = String(value || '').trim();
  const available = maxChars - disclosure.length;
  if (text.length <= available) return disclosure + text;
  const marker = '\n[older prose omitted; retrieve archived originals]\n';
  if (available < marker.length) return disclosure;
  const chars = available - marker.length;
  const head = Math.floor(chars / 2);
  return disclosure + text.slice(0, head) + marker + text.slice(text.length - (chars - head));
}

export function mergeCompressionSummaries({ previousSummary = '', nextSummary = '', maxChars = 6000 } = {}) {
  const prior = String(previousSummary || '').trim();
  const next = String(nextSummary || '').trim();
  const merged = [prior, next].filter(Boolean).join('\n\n');
  return merged.length <= maxChars ? merged : boundedRecap(merged, maxChars);
}

function tokenTargetToCharBudget(tokens, fallback = 6000) {
  const number = Number(tokens);
  return Number.isFinite(number) && number > 0 ? Math.ceil(number * 4) : fallback;
}

export async function appendCompressionSummary({ rootDir, sessionId = 'default', transcript = [], plan, text = null, maxChars = 6000, conversation = null } = {}) {
  const previousSummary = compressionSummariesFromTranscript(transcript).at(-1)?.text || '';
  const sourceMessages = (plan.sourceEntryIds || []).length
    ? transcript.filter((entry) => (plan.sourceEntryIds || []).includes(entry?.id) && isCompressionEntry(entry))
    : [];
  const combinedText = text ?? structuredCompressionSummary(sourceMessages, { maxChars, retainedStates: contextStatesFromTranscript(transcript) });
  const mergedText = mergeCompressionSummaries({ previousSummary, nextSummary: combinedText, maxChars });
  const summary = buildCompressionSummaryRecord({ sessionId, transcript, plan, text: mergedText, maxChars });
  const previous = compressionSummariesFromTranscript(transcript);
  summary.sourceEntryIds = [...new Set([...previous.flatMap(item => item.sourceEntryIds || []), ...summary.sourceEntryIds])];
  summary.sourceTurnCount += previous.reduce((count, item) => count + Number(item.sourceTurnCount || 0), 0);
  summary.firstSummarizedEntryId = previous[0]?.firstSummarizedEntryId || summary.firstSummarizedEntryId;
  // Semantic compaction creates a compact successor transcript. The prior
  // transcript remains an auditable artifact, but is no longer normal prompt
  // context or normal history-read input.
  const sourceIds = new Set(plan.sourceEntryIds || []);
  // Canonical execution facts are durable history, not disposable prompt tail.
  // They remain in the active transcript even when their surrounding chat is
  // summarized for provider context.
  const tailEntries = transcript.filter((entry) => !entry?.metadata?.compressionSummary && (String(entry?.type || '') === 'context_state' || isCanonicalExecutionEntry(entry) || !sourceIds.has(entry?.id)));
  if (!conversation) throw new Error('conversation_store_required');
  const authority = conversation;
  const rotation = await authority.compact(sessionId, { summary, tailEntries });
  return { entry: rotation.summaryEntry, summary, rotation };
}

export async function runSessionCompression({ rootDir, sessionId = 'default', config = {}, contextBudget = null, maxChars = null, logger = null, stores = null, agentId = 'hatchet', conversation = null } = {}) {
  if (!conversation && !stores?.conversations) throw new Error('conversation_store_required');
  const authority = conversation || conversationAuthority({ store: stores?.conversations || null, agentId });
  const transcript = await authority.entriesAll(sessionId);
  const existingSummaries = compressionSummariesFromTranscript(transcript);
  // The active successor already contains the current semantic summary. Only
  // its unsummarized chat tail is eligible for the next rotation.
  const candidateTranscript = transcript.filter((entry) => !entry?.metadata?.compressionSummary);
  const plan = planContextCompression({ transcript: candidateTranscript, config, contextBudget });
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
  let appended;
  try {
    appended = await appendCompressionSummary({ rootDir, sessionId, transcript, plan, maxChars: maxChars ?? tokenTargetToCharBudget(config.summaryTargetTokens, 6000), conversation: authority });
  } catch (error) {
    if (error.code !== 'compression_preservation_budget_exceeded') throw error;
    const skipped = { ...result, reason: error.code };
    await logger?.event?.('context-compression-skip', skipped);
    return skipped;
  }
  const { entry, summary, rotation } = appended;
  const completed = { ...result, compressed: true, entryId: entry.id, summary, rotation: { archiveName: rotation.archiveName, retainedCount: rotation.retainedCount } };
  await logger?.event?.('context-compression', { compressed: true, entryId: entry.id, summary: { ...summary, text: undefined } });
  return completed;
}

export const __test__ = { isPromptChatMessage, structuredCompressionSummary };
