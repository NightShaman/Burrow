// Pure transcript projections; core persistence belongs to PostgresSessionStore.
import { randomUUID } from 'node:crypto';
import { boundedRedactedValue, redactAndTruncateText, truncateText } from './redaction.mjs';
function safeId(value) {
  return String(value || '').trim().replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || randomUUID();
}

function nowIso() { return new Date().toISOString(); }

function defaultVisibility({ type, role }) {
  if (type === 'message' && ['user', 'assistant', 'agent'].includes(String(role || ''))) return 'chat';
  return type === 'event' ? 'activity' : 'debug';
}
function defaultEntersPrompt({ type, role, visibility }) {
  return type === 'message' && ['user', 'assistant', 'agent'].includes(String(role || '')) && visibility === 'chat';
}
function redactedMetadata(metadata) {
  return boundedRedactedValue(metadata || {});
}

function retainedChatMetadata(metadata = {}) {
  // Successor transcripts preserve conversational provenance, not bulky
  // finalizer/debug receipts from the archived generation.
  const projected = {};
  for (const key of ['attachments', 'decision', 'canonicalExecution', 'executionDigest', 'toolResultCount', 'iteration', 'tool', 'callId', 'ok', 'toolCalls', 'normalizedResult', 'subjectScope', 'fromAgentId', 'fromAgentName', 'toAgentId', 'messageMode', 'sourceSessionId', 'targetSessionId', 'contextState']) {
    if (metadata?.[key] !== undefined) projected[key] = metadata[key];
  }
  return redactedMetadata(projected);
}
export function normalizeTranscriptEntry(entry = {}, { sessionId = null } = {}) {
  const type = entry.type || 'message';
  const role = entry.role ?? null;
  const visibility = entry.visibility || defaultVisibility({ type, role });
  return {
    id: entry.id || randomUUID(), parentId: entry.parentId ?? null, ts: entry.ts || nowIso(),
    sessionId: safeId(entry.sessionId || sessionId), type, role, content: entry.content ?? '',
    contentTruncated: Boolean(entry.contentTruncated), runId: entry.runId ?? null, traceDir: entry.traceDir ?? null,
    visibility, entersPrompt: entry.entersPrompt ?? defaultEntersPrompt({ type, role, visibility }),
    metadata: redactedMetadata(entry.metadata || {}),
  };
}
function isChatMessage(entry) {
  return entry?.type === 'message' && ['user', 'assistant', 'agent'].includes(String(entry?.role || ''))
    && entry?.visibility === 'chat' && entry?.entersPrompt === true
    && Boolean(String(entry?.content || '').trim() || (Array.isArray(entry?.metadata?.attachments) && entry.metadata.attachments.length));
}

function normalizedArchiveTitleText(value = '') { return String(value || '').replace(/[`*_#[\]()>|]/g, ' ').replace(/\s+/g, ' ').trim(); }
function lowInformationArchiveTitle(value = '') {
  const text = normalizedArchiveTitleText(value).toLowerCase();
  return !text || text.length < 3 || /^(?:ok(ay)?|cool|nice|great|awesome|yep|yeah|yes|no|thanks?|thank you|hi|hello|hey|yo|sup|good (?:morning|afternoon|evening)|howdy|what'?s up|gm|morning|afternoon|evening)(?:[!?.\s]|there\b)*$/iu.test(text);
}
function titleCaseArchiveText(value = '') {
  const small = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'on', 'or', 'the', 'to', 'vs', 'with']);
  return normalizedArchiveTitleText(value).split(/\s+/).map((word, index) => {
    const lower = word.toLowerCase();
    if (index && small.has(lower)) return lower;
    if (/^[A-Z0-9_./-]{2,}$/.test(word)) return word;
    return `${lower.charAt(0).toUpperCase()}${lower.slice(1)}`;
  }).join(' ');
}
export function deriveArchiveTitle(turns = [], { fallback = 'Untitled conversation' } = {}) {
  const users = (turns || []).filter((turn) => turn?.role === 'user' && String(turn.content || '').trim());
  const candidate = users.find((turn) => !lowInformationArchiveTitle(turn.content)) || users[0];
  if (!candidate) return fallback;
  let title = normalizedArchiveTitleText(candidate.content).replace(/^(ok(ay)?|so|hey|yo|alright|well)[,\s]+/i, '').trim();
  title = title.match(/^(.{12,120}?[.!?])\s/)?.[1] || title.split('\n')[0] || title;
  if (title.length > 80) title = `${title.slice(0, 80).replace(/\s+\S*$/, '').trim()}…`;
  return title.length >= 3 ? titleCaseArchiveText(title) : fallback;
}

function isCanonicalExecutionEntry(entry) {
  return ['tool_call', 'tool_result'].includes(String(entry?.type || ''))
    && entry?.metadata?.canonicalExecution === true
    && String(entry?.content || '').trim();
}

function isExecutionDigestEntry(entry) {
  return String(entry?.type || '') === 'execution_digest'
    && entry?.metadata?.executionDigest === true
    && entry?.entersPrompt === true
    && String(entry?.content || '').trim();
}
function isCompactionTailEntry(entry) {
  return String(entry?.type || '') === 'context_state' || isChatMessage(entry) || isExecutionDigestEntry(entry) || isCanonicalExecutionEntry(entry);
}

export function buildSessionEntry({ sessionId, type = 'message', role = null, content, runId = null, traceDir = null, metadata = {}, visibility = null, entersPrompt = undefined, parentId = null, clock = nowIso, maxContentChars } = {}) {
  if (!sessionId) throw new Error('sessionId is required');
  if (type === 'message' && !role) throw new Error('role is required for message entries');
  const resolvedSessionId = safeId(sessionId);
  // Chat messages are durable conversation and must survive intact. Keep the
  // existing bounded default for diagnostic receipts/events/tools; callers may
  // still opt into a narrower or wider diagnostic envelope explicitly.
  const resolvedMaxContentChars = maxContentChars ?? (type === 'message' ? Infinity : 20_000);
  const contentEnvelope = type === 'message'
    ? truncateText(content || '', { maxChars: resolvedMaxContentChars })
    : redactAndTruncateText(content || '', { maxChars: resolvedMaxContentChars });
  const resolvedVisibility = visibility || defaultVisibility({ type, role });
  const entry = normalizeTranscriptEntry({
    id: randomUUID(), parentId, ts: clock(), sessionId: resolvedSessionId, type: String(type),
    role: role === null || role === undefined ? null : String(role), content: contentEnvelope.text,
    contentTruncated: contentEnvelope.truncated, runId, traceDir, visibility: resolvedVisibility,
    entersPrompt: entersPrompt ?? defaultEntersPrompt({ type, role, visibility: resolvedVisibility }), metadata,
  }, { sessionId: resolvedSessionId });
  return entry;
}


export function projectPendingActions(entries = []) {
  return entries.flatMap((entry) => {
    const pending = [entry?.metadata?.pendingAction, ...(entry?.metadata?.pendingActions || [])].filter(Boolean);
    return pending.map((action) => ({ ...action, turnId: entry.id || null, role: entry.role || null }));
  });
}

export function summarizeSessionTurns(turns = [], { maxChars = 4000 } = {}) {
  const rendered = (turns || []).map((turn) => turn.role === 'agent'
    ? `[Agent message from ${turn.metadata?.fromAgentName || turn.metadata?.fromAgentId || 'another agent'}]: ${turn.content}`
    : `${turn.role}: ${turn.content}`).join('\n\n').trim();
  if (!rendered || !Number.isFinite(maxChars) || rendered.length <= maxChars) return rendered;
  const markerFor = (omitted) => `\n\n[truncated ${omitted} chars from earlier session turns]`;
  let retainedChars = Math.max(0, maxChars - markerFor(0).length);
  let retained = rendered.slice(Math.max(0, rendered.length - retainedChars)).trim();
  for (let index = 0; index < 3; index += 1) {
    const marker = markerFor(rendered.length - retained.length);
    retainedChars = Math.max(0, maxChars - marker.length);
    retained = rendered.slice(Math.max(0, rendered.length - retainedChars)).trim();
  }
  return `${retained}${markerFor(rendered.length - retained.length)}`;
}

// Compatibility entry point for callers that update durable session state. It
// deliberately never rebuilds metadata by replaying the transcript.

export { isChatMessage, retainedChatMetadata, isCompactionTailEntry };
