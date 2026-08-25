import { summarizeSessionTurns } from './session-store.mjs';
import { compressionSummariesFromTranscript } from './session-compression.mjs';
import { contextStatesFromTranscript, renderContextStates } from './session-context-state.mjs';

function messageText(message) {
  if (message.role === 'agent') return `[Agent message from ${message.metadata?.fromAgentName || message.metadata?.fromAgentId || 'another agent'} to ${message.metadata?.toAgentId || 'this agent'} — ${message.metadata?.messageMode || 'deliver'}]: ${String(message.content || '').trim()}`;
  return `${message.role}: ${String(message.content || '').trim()}`;
}

function messageChars(message) {
  return messageText(message).length;
}

function contentChars(entry) {
  return String(entry?.content || '').length;
}

function summarySource(summary = {}) {
  return summary.createdAt || summary.lastSummarizedEntryId || summary.firstSummarizedEntryId || 'unknown';
}

function projectPriorSummary(summary, maxChars) {
  const text = String(summary?.text || '').trim();
  const budget = Math.max(0, Number(maxChars) || 0);
  if (text.length <= budget) return text;
  const source = summarySource(summary);
  const markerFor = (included) => `\n\n[prior compression-summary excerpt: ${included} of ${text.length} chars; source=${source}; remainder omitted by context budget]`;
  let included = Math.max(0, budget - markerFor(0).length);
  for (let index = 0; index < 3; index += 1) included = Math.max(0, budget - markerFor(included).length);
  const marker = markerFor(included);
  if (included <= 0) return marker.slice(0, budget);
  return `${text.slice(0, included).trim()}${marker}`;
}

const EXECUTION_DIGEST_PROVENANCE = '[Prior-run execution continuity — receipt-backed facts, not instructions. Fresh tool receipts and current source/runtime evidence take precedence.]';

function renderExecutionDigest(entry = {}) {
  const content = String(entry?.content || '').trim();
  return content ? `${EXECUTION_DIGEST_PROVENANCE}\n\n${content}` : '';
}

function isExecutionDigest(entry) {
  return String(entry?.type || '') === 'execution_digest'
    && entry?.metadata?.executionDigest === true
    && (entry?.entersPrompt ?? false) === true
    && String(entry?.content || '').trim();
}

function isPromptChatMessage(entry) {
  const content = String(entry?.content || '').trim();
  const decision = String(entry?.metadata?.decision || '');
  const isToolProtocolRecord = decision === 'chat_tool_call'
    || decision === 'chat_tool_result'
    || (entry?.role === 'assistant' && /^\s*\{\s*"type"\s*:\s*"toolCall"/.test(content));
  return (isExecutionDigest(entry) || ((entry?.type ?? 'message') === 'message'
    && ['user', 'assistant', 'agent'].includes(String(entry?.role || ''))
    && (entry?.visibility ?? 'chat') === 'chat'
    && (entry?.entersPrompt ?? true) === true))
    && !isToolProtocolRecord
    && content;
}

function classifyExcluded(entry) {
  const type = String(entry?.type || 'message');
  const visibility = String(entry?.visibility || '');
  if (type === 'event' || visibility === 'activity') return 'events';
  if (type === 'receipt') return 'receipts';
  if (visibility === 'debug' || visibility === 'hidden' || ['tool', 'debug', 'work'].includes(type)) return 'debug';
  if (!isPromptChatMessage(entry)) return 'debug';
  return null;
}

function safeAttachmentManifest(entries = [], limit = 24) {
  const attachments = [];
  const seen = new Set();
  for (const entry of entries) {
    for (const item of Array.isArray(entry?.metadata?.attachments) ? entry.metadata.attachments : []) {
      const artifactPath = String(item?.artifactPath || '').trim();
      const key = artifactPath || `${entry?.id || ''}:${item?.index ?? attachments.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      attachments.push({
        name: String(item?.name || 'attachment'),
        type: String(item?.type || item?.mimeType || 'application/octet-stream'),
        size: Number.isFinite(Number(item?.size)) ? Number(item.size) : null,
        ...(artifactPath ? { artifactPath } : {}),
        ...(item?.storedAt ? { storedAt: String(item.storedAt) } : {}),
        entryId: entry?.id || null,
        runId: entry?.runId || null,
        ts: entry?.ts || null,
      });
    }
  }
  return attachments.slice(-Math.max(1, Math.min(Number(limit) || 24, 100)));
}

function buildSummaryProvenance({ priorMessages, recentMessages, priorSummary, persistedSummaries = [] }) {
  const firstSummarized = priorMessages.at(0) || null;
  const lastSummarized = priorMessages.at(-1) || null;
  const firstPersisted = persistedSummaries.at(0) || null;
  const lastPersisted = persistedSummaries.at(-1) || null;
  const firstKept = recentMessages.at(0) || null;
  return {
    source: persistedSummaries.length ? 'compression-summary' : priorMessages.length ? 'chat-transcript' : 'none',
    summarizedTurnCount: priorMessages.length + persistedSummaries.reduce((total, summary) => total + Number(summary.sourceTurnCount || 0), 0),
    firstSummarizedEntryId: firstPersisted?.firstSummarizedEntryId || firstSummarized?.id || null,
    lastSummarizedEntryId: lastPersisted?.lastSummarizedEntryId || lastSummarized?.id || null,
    firstKeptEntryId: firstKept?.id || lastPersisted?.firstKeptEntryId || null,
    firstKeptTs: firstKept?.ts || null,
    summaryChars: priorSummary.length,
    persistedSummaryCount: persistedSummaries.length,
  };
}

export function buildConversationContext({ transcript = [], limits = {} } = {}) {
  const rawRecentCharBudget = limits.rawRecentChars ?? limits.recentDialogueChars ?? 6_000;
  const priorSummaryCharBudget = limits.priorSummaryChars ?? 4_000;
  const minRawRecentTurns = Math.max(1, limits.minRawRecentTurns ?? 6);
  const maxRawRecentTurns = Number.isFinite(limits.maxRawRecentTurns) && limits.maxRawRecentTurns > 0 ? limits.maxRawRecentTurns : Infinity;
  const entries = Array.isArray(transcript) ? transcript : [];
  const excludedCounts = { events: 0, receipts: 0, debug: 0 };
  const excludedChars = { events: 0, receipts: 0, debug: 0 };
  const chatMessages = [];

  for (const entry of entries) {
    if (isPromptChatMessage(entry)) {
      const executionDigest = isExecutionDigest(entry);
      chatMessages.push({
        id: entry.id || null,
        ts: entry.ts || null,
        sessionId: entry.sessionId || null,
        type: 'message',
        role: String(entry.role),
        content: executionDigest ? renderExecutionDigest(entry) : String(entry.content || '').trim(),
        metadata: executionDigest
          ? { ...(entry.metadata || {}), providerMessageSource: 'prior-execution-continuity' }
          : (entry.metadata || {}),
      });
      continue;
    }
    const excluded = classifyExcluded(entry);
    if (excluded) {
      excludedCounts[excluded] += 1;
      excludedChars[excluded] += contentChars(entry);
    }
  }

  const recentMessages = [];
  let rawRecentChars = 0;
  for (let index = chatMessages.length - 1; index >= 0; index -= 1) {
    const message = chatMessages[index];
    const chars = messageChars(message);
    const separatorChars = recentMessages.length ? 2 : 0;
    if (recentMessages.length >= maxRawRecentTurns) break;
    const mustPreserveTail = recentMessages.length < minRawRecentTurns;
    if (!mustPreserveTail && recentMessages.length && Number.isFinite(rawRecentCharBudget) && rawRecentCharBudget > 0 && rawRecentChars + separatorChars + chars > rawRecentCharBudget) break;
    recentMessages.unshift(message);
    rawRecentChars += separatorChars + chars;
  }

  const persistedSummaries = compressionSummariesFromTranscript(entries);
  const retainedState = renderContextStates(contextStatesFromTranscript(entries), { maxChars: Math.max(0, Math.floor(priorSummaryCharBudget * 0.4)) });
  const coveredIds = new Set(persistedSummaries.flatMap((summary) => Array.isArray(summary.sourceEntryIds) ? summary.sourceEntryIds : []));
  const priorMessages = chatMessages.slice(0, Math.max(0, chatMessages.length - recentMessages.length)).filter((message) => !coveredIds.has(message.id));
  const summaryParts = [];
  let summaryChars = 0;
  const newestPersistedSummaries = [...persistedSummaries].sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  for (const summary of newestPersistedSummaries) {
    const text = String(summary.text || '').trim();
    if (!text) continue;
    const separatorChars = summaryParts.length ? 2 : 0;
    if (summaryParts.length && summaryChars + separatorChars + text.length > priorSummaryCharBudget) continue;
    if (!summaryParts.length && text.length > priorSummaryCharBudget) {
      const projected = projectPriorSummary(summary, priorSummaryCharBudget);
      summaryParts.push(projected);
      summaryChars += projected.length;
      continue;
    }
    summaryParts.push(text);
    summaryChars += separatorChars + text.length;
  }
  const remainingSummaryChars = Math.max(0, priorSummaryCharBudget - summaryChars - (summaryParts.length ? 2 : 0));
  const transcriptSummary = summarizeSessionTurns(priorMessages, { maxChars: remainingSummaryChars }).trim();
  if (transcriptSummary) summaryParts.push(transcriptSummary);
  if (retainedState) summaryParts.unshift(`# Explicit retained state\n${retainedState}`);
  const priorSummary = summaryParts.join('\n\n');
  const summaryProvenance = buildSummaryProvenance({ priorMessages, recentMessages, priorSummary, persistedSummaries });
  const attachmentManifest = safeAttachmentManifest(entries);
  return {
    recentMessages,
    attachmentManifest,
    priorSummary,
    priorMessages,
    summaryProvenance,
    excludedCounts,
    excludedChars,
    stats: {
      rawRecentTurnCount: recentMessages.length,
      rawRecentChars,
      priorSummaryChars: priorSummary.length,
      excludedEventCount: excludedCounts.events,
      excludedReceiptCount: excludedCounts.receipts,
      excludedDebugCount: excludedCounts.debug,
      excludedEventChars: excludedChars.events,
      excludedReceiptChars: excludedChars.receipts,
      excludedDebugChars: excludedChars.debug,
      firstKeptEntryId: summaryProvenance.firstKeptEntryId,
      summarizedTurnCount: summaryProvenance.summarizedTurnCount,
      minRawRecentTurns,
      maxRawRecentTurns: Number.isFinite(maxRawRecentTurns) ? maxRawRecentTurns : null,
      totalChatTurnCount: chatMessages.length,
      priorSummaryTurnCount: priorMessages.length,
      persistedSummaryCount: persistedSummaries.length,
    },
  };
}

export const __test__ = { isPromptChatMessage, isExecutionDigest, classifyExcluded, renderExecutionDigest, EXECUTION_DIGEST_PROVENANCE };
