import { conversationAuthority } from './conversation-authority.mjs';
import { compressionSummariesFromTranscript } from './session-compression.mjs';

// PostgreSQL owns both live entries and archive evidence when injected. Never
// supplement an empty/failed authority read from workspace JSONL exports.
export async function evidenceTranscript({ conversationStore, agentId, rootDir, sessionId, includeResetHistory = false }) {
  if (!conversationStore) throw new Error('conversation_store_required');
  const authority = conversationAuthority({ store: conversationStore, agentId });
  const [active, archives, metadata] = await Promise.all([
    authority.entriesAll(sessionId),
    conversationStore.listArchives({ agentId, sessionId, limit: null }),
    authority.metadata(sessionId),
  ]);
  const resetGeneration = Math.max(-1, ...archives.filter((archive) => archive.kind === 'reset').map((archive) => Number(archive.generation)));
  const seen = new Set(active.map((entry) => entry.id).filter(Boolean));
  const history = [];
  for (const archive of [...archives].sort((a, b) => Number(b.generation) - Number(a.generation))) {
    const resetArchive = archive.kind === 'reset' || Number(archive.generation) <= resetGeneration
      || Boolean(metadata?.resetAt && archive.createdAt <= metadata.resetAt);
    if (resetArchive && !includeResetHistory) continue;
    for (const entry of [...(archive.entries || [])].reverse()) {
      if (entry.id && seen.has(entry.id)) continue;
      if (entry.id) seen.add(entry.id);
      history.push({ ...entry, metadata: { ...entry.metadata, resetArchive } });
    }
  }
  return [...history.reverse(), ...active].sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
}

async function evidenceSessions({ conversationStore, agentId, rootDir, includeArchived = true }) {
  if (!conversationStore) throw new Error('conversation_store_required');
  return (await conversationStore.listSessions({ agentId, includeArchived })).map((record) => ({ ...record, id: record.sessionId }));
}

function normalized(value) {
  return String(value ?? '').toLowerCase();
}

function snippet(text = '', query = '', { maxChars = 240 } = {}) {
  const source = String(text || '');
  if (!source) return '';
  const q = String(query || '').trim();
  const index = q ? source.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (source.length <= maxChars) return source;
  const start = index >= 0 ? Math.max(0, index - Math.floor(maxChars / 3)) : 0;
  const end = Math.min(source.length, start + maxChars);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < source.length ? '…' : '';
  return `${prefix}${source.slice(start, end).trim()}${suffix}`;
}

function parseLimit(value, fallback = 50) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, 200) : fallback;
}

function queryTerms(query) {
  return [...new Set(String(query || '').toLowerCase().match(/[a-z0-9][a-z0-9._-]*/gu)?.filter((term) => term.length >= 3) || [])];
}

function queryMatch(entry, query) {
  if (!query) return { matches: true, score: 0 };
  const haystack = [
    entry.id,
    entry.role,
    entry.type,
    entry.visibility,
    entry.content,
    entry.metadata?.compressionSummary?.text,
  ].map(normalized).join('\n');
  const exact = normalized(query).trim();
  if (exact && haystack.includes(exact)) return { matches: true, score: 1000 };
  const terms = queryTerms(query);
  if (!terms.length) return { matches: true, score: 0 };
  const positions = terms.map((term) => haystack.indexOf(term));
  const matchedPositions = positions.filter((position) => position >= 0);
  const matchedCount = matchedPositions.length;
  const minimumCoverage = terms.length === 1 ? 1 : 2;
  if (matchedCount < minimumCoverage) return { matches: false, score: 0 };
  const allTerms = matchedCount === terms.length;
  const coverage = matchedCount / terms.length;
  const span = matchedCount > 1 ? Math.max(...matchedPositions) - Math.min(...matchedPositions) : Number.POSITIVE_INFINITY;
  const proximity = Number.isFinite(span) ? Math.max(0, 100 - Math.floor(span / 8)) : 0;
  return {
    matches: true,
    score: (allTerms ? 700 : 0) + Math.round(coverage * 400) + (matchedCount * 20) + proximity,
  };
}

export function matchesQuery(entry, query) {
  return queryMatch(entry, query).matches;
}

function recallEligible(entry) {
  if (/\b(?:no (?:recorded|prior-session) (?:decision|evidence)|available prior-session history)\b/iu.test(String(entry?.content || ''))) return false;
  return Boolean(entry.metadata?.compressionSummary) || ((entry?.type ?? 'message') === 'message'
    && ['user', 'assistant', 'agent'].includes(String(entry?.role || ''))
    && (entry?.visibility ?? 'chat') === 'chat'
    && (entry?.entersPrompt ?? true) === true);
}

function recallScore(entry, query) {
  const content = normalized(entry.metadata?.compressionSummary?.text || entry.content);
  const decisionLanguage = /\b(?:decid(?:e|ed|ing)|agreed|require(?:s|d)?|must|should|need(?:s|ed)?|will|won't|do not|don't|keep|remain|stay|real)\b/iu.test(content);
  const incidentalLanguage = /\b(?:fake|mock|dead code|cleanup|remove|removed)\b/iu.test(content);
  const roleWeight = entry.role === 'user' ? 5 : entry.role === 'assistant' ? 4 : entry.role === 'agent' ? 3 : 1;
  return queryMatch(entry, query).score + (decisionLanguage ? 30 : 0) + roleWeight - (incidentalLanguage ? 15 : 0);
}

function matchesRole(entry, role) {
  if (!role || role === 'any') return true;
  if (role === 'summary') return Boolean(entry.metadata?.compressionSummary);
  return String(entry.role || '') === role;
}

function matchesSourceId(entry, sourceId) {
  if (!sourceId) return true;
  if (entry.id === sourceId) return true;
  const ids = entry.metadata?.compressionSummary?.sourceEntryIds;
  return Array.isArray(ids) && ids.includes(sourceId);
}

function compactEntry(entry, query) {
  const summary = entry.metadata?.compressionSummary || null;
  return {
    id: entry.id,
    ts: entry.ts,
    sessionId: entry.sessionId,
    type: entry.type,
    role: entry.role,
    visibility: entry.visibility,
    entersPrompt: entry.entersPrompt,
    runId: entry.runId || null,
    traceDir: entry.traceDir || null,
    contentSnippet: snippet(entry.content || summary?.text || '', query),
    compressionSummary: summary ? {
      kind: summary.kind,
      version: summary.version,
      createdAt: summary.createdAt,
      source: summary.source,
      sourceTurnCount: summary.sourceTurnCount,
      firstSummarizedEntryId: summary.firstSummarizedEntryId,
      lastSummarizedEntryId: summary.lastSummarizedEntryId,
      firstKeptEntryId: summary.firstKeptEntryId,
      latestEntryId: summary.latestEntryId,
      sourceEntryIds: Array.isArray(summary.sourceEntryIds) ? summary.sourceEntryIds : [],
      textSnippet: snippet(summary.text || '', query),
    } : null,
  };
}

function parseTime(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const time = Date.parse(text);
  return Number.isNaN(time) ? null : time;
}

function matchesTime(entry, { since = null, until = null } = {}) {
  const ts = parseTime(entry?.ts);
  if (ts === null) return !since && !until;
  const after = parseTime(since);
  const before = parseTime(until);
  if (after !== null && ts < after) return false;
  if (before !== null && ts > before) return false;
  return true;
}

async function sessionMatchesForAgent({ conversationStore = null, agent = {}, role = 'any', query = '', limit = 50, includeSummaries = true, since = null, until = null, includeArchived = true } = {}) {
  if (!conversationStore) throw new Error('conversation_store_required');
  const records = await evidenceSessions({ conversationStore, agentId: agent.agentId, rootDir: agent.rootDir, includeArchived });
  const matches = [];
  let totalMatches = 0;
  for (const record of records) {
    const result = await searchSessionEvidence({ conversationStore, agentId: agent.agentId, rootDir: agent.rootDir, sessionId: record.id, query, role, includeSummaries, limit: 200, since, until });
    totalMatches += result.totalMatches || 0;
    for (const entry of result.results) {
      matches.push({
        ...entry,
        agentId: agent.agentId || null,
        agentName: agent.agentName || agent.name || agent.agentId || null,
        archived: Boolean(record.archived),
        source: {
          kind: entry.compressionSummary ? 'compression_summary' : 'session_transcript',
          agentId: agent.agentId || null,
          agentName: agent.agentName || agent.name || agent.agentId || null,
          sessionId: record.id,
          currentSession: false,
          store: 'postgres',
        },
      });
    }
  }
  matches.sort((left, right) => {
    const relevance = recallScore(right, query) - recallScore(left, query);
    return relevance || String(right.ts || '').localeCompare(String(left.ts || ''));
  });
  return { matches: matches.slice(0, parseLimit(limit)), searchedSessionCount: records.length, totalMatches };
}

async function indexedEvidenceTranscript({ conversationStore, agentId, sessionId, query, includeResetHistory = false }) {
  const candidates = []; let after = null;
  // Candidate pages bound payload transfer, without imposing a ranking cutoff.
  // Summary source-ID reports remain complete even when a query excludes them.
  do {
    const page = await conversationStore.searchEvidencePage({ agentId, sessionId, query, includeResetHistory, after });
    candidates.push(...page.rows); after = page.next;
  } while (after);
  candidates.sort((a,b) => a.source_store === b.source_store
    ? Number(a.generation || 0)-Number(b.generation || 0) || Number(a.ordinal)-Number(b.ordinal)
    : a.source_store === 'live' ? 1 : -1);
  const seen = new Set(); const entries = [];
  for (const row of candidates.reverse()) {
    const entry = row.entry;
    if (entry.id && seen.has(entry.id)) continue;
    if (entry.id) seen.add(entry.id);
    entries.push(row.source_store === 'live' ? entry : { ...entry, metadata: { ...entry.metadata, resetArchive: Boolean(row.reset_archive) } });
  }
  return entries.reverse().sort((a,b) => String(a.ts || '').localeCompare(String(b.ts || '')));
}

export async function searchSessionEvidence({ conversationStore = null, agentId = null, rootDir, sessionId = 'default', query = '', role = 'any', sourceId = null, includeSummaries = true, limit = 50, since = null, until = null } = {}) {
  // Reset snapshots are archive-only human history. Session search may retain
  // compacted predecessors for the active conversation, but never traverses a
  // prior reset generation.
  const transcript = typeof conversationStore?.searchEvidencePage === 'function'
    ? await indexedEvidenceTranscript({ conversationStore, agentId, sessionId, query })
    : await evidenceTranscript({ conversationStore, agentId, rootDir, sessionId, includeResetHistory: false });
  const max = parseLimit(limit);
  const entries = transcript
    .filter((entry) => includeSummaries || !entry.metadata?.compressionSummary)
    .filter((entry) => matchesRole(entry, role))
    .filter((entry) => matchesSourceId(entry, sourceId))
    .filter((entry) => matchesTime(entry, { since, until }))
    .filter((entry) => matchesQuery(entry, query));
  const rankedEntries = query
    ? [...entries].sort((left, right) => recallScore(right, query) - recallScore(left, query) || String(right.ts || '').localeCompare(String(left.ts || '')))
    : entries;
  const selectedEntries = query ? rankedEntries.slice(0, max) : rankedEntries.slice(-max);
  const results = selectedEntries.map((entry) => compactEntry(entry, query));
  const summaries = compressionSummariesFromTranscript(transcript);
  return {
    ok: true,
    sessionId,
    query: query || null,
    role,
    sourceId: sourceId || null,
    since: since || null,
    until: until || null,
    count: results.length,
    totalMatches: entries.length,
    results,
    compression: {
      summaryCount: summaries.length,
      coveredSourceEntryIds: [...new Set(summaries.flatMap((summary) => Array.isArray(summary.sourceEntryIds) ? summary.sourceEntryIds : []))],
    },
  };
}

/**
 * Read-only, lossless historical recall for one agent's own session store.
 * Callers cannot select an arbitrary agent data root. Reset snapshots remain
 * outside automatic prompt/context construction, but this explicit tool may
 * retrieve them with reset-archive provenance.
 */
export async function searchAgentSessionEvidence({ conversationStore = null, continuityStore = null, rootDir, additionalRootDirs = [], dataRoot = null, agentId = null, sessionId = 'default', query = '', scope = 'agent_sessions', role = 'any', includeSummaries = false, limit = 12, since = null, until = null, sourceId = null, sourceSessionId = null, neighborCount = 1 } = {}) {
  // Explicit retrieval may search reset snapshots; ordinary prompt/context never does.
  const normalizedScope = 'agent_sessions';
  const max = parseLimit(limit, 12);
  if (!conversationStore) throw new Error('conversation_store_required');
  const roots = [null];
  const currentSessionId = String(sessionId || 'default');
  const sessionRecords = (await Promise.all(roots.map(async (candidateRoot) => (await evidenceSessions({ conversationStore, agentId, rootDir: candidateRoot, includeArchived: true })).map((record) => ({ rootDir: candidateRoot, sessionId: record.id }))))).flat();
  const orderedSessions = [
    ...roots.map((candidateRoot) => ({ rootDir: candidateRoot, sessionId: currentSessionId })),
    ...sessionRecords.filter((record) => record.sessionId !== currentSessionId),
  ];
  const seenEntries = new Set();
  const matches = [];
  for (const candidate of orderedSessions) {
    if (sourceSessionId && candidate.sessionId !== sourceSessionId) continue;
    const transcript = typeof conversationStore?.searchEvidencePage === 'function'
      ? await indexedEvidenceTranscript({ conversationStore, agentId, sessionId: candidate.sessionId, query: sourceId ? '' : query, includeResetHistory: true })
      : await evidenceTranscript({ conversationStore, agentId, rootDir: candidate.rootDir, sessionId: candidate.sessionId, includeResetHistory: true });
    for (const entry of transcript) {
      const entryKey = JSON.stringify([candidate.rootDir, candidate.sessionId, entry.id || [entry.ts, entry.role, entry.content]]);
      if (seenEntries.has(entryKey) || !recallEligible(entry) || (!includeSummaries && entry.metadata?.compressionSummary) || !matchesRole(entry, role) || !matchesTime(entry, { since, until }) || (sourceId ? entry.id !== sourceId : !matchesQuery(entry, query))) continue;
      seenEntries.add(entryKey);

      matches.push({
        ...compactEntry(entry, query),
        original: sourceId ? entry : undefined,
        sourceRef: { kind: 'conversation_entry', agentId, sessionId: candidate.sessionId, entryId: entry.id },
        expandable: Boolean(entry.id),
        recallScore: recallScore(entry, query),
        source: {
          kind: 'session_transcript',
          sessionId: candidate.sessionId,
          currentSession: candidate.sessionId === currentSessionId,
          resetArchive: Boolean(entry.metadata?.resetArchive),
          store: 'postgres',
        },
      });
    }
  }
  matches.sort((left, right) => {
    const relevance = Number(right.recallScore || 0) - Number(left.recallScore || 0);
    if (relevance) return relevance;
    const current = Number(Boolean(right.source.currentSession)) - Number(Boolean(left.source.currentSession));
    return current || String(right.ts || '').localeCompare(String(left.ts || ''));
  });
  // Neighbors are original dialogue, not search candidates. Resolve only the
  // selected sessions so query pruning cannot turn distant matches into neighbors.
  const neighborTranscripts = new Map();
  for (const match of matches.slice(0, max)) {
    const sid = match.source.sessionId;
    if (!neighborTranscripts.has(sid)) neighborTranscripts.set(sid,
      (await evidenceTranscript({ conversationStore, agentId, sessionId: sid, includeResetHistory: true }))
        .filter(entry => recallEligible(entry) && !entry.metadata?.compressionSummary));
    const dialogue = neighborTranscripts.get(sid);
    const index = dialogue.findIndex(entry => entry.id === match.id);
    const radius = Math.min(3, Math.max(0, Number(neighborCount) || 0));
    match.neighbors = index < 0 ? [] : dialogue.slice(Math.max(0, index - radius), index + radius + 1)
      .filter(entry => entry.id !== match.id).map(entry => ({ ...compactEntry(entry, ''),
        sourceRef: { kind: 'conversation_entry', agentId, sessionId: sid, entryId: entry.id },
        resetArchive: Boolean(entry.metadata?.resetArchive) }));
  }
  const activeAgentId = String(agentId || '').trim();
  const handoffs = !sourceId && activeAgentId && continuityStore
    ? await continuityStore.list({ agentId: activeAgentId, limit: 5 })
    : [];
  const handoffMatches = handoffs
    .filter((handoff) => matchesTime({ ts: handoff.updatedAt }, { since, until }))
    .filter((handoff) => matchesQuery({ id: handoff.id, type: 'handoff', content: `${handoff.title}\n${handoff.content}\n${handoff.evidenceSummary}` }, query))
    .map((handoff) => ({
      id: handoff.id,
      ts: handoff.updatedAt,
      sessionId: handoff.sessionId,
      type: 'handoff',
      role: 'system',
      visibility: 'local',
      entersPrompt: false,
      contentSnippet: snippet(handoff.content, query),
      handoff: { title: handoff.title, sourceRefs: handoff.sourceRefs, evidenceSummary: handoff.evidenceSummary, expiresAt: handoff.expiresAt },
      source: { kind: 'session_handoff', sessionId: handoff.sessionId, currentSession: handoff.sessionId === currentSessionId, store: 'postgres' },
      recallScore: 45 + (handoff.sessionId === currentSessionId ? 5 : 0),
    }));
  const allMatches = [...matches, ...handoffMatches];
  allMatches.sort((left, right) => {
    const relevance = Number(right.recallScore || 0) - Number(left.recallScore || 0);
    if (relevance) return relevance;
    const current = Number(Boolean(right.source.currentSession)) - Number(Boolean(left.source.currentSession));
    return current || String(right.ts || '').localeCompare(String(left.ts || ''));
  });
  const results = allMatches.slice(0, max).map(({ recallScore: _recallScore, ...entry }) => entry);
  return {
    ok: true,
    tool: 'session_search',
    query: query || null,
    scope: normalizedScope,
    sessionId: currentSessionId,
    searchedSessionCount: orderedSessions.length,
    count: results.length,
    totalMatches: allMatches.length,
    results,
  };
}

export async function searchBurrowSessionEvidence({ conversationStore = null, agents = [], query = '', role = 'any', limit = 50, includeSummaries = true, since = null, until = null, includeArchived = true } = {}) {
  if (!conversationStore) throw new Error('conversation_store_required');
  const max = parseLimit(limit);
  const normalizedAgents = (Array.isArray(agents) ? agents : [])
    .filter((agent) => agent && (conversationStore || agent.rootDir))
    .map((agent) => ({ ...agent, agentId: String(agent.agentId || agent.id || '').trim() || null }));
  const perAgent = await Promise.all(normalizedAgents.map((agent) => sessionMatchesForAgent({ conversationStore, agent, query, role, limit: max, includeSummaries, since, until, includeArchived })));
  const matches = perAgent.flatMap((result) => result.matches);
  matches.sort((left, right) => {
    const relevance = recallScore(right, query) - recallScore(left, query);
    return relevance || String(right.ts || '').localeCompare(String(left.ts || ''));
  });
  const results = matches.slice(0, max);
  return {
    ok: true,
    tool: 'operator_session_search',
    operatorSearch: true,
    entersPrompt: false,
    query: query || null,
    scope: 'burrow',
    role,
    since: since || null,
    until: until || null,
    agentCount: normalizedAgents.length,
    searchedSessionCount: perAgent.reduce((sum, result) => sum + Number(result.searchedSessionCount || 0), 0),
    count: results.length,
    totalMatches: perAgent.reduce((sum, result) => sum + Number(result.totalMatches || 0), 0),
    results,
  };
}

export const __test__ = { snippet, matchesTime };
