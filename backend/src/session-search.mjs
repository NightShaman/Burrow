import { listSessionRecords, readSessionEntries } from './session-store.mjs';
import { compressionSummariesFromTranscript } from './session-compression.mjs';
import { listContinuityHandoffs } from './continuity-handoff-store.mjs';

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
  return String(query || '').toLowerCase().match(/[a-z0-9][a-z0-9._-]*/gu)?.filter((term) => term.length >= 3) || [];
}

function matchesQuery(entry, query) {
  if (!query) return true;
  const haystack = [
    entry.id,
    entry.role,
    entry.type,
    entry.visibility,
    entry.content,
    entry.metadata?.compressionSummary?.text,
  ].map(normalized).join('\n');
  const exact = normalized(query);
  if (haystack.includes(exact)) return true;
  const terms = queryTerms(query);
  return terms.length ? terms.every((term) => haystack.includes(term)) : true;
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
  const terms = queryTerms(query);
  const matchedTerms = terms.filter((term) => content.includes(term)).length;
  const decisionLanguage = /\b(?:decid(?:e|ed|ing)|agreed|require(?:s|d)?|must|should|need(?:s|ed)?|will|won't|do not|don't|keep|remain|stay|real)\b/iu.test(content);
  const incidentalLanguage = /\b(?:fake|mock|dead code|cleanup|remove|removed)\b/iu.test(content);
  const roleWeight = entry.role === 'user' ? 5 : entry.role === 'assistant' ? 4 : entry.role === 'agent' ? 3 : 1;
  return (matchedTerms * 20) + (decisionLanguage ? 30 : 0) + roleWeight - (incidentalLanguage ? 15 : 0);
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
  if (!ts) return true;
  const after = parseTime(since);
  const before = parseTime(until);
  if (after && ts < after) return false;
  if (before && ts > before) return false;
  return true;
}

async function sessionMatchesForAgent({ agent = {}, role = 'any', query = '', limit = 50, includeSummaries = true, since = null, until = null, includeArchived = true } = {}) {
  if (!agent.rootDir) return { matches: [], searchedSessionCount: 0, totalMatches: 0 };
  const records = await listSessionRecords({ rootDir: agent.rootDir, includeArchived, limit: 500 });
  const matches = [];
  let totalMatches = 0;
  for (const record of records) {
    const result = await searchSessionEvidence({ rootDir: agent.rootDir, sessionId: record.id, query, role, includeSummaries, limit: 200, since, until });
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
          store: 'agent_workspace',
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

export async function searchSessionEvidence({ rootDir, sessionId = 'default', query = '', role = 'any', sourceId = null, includeSummaries = true, limit = 50, since = null, until = null } = {}) {
  // Reset snapshots are archive-only human history. Session search may retain
  // compacted predecessors for the active conversation, but never traverses a
  // prior reset generation.
  const transcript = await readSessionEntries({ rootDir, sessionId, limit: 0, includeHistory: true, includeResetHistory: false });
  const max = parseLimit(limit);
  const entries = transcript
    .filter((entry) => includeSummaries || !entry.metadata?.compressionSummary)
    .filter((entry) => matchesRole(entry, role))
    .filter((entry) => matchesSourceId(entry, sourceId))
    .filter((entry) => matchesTime(entry, { since, until }))
    .filter((entry) => matchesQuery(entry, query));
  const results = entries.slice(-max).map((entry) => compactEntry(entry, query));
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
export async function searchAgentSessionEvidence({ rootDir, additionalRootDirs = [], dataRoot = null, agentId = null, sessionId = 'default', query = '', scope = 'agent_sessions', role = 'any', includeSummaries = true, limit = 12 } = {}) {
  // Explicit retrieval may search reset snapshots; ordinary prompt/context never does.
  const normalizedScope = 'agent_sessions';
  const max = parseLimit(limit, 12);
  const roots = [rootDir, ...(Array.isArray(additionalRootDirs) ? additionalRootDirs : [])].filter(Boolean).map(String).filter((item, index, values) => values.indexOf(item) === index);
  const currentSessionId = String(sessionId || 'default');
  const sessionRecords = (await Promise.all(roots.map(async (candidateRoot) => (await listSessionRecords({ rootDir: candidateRoot, includeArchived: true, limit: 500 })).map((record) => ({ rootDir: candidateRoot, sessionId: record.id }))))).flat();
  const orderedSessions = [
    ...roots.map((candidateRoot) => ({ rootDir: candidateRoot, sessionId: currentSessionId })),
    ...sessionRecords.filter((record) => record.sessionId !== currentSessionId),
  ];
  const seenEntries = new Set();
  const seenEvidence = new Set();
  const matches = [];
  for (const candidate of orderedSessions) {
    const transcript = await readSessionEntries({ rootDir: candidate.rootDir, sessionId: candidate.sessionId, limit: 0, includeHistory: true, includeResetHistory: true });
    for (const entry of transcript) {
      const entryKey = `${candidate.rootDir}:${entry.id || `${entry.ts}:${entry.role}:${entry.content}`}`;
      if (seenEntries.has(entryKey) || !recallEligible(entry) || (!includeSummaries && entry.metadata?.compressionSummary) || !matchesRole(entry, role) || !matchesQuery(entry, query)) continue;
      seenEntries.add(entryKey);
      const evidenceKey = normalized(entry.metadata?.compressionSummary?.text || entry.content).replace(/\s+/gu, ' ').trim();
      if (evidenceKey && seenEvidence.has(evidenceKey)) continue;
      if (evidenceKey) seenEvidence.add(evidenceKey);
      matches.push({
        ...compactEntry(entry, query),
        recallScore: recallScore(entry, query),
        source: {
          kind: 'session_transcript',
          sessionId: candidate.sessionId,
          currentSession: candidate.sessionId === currentSessionId,
          resetArchive: Boolean(entry.metadata?.resetArchive),
          store: candidate.rootDir === rootDir ? 'workspace' : 'agent_data',
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
  const activeAgentId = String(agentId || '').trim();
  const handoffs = activeAgentId && dataRoot
    ? listContinuityHandoffs({ dataRoot, agentId: activeAgentId, limit: 5 })
    : [];
  const handoffMatches = handoffs
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
      source: { kind: 'session_handoff', sessionId: handoff.sessionId, currentSession: handoff.sessionId === currentSessionId, store: 'agent_data' },
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

export async function searchBurrowSessionEvidence({ agents = [], query = '', role = 'any', limit = 50, includeSummaries = true, since = null, until = null, includeArchived = true } = {}) {
  const max = parseLimit(limit);
  const normalizedAgents = (Array.isArray(agents) ? agents : [])
    .filter((agent) => agent?.rootDir)
    .map((agent) => ({ ...agent, agentId: String(agent.agentId || agent.id || '').trim() || null }));
  const perAgent = await Promise.all(normalizedAgents.map((agent) => sessionMatchesForAgent({ agent, query, role, limit: max, includeSummaries, since, until, includeArchived })));
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
