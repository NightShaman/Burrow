import { readSessionEntries, rotateCompactedTranscript, summarizeSessionTurns } from './session-store.mjs';
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
  const first = sourceMessages.at(0);
  const last = sourceMessages.at(-1);
  return {
    kind: 'context-compression-summary',
    version: 1,
    sessionId: String(sessionId || 'default'),
    createdAt: clock(),
    source: 'deterministic-summary',
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
  const users = source.filter((message) => isPromptChatMessage(message) && message.role === 'user');
  const assistants = source.filter((message) => isPromptChatMessage(message) && ['assistant', 'agent'].includes(message.role));
  const latestUser = users.at(-1);
  const priorUser = users.slice(0, -1).at(-1);
  const latestAssistant = assistants.at(-1);
  const render = (message) => message ? compressionEntryText(message) : 'None recorded.';
  const preservedStates = Array.isArray(retainedStates) ? retainedStates : contextStatesFromTranscript(messages);
  // Prose is not classified later by keyword folklore. Outside the fresh tail,
  // only explicit typed state survives as structured context; older prose is
  // summarized as non-authoritative context.
  const retainedState = preservedStates.length
    ? `${preservedStates.length} explicit lifecycle-managed record${preservedStates.length === 1 ? '' : 's'} remain active; current prompt context renders them separately.`
    : 'None recorded.';
  const executionEvidence = source.filter(isExecutionDigest).map(render).join('\n') || 'None recorded.';
  const text = [
    '# Compacted Conversation Handoff',
    '',
    'This is older conversational context, not verified evidence. The current user request overrides it.',
    '',
    '## Latest unresolved user ask',
    render(latestUser),
    '',
    '## Goal and constraints',
    priorUser ? render(priorUser) : 'Infer only from the retained conversation; no separate runtime authority is implied.',
    '',
    '## Completed actions and active state',
    render(latestAssistant),
    '',
    '## Explicit retained state',
    retainedState,
    '',
    '## Canonical execution evidence',
    executionEvidence,
  ].join('\n');
  if (text.length <= maxChars) return text;
  const marker = '\n\n[older compacted context truncated]';
  return `${text.slice(0, Math.max(0, maxChars - marker.length)).trim()}${marker}`;
}

function mergedSummaryExcerpt(label, value, budget) {
  const source = String(value || '').trim();
  if (!source) return '';
  if (source.length <= budget) return `${label}:\n${source}`;
  const markerFor = (included) => `\n[${label.toLowerCase()} excerpt: ${included} of ${source.length} chars; condensed during summary merge]`;
  let included = Math.max(0, budget - label.length - 2 - markerFor(0).length);
  for (let index = 0; index < 3; index += 1) included = Math.max(0, budget - label.length - 2 - markerFor(included).length);
  return `${label}:\n${source.slice(0, included).trim()}${markerFor(included)}`;
}

export function mergeCompressionSummaries({ previousSummary = '', nextSummary = '', maxChars = 6000 } = {}) {
  const prior = String(previousSummary || '').trim();
  const next = String(nextSummary || '').trim();
  if (!prior) return next;
  if (!next) return prior;
  const header = '# Re-condensed Conversation Handoff\nEarlier and newer summaries were deliberately merged; this is context, not verified evidence.\n\n';
  const available = Math.max(0, Number(maxChars) || 0) - header.length - 2;
  const priorBudget = Math.floor(available / 2);
  const nextBudget = available - priorBudget;
  return `${header}${mergedSummaryExcerpt('Prior summary', prior, priorBudget)}\n\n${mergedSummaryExcerpt('Newer summary', next, nextBudget)}`;
}

function tokenTargetToCharBudget(tokens, fallback = 6000) {
  const number = Number(tokens);
  return Number.isFinite(number) && number > 0 ? Math.ceil(number * 4) : fallback;
}

export async function appendCompressionSummary({ rootDir, sessionId = 'default', transcript = [], plan, text = null, maxChars = 6000 } = {}) {
  const previousSummary = compressionSummariesFromTranscript(transcript).at(-1)?.text || '';
  const sourceMessages = (plan.sourceEntryIds || []).length
    ? transcript.filter((entry) => (plan.sourceEntryIds || []).includes(entry?.id) && isCompressionEntry(entry))
    : [];
  const combinedText = text ?? structuredCompressionSummary(sourceMessages, { maxChars, retainedStates: contextStatesFromTranscript(transcript) });
  const mergedText = mergeCompressionSummaries({ previousSummary, nextSummary: combinedText, maxChars });
  const summary = buildCompressionSummaryRecord({ sessionId, transcript, plan, text: mergedText, maxChars });
  // Semantic compaction creates a compact successor transcript. The prior
  // transcript remains an auditable artifact, but is no longer normal prompt
  // context or normal history-read input.
  const sourceIds = new Set(plan.sourceEntryIds || []);
  // Canonical execution facts are durable history, not disposable prompt tail.
  // They remain in the active transcript even when their surrounding chat is
  // summarized for provider context.
  const tailEntries = transcript.filter((entry) => String(entry?.type || '') === 'context_state' || isCanonicalExecutionEntry(entry) || !sourceIds.has(entry?.id));
  const rotation = await rotateCompactedTranscript({ rootDir, sessionId, summary, tailEntries });
  return { entry: rotation.summaryEntry, summary, rotation };
}

export async function runSessionCompression({ rootDir, sessionId = 'default', config = {}, contextBudget = null, maxChars = null, logger = null } = {}) {
  const transcript = await readSessionEntries({ rootDir, sessionId, limit: 0 });
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
  const { entry, summary, rotation } = await appendCompressionSummary({ rootDir, sessionId, transcript, plan, maxChars: maxChars ?? tokenTargetToCharBudget(config.summaryTargetTokens, 6000) });
  const completed = { ...result, compressed: true, entryId: entry.id, summary, rotation: { archiveName: rotation.archiveName, retainedCount: rotation.retainedCount } };
  await logger?.event?.('context-compression', { compressed: true, entryId: entry.id, summary: { ...summary, text: undefined } });
  return completed;
}

export const __test__ = { isPromptChatMessage, structuredCompressionSummary };
