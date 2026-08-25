import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import { api, textFromChatValue, type SessionTurn } from '../../app/api';
import type { ArchiveRunDetail, ArchiveRunListResponse, ArchiveRunResponse } from '../../app/api';
import type { Agent } from '../../app/types';
import { ArchiveRunsProof } from './ArchiveRunsProof';

type ArchiveKind = 'chat' | 'dreams' | 'tiddle' | 'proof';
type ContinuityCard = { id: string; kind: 'continuity'; agentId: string; agentName: string; project?: string; title: string; summary: string; firstSeen: string; lastSeen: string; recurrence: number; recentRefs?: string[]; evidence?: string; reason?: string; expiresAt?: string };
type ContinuityHistoryEntry = { id: string; at: string; runId?: string; agentId: string; scope: string | null; disposition: string; cardId?: string | null; recurrenceBefore?: number; recurrenceAfter?: number; titleBefore?: string | null; titleAfter?: string | null; summaryBefore?: string | null; summaryAfter?: string | null; reason: string; };
type ArchiveSession = { agentId: string | null; agentName: string | null; sessionId: string; id: string; title: string; summary: string; turnCount: number; chatTurnCount: number | null; createdAt: string | null; updatedAt: string | null; archived: boolean; archivedAt: string | null; kind: string | null; lastRole: string | null; lastRunId: string | null; archiveSnapshot?: 'reset' | string | null; sourceSessionId?: string | null };
type ArchiveDetail = { turns?: SessionTurn[]; chatTurns?: SessionTurn[]; session?: { turns?: SessionTurn[] } };
type DreamEntry = { id: string; agentId: string; agentName: string; entryDate: string; phase: string; narrative: unknown; sourceRefs: string[]; createdAt: string };
type DreamDiaryResponse = { entries?: Omit<DreamEntry, 'agentId' | 'agentName'>[]; markdown?: string };
type ArchiveDream = { id: string; kind: 'dream'; agentId: string; agentName: string; entryDate: string; phase: string; title: string; excerpt: string; createdAt: string };
type ArchiveDreamDocument = { document: { id: string; kind: 'dream'; agentId: string; agentName: string; title: string; subtitle: string; phase: string; markdown: string; createdAt: string } }; 
type DreamGroup = { key: string; agentId: string; agentName: string; day: string; entries: DreamEntry[] };
type DateBucket = { key: string; year: string; month: string; day: string; label: string; count: number };
type CalendarDay = { key: string; day: number; count: number; hasData: boolean };
type ArchiveSessionCache = { savedAt: number; sessions: ArchiveSession[] };
type ContinuityCardGroup = { card: ContinuityCard; history: ContinuityHistoryEntry[] };

const archiveSessionsCacheKey = 'hc.archiveSessions.v1';
const archiveSessionsCacheLimit = 12;
const archiveDetailsCacheKey = 'hc.archiveDetails.v1';
const archiveDetailsCacheLimit = 24;

function archiveDetailCacheKey(session: ArchiveSession) {
  return `${session.agentId || ''}:${session.sessionId}`;
}

function readArchiveDetailCache(session: ArchiveSession) {
  try {
    const stored = JSON.parse(window.localStorage.getItem(archiveDetailsCacheKey) || '{}') as Record<string, { savedAt: number; detail: ArchiveDetail }>;
    const entry = stored[archiveDetailCacheKey(session)];
    return entry?.detail && typeof entry.detail === 'object' ? entry.detail : null;
  } catch {
    return null;
  }
}

function writeArchiveDetailCache(session: ArchiveSession, detail: ArchiveDetail) {
  try {
    const stored = JSON.parse(window.localStorage.getItem(archiveDetailsCacheKey) || '{}') as Record<string, { savedAt: number; detail: ArchiveDetail }>;
    const next = { ...stored, [archiveDetailCacheKey(session)]: { savedAt: Date.now(), detail } };
    const entries = Object.entries(next).sort(([, a], [, b]) => b.savedAt - a.savedAt).slice(0, archiveDetailsCacheLimit);
    window.localStorage.setItem(archiveDetailsCacheKey, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Cached archive details are an enhancement; storage failures are harmless.
  }
}

function readArchiveSessionCache(query: string) {
  try {
    const stored = JSON.parse(window.localStorage.getItem(archiveSessionsCacheKey) || '{}') as Record<string, ArchiveSessionCache>;
    const entry = stored[query];
    return entry && Array.isArray(entry.sessions) ? entry : null;
  } catch {
    return null;
  }
}

function writeArchiveSessionCache(query: string, sessions: ArchiveSession[]) {
  try {
    const stored = JSON.parse(window.localStorage.getItem(archiveSessionsCacheKey) || '{}') as Record<string, ArchiveSessionCache>;
    const next = { ...stored, [query]: { savedAt: Date.now(), sessions } };
    const entries = Object.entries(next).sort(([, a], [, b]) => b.savedAt - a.savedAt).slice(0, archiveSessionsCacheLimit);
    window.localStorage.setItem(archiveSessionsCacheKey, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    // Caching is an enhancement; a full or unavailable storage area must not
    // prevent the archive from loading from the API.
  }
}

function monthKey(date: Date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`; }
function dateFromMonthKey(key: string) { const [year, month] = key.split('-').map(Number); return new Date(year, month - 1, 1); }

const archiveKinds: { id: ArchiveKind; label: string; detail: string }[] = [
  { id: 'chat', label: 'Chat', detail: 'Searchable conversations and session history.' },
  { id: 'dreams', label: 'Dreams', detail: 'Small remembered things from your agents.' },
  { id: 'tiddle', label: 'Tiddle', detail: 'Warm continuity cards and their history.' },
  { id: 'proof', label: 'Proof', detail: 'Operator-readable run outcomes and evidence.' },
];
function archiveDate(value: string | null) { if (!value) return null; const date = new Date(value); return Number.isNaN(date.getTime()) ? null : date; }
function formatArchiveDate(value: string | null) { const date = archiveDate(value); return date ? new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date) : 'No date'; }
function formatDayKey(value: string | null) { const date = archiveDate(value); return date ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}` : null; }
function archiveSessionDate(session: ArchiveSession) { return session.archivedAt || session.updatedAt || session.createdAt; }
function archiveSessionTitle(session: ArchiveSession) {
  if (session.archiveSnapshot === 'reset' && session.title === 'default · Reset') {
    const date = archiveDate(session.updatedAt || session.createdAt);
    return date ? `Default · Reset ${new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(date)}` : session.title;
  }
  return session.title || session.sessionId;
}
// Dreams belong to the day they were recorded. entryDate is diary metadata and
// should not move a morning dream into a different archive day.
function dreamDate(entry: DreamEntry) { return entry.createdAt; }
function formatDreamGroupDay(value: string) { const [year, month, day] = value.split('-'); return month && day && year ? `${month}-${day}-${year}` : value; }
function dreamText(entry: DreamEntry) { return textFromChatValue(entry.narrative) || 'No narrative is available for this dream.'; }
const dreamPhaseOrder = ['light', 'deep', 'rem'];
function dreamPhaseRank(phase: string) { const rank = dreamPhaseOrder.indexOf(phase.trim().toLowerCase()); return rank === -1 ? dreamPhaseOrder.length : rank; }
function formatTurnDate(value?: string) { const date = value ? new Date(value) : null; return date && !Number.isNaN(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date) : ''; }

async function copyText(text: string) {
  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the synchronous browser fallback for local HTTP.
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  textarea.remove();
  return copied;
}

function archiveTurnText(turn: SessionTurn, agentName: string) {
  const role = ['user', 'operator', 'human'].includes((turn.role || '').toLowerCase()) ? 'You' : agentName || 'Agent';
  const text = textFromChatValue(turn.content);
  return text ? `## ${role}${formatTurnDate(turn.ts) ? ` · ${formatTurnDate(turn.ts)}` : ''}\n\n${text}` : '';
}

function ArchiveReaderToolbar({ eyebrow, title, detail, copyText: value, copyLabel }: { eyebrow: string; title: string; detail: string; copyText: string; copyLabel: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    const didCopy = await copyText(value);
    setCopyState(didCopy ? 'copied' : 'failed');
    window.setTimeout(() => setCopyState('idle'), 1500);
  };
  return <div className="archive-content-toolbar archive-reader-toolbar"><div><span className="eyebrow">{eyebrow}</span><h2>{title}</h2><p>{detail}</p></div><button type="button" className="archive-copy-button" onClick={copy} disabled={!value} aria-label={copyState === 'copied' ? 'Copied' : `${copyLabel} as Markdown`}><span aria-hidden="true">{copyState === 'copied' ? '✓' : '⧉'}</span>{copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : copyLabel}</button></div>;
}

function DreamCopyButton({ text }: { text: string }) {
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const copy = async () => {
    const didCopy = await copyText(text);
    setCopyState(didCopy ? 'copied' : 'failed');
    window.setTimeout(() => setCopyState('idle'), 1500);
  };
  return <button type="button" className="archive-card-copy-button" onClick={copy} aria-label={copyState === 'copied' ? 'Copied dream' : 'Copy dream'} title={copyState === 'copied' ? 'Copied' : copyState === 'failed' ? 'Copy failed' : 'Copy dream'}>{copyState === 'copied' ? '✓' : '⧉'}<span className="sr-only">{copyState === 'copied' ? 'Copied' : 'Copy dream'}</span></button>;
}

export function Archive({ agents }: { agents: Agent[] }) {
  const [kind, setKind] = useState<ArchiveKind>('chat');
  const [selectedAgent, setSelectedAgent] = useState('');
  const [selectedDate, setSelectedDate] = useState('');
  const [search, setSearch] = useState('');
  const [sessions, setSessions] = useState<ArchiveSession[]>([]);
  const [selectedSession, setSelectedSession] = useState<ArchiveSession | null>(null);
  const [selectedDreamGroup, setSelectedDreamGroup] = useState<DreamGroup | null>(null);
  const [dreams, setDreams] = useState<DreamEntry[]>([]);
  const [tiddleGroups, setTiddleGroups] = useState<ContinuityCardGroup[]>([]);
  const [tiddleCount, setTiddleCount] = useState<number | null>(null);
  const [selectedTiddle, setSelectedTiddle] = useState<ContinuityCardGroup | null>(null);
  const [detail, setDetail] = useState<ArchiveDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [dreamDetailLoading, setDreamDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [dreamDetailError, setDreamDetailError] = useState('');
  const selectedKind = archiveKinds.find((item) => item.id === kind)!;

  useEffect(() => {
    const abort = new AbortController();
    const query = new URLSearchParams({ limit: '500' });
    if (selectedAgent) query.set('agentId', selectedAgent);
    api<{ cards: ContinuityCard[] }>(`/api/archive/continuity/cards?${query}`, { signal: abort.signal })
      .then((response) => { if (!abort.signal.aborted) setTiddleCount(response.cards.length); })
      .catch(() => { if (!abort.signal.aborted) setTiddleCount(null); });
    return () => abort.abort();
  }, [selectedAgent]);

  useEffect(() => {
    if (kind !== 'tiddle') return;
    const abort = new AbortController();
    setLoading(true); setError('');
    const query = new URLSearchParams({ limit: '500' });
    if (selectedAgent) query.set('agentId', selectedAgent);
    api<{ cards: ContinuityCard[] }>(`/api/archive/continuity/cards?${query}`, { signal: abort.signal }).then((response) => {
      const cards = response.cards.filter((card) => !search.trim() || `${card.title} ${card.summary}`.toLowerCase().includes(search.trim().toLowerCase()));
      if (!abort.signal.aborted) setTiddleGroups(cards.map((card) => ({ card, history: [] })));
    }).catch((cause) => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load Tiddle cards.'); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [kind, search, selectedAgent]);

  useEffect(() => {
    const abort = new AbortController();
    const load = async () => {
      setLoading(true); setError('');
      try {
        const response = await api<{ entries: ArchiveDream[] }>('/api/archive/dreams?limit=200', { signal: abort.signal });
        if (!abort.signal.aborted) setDreams(response.entries.map((entry) => ({ ...entry, narrative: entry.excerpt, sourceRefs: [] })));
      } catch (cause) { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load dream archive.'); }
      finally { if (!abort.signal.aborted) setLoading(false); }
    };
    void load();
    return () => abort.abort();
  }, [agents]);

  useEffect(() => {
    if (kind !== 'chat') return;
    const abort = new AbortController();
    const query = search.trim();
    const cached = readArchiveSessionCache(query);
    if (cached) {
      setSessions(cached.sessions);
      setLoading(false);
    }
    const timer = window.setTimeout(() => {
      if (!cached) setLoading(true);
      setError('');
      api<{ sessions: ArchiveSession[] }>(`/api/archive/sessions?archived=true&limit=200&q=${encodeURIComponent(query)}`, { signal: abort.signal })
        .then(({ sessions: nextSessions }) => {
          if (abort.signal.aborted) return;
          setSessions(nextSessions);
          writeArchiveSessionCache(query, nextSessions);
        })
        .catch((nextError: Error) => { if (!abort.signal.aborted && !cached) setError(nextError.message || 'Could not load archive sessions.'); })
        .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    }, cached ? 0 : 180);
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [kind, search]);

  useEffect(() => {
    if (!selectedSession || kind !== 'chat') return;
    const abort = new AbortController();
    const cachedDetail = readArchiveDetailCache(selectedSession);
    setDetail(cachedDetail);
    setDetailError('');
    setDetailLoading(!cachedDetail);
    api<ArchiveDetail>(`/api/archive/sessions/${encodeURIComponent(selectedSession.agentId || '')}/${encodeURIComponent(selectedSession.sessionId)}`, { signal: abort.signal })
      .then((nextDetail) => {
        if (abort.signal.aborted) return;
        setDetail(nextDetail);
        writeArchiveDetailCache(selectedSession, nextDetail);
      })
      .catch((nextError: Error) => { if (!abort.signal.aborted && !cachedDetail) setDetailError(nextError.message || 'Could not load this conversation.'); })
      .finally(() => { if (!abort.signal.aborted) setDetailLoading(false); });
    return () => abort.abort();
  }, [kind, selectedSession]);

  useEffect(() => {
    if (!selectedDreamGroup || kind !== 'dreams') return;
    const abort = new AbortController();
    setDreamDetailLoading(true); setDreamDetailError('');
    Promise.all(selectedDreamGroup.entries.map(async (entry) => {
      const response = await api<ArchiveDreamDocument>(`/api/archive/dreams/${encodeURIComponent(entry.agentId)}/${encodeURIComponent(entry.id)}`, { signal: abort.signal });
      return { ...entry, narrative: response.document.markdown };
    })).then((entries) => {
      if (!abort.signal.aborted) setSelectedDreamGroup((group) => group ? { ...group, entries } : group);
    }).catch((nextError: Error) => { if (!abort.signal.aborted) setDreamDetailError(nextError.message || 'Could not load the full dream.'); }).finally(() => { if (!abort.signal.aborted) setDreamDetailLoading(false); });
    return () => abort.abort();
  }, [kind, selectedDreamGroup?.key]);

  const agentSessions = useMemo(() => sessions.filter((session) => !selectedAgent || session.agentId === selectedAgent), [selectedAgent, sessions]);

  const agentDreams = useMemo(() => dreams.filter((entry) => !selectedAgent || entry.agentId === selectedAgent).filter((entry) => !search || `${entry.agentName} ${entry.phase} ${dreamText(entry)}`.toLowerCase().includes(search.toLowerCase())), [dreams, search, selectedAgent]);
  const visibleDreams = useMemo(() => agentDreams.filter((entry) => !selectedDate || formatDayKey(dreamDate(entry)) === selectedDate), [agentDreams, selectedDate]);
  const dreamGroups = useMemo<DreamGroup[]>(() => {
    const groups = new Map<string, DreamGroup>();
    visibleDreams.forEach((entry) => {
      const day = formatDayKey(dreamDate(entry));
      if (!day) return;
      const key = `${entry.agentId}:${day}`;
      const existing = groups.get(key);
      if (existing) existing.entries.push(entry);
      else groups.set(key, { key, agentId: entry.agentId, agentName: entry.agentName, day, entries: [entry] });
    });
    return [...groups.values()].map((group) => ({ ...group, entries: [...group.entries].sort((a, b) => dreamPhaseRank(a.phase) - dreamPhaseRank(b.phase)) })).sort((a, b) => b.day.localeCompare(a.day) || a.agentName.localeCompare(b.agentName));
  }, [visibleDreams]);
  const dateBuckets = useMemo(() => { const buckets = new Map<string, DateBucket>(); const dates = kind === 'chat' ? agentSessions.map((session) => archiveSessionDate(session)) : agentDreams.map(dreamDate); dates.forEach((value) => { const date = archiveDate(value); const key = formatDayKey(value); if (!date || !key) return; const existing = buckets.get(key); if (existing) { existing.count += 1; return; } buckets.set(key, { key, year: String(date.getFullYear()), month: new Intl.DateTimeFormat(undefined, { month: 'long' }).format(date), day: new Intl.DateTimeFormat(undefined, { day: 'numeric' }).format(date), label: new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(date), count: 1 }); }); return [...buckets.values()].sort((a, b) => b.key.localeCompare(a.key)); }, [agentDreams, agentSessions, kind]);
  const visibleSessions = useMemo(() => agentSessions.filter((session) => !selectedDate || formatDayKey(archiveSessionDate(session)) === selectedDate), [agentSessions, selectedDate]);
  const selectedDateLabel = dateBuckets.find((bucket) => bucket.key === selectedDate)?.label;
  const [calendarMonth, setCalendarMonth] = useState(() => monthKey(new Date()));
  const calendarDays = useMemo<CalendarDay[]>(() => {
    const month = dateFromMonthKey(calendarMonth);
    const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    const firstDay = new Date(month.getFullYear(), month.getMonth(), 1).getDay();
    const counts = new Map(dateBuckets.map((bucket) => [bucket.key, bucket.count]));
    return [...Array(firstDay).fill(null), ...Array.from({ length: daysInMonth }, (_, index) => {
      const day = index + 1;
      const key = `${calendarMonth}-${String(day).padStart(2, '0')}`;
      return { key, day, count: counts.get(key) || 0, hasData: counts.has(key) };
    })];
  }, [calendarMonth, dateBuckets]);
  const calendarLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(dateFromMonthKey(calendarMonth));
  const turns = detail?.turns || detail?.chatTurns || detail?.session?.turns || [];
  const handleKindChange = (nextKind: ArchiveKind) => {
    setKind(nextKind);
    setSelectedSession(null);
    setSelectedDreamGroup(null);
    setSelectedTiddle(null);
    setDetail(null);
    setDetailError('');
    setDetailLoading(false);
  };

  return (
    <div className="page-view archive-page">
      <header className="archive-heading">
        <div><h1>Archive</h1><p>Conversations and small remembered things, organized for later.</p></div>
        <div className="archive-heading-tools"><label className="archive-search"><span className="sr-only">Search archive</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={kind === 'chat' ? 'Search conversations' : kind === 'proof' ? 'Search proof runs' : 'Search dreams'} /></label><label className="archive-agent-filter"><span className="sr-only">Filter by agent</span><select value={selectedAgent} onChange={(event) => { setSelectedAgent(event.target.value); setSelectedDate(''); }}><option value="">All agents</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label></div>
      </header>
      <div className="archive-layout">
        <aside className="archive-sidebar" aria-label="Archive navigation">
          <section><span className="archive-sidebar-label">Browse</span>{archiveKinds.map((item) => <button key={item.id} type="button" className={kind === item.id ? 'active' : ''} onClick={() => handleKindChange(item.id)}><span>{item.label}</span><span className="archive-count">{item.id === 'dreams' ? dreams.length : item.id === 'tiddle' ? tiddleCount ?? '—' : item.id === 'proof' ? 'Runs' : sessions.length}</span></button>)}</section>
          <section className="archive-calendar" aria-label="Archive calendar">
            <div className="archive-calendar-heading"><span className="archive-sidebar-label">When</span><button type="button" className="archive-all-dates" onClick={() => setSelectedDate('')}>All dates</button></div>
            <div className="archive-calendar-nav"><button type="button" aria-label="Previous month" onClick={() => setCalendarMonth(monthKey(new Date(dateFromMonthKey(calendarMonth).getFullYear(), dateFromMonthKey(calendarMonth).getMonth() - 1, 1)))}>‹</button><strong>{calendarLabel}</strong><button type="button" aria-label="Next month" onClick={() => setCalendarMonth(monthKey(new Date(dateFromMonthKey(calendarMonth).getFullYear(), dateFromMonthKey(calendarMonth).getMonth() + 1, 1)))}>›</button></div>
            <div className="archive-calendar-weekdays" aria-hidden="true">{['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}</div>
            <div className="archive-calendar-grid">{calendarDays.map((day, index) => day ? <button key={day.key} type="button" className={`${selectedDate === day.key ? 'active ' : ''}${day.hasData ? 'has-data' : 'empty'}`} disabled={!day.hasData} onClick={() => setSelectedDate(day.key)} aria-label={`${day.key}${day.hasData ? `, ${day.count} conversations` : ', no conversations'}`} aria-pressed={selectedDate === day.key}>{day.day}</button> : <span key={`blank-${index}`} aria-hidden="true" />)}</div>
          </section>
        </aside>
        <main className="archive-content">
          {kind === 'chat' ? (
            <div className="archive-split-view">
              <section className="archive-results-pane" aria-label="Archived conversations">
                <div className="archive-pane-heading"><span className="eyebrow">Chat</span><strong>{visibleSessions.length} conversations</strong></div>
                <div className="archive-session-list">{visibleSessions.map((session) => <button type="button" key={`${session.agentId || 'agent'}:${session.sessionId}`} className={`archive-session-card${selectedSession && session.sessionId === selectedSession.sessionId && session.agentId === selectedSession.agentId ? ' selected' : ''}`} onClick={() => setSelectedSession(session)}><div className="archive-session-main"><div className="archive-session-meta"><span>{session.agentName || session.agentId || 'Unknown agent'}</span><span>{formatArchiveDate(archiveSessionDate(session))}</span></div><h3>{archiveSessionTitle(session)}</h3><p>{session.summary || 'No summary is available yet.'}</p></div><div className="archive-session-side"><strong>{session.chatTurnCount ?? session.turnCount ?? 0}</strong><span>turns</span>{session.archived ? <em>Archived</em> : <em>Active</em>}</div></button>)}</div>
              </section>
              <section className="archive-reader-pane">
              {selectedSession ? <>
                <ArchiveReaderToolbar eyebrow={selectedSession.agentName || selectedSession.agentId || 'Archived chat'} title={archiveSessionTitle(selectedSession)} detail={`${formatArchiveDate(archiveSessionDate(selectedSession))} · ${selectedSession.chatTurnCount ?? selectedSession.turnCount ?? 0} turns`} copyText={(detail?.turns || detail?.chatTurns || detail?.session?.turns || []).map((turn) => archiveTurnText(turn, selectedSession.agentName || 'Agent')).filter(Boolean).join('\n\n')} copyLabel="Copy chat" />
                <div className="archive-content-body archive-reader-body">
                  {detailLoading ? <section className="archive-empty-state"><div className="archive-empty-mark" aria-hidden="true">⌁</div><div><h3>Loading conversation.</h3><p>Opening the archived transcript.</p></div></section> : null}
                  {detailError ? <section className="archive-empty-state archive-error"><div className="archive-empty-mark" aria-hidden="true">!</div><div><h3>Could not open this conversation.</h3><p>{detailError}</p></div></section> : null}
                  {!detailLoading && !detailError ? <div className="archive-reader"><div className="archive-reader-summary">{selectedSession.summary || 'A mysterious little shelf item.'}</div>{turns.length ? turns.map((turn, index) => { const role = ['user', 'operator', 'human'].includes((turn.role || '').toLowerCase()) ? 'operator' : 'agent'; const text = textFromChatValue(turn.content); return <article className={`archive-turn ${role}`} key={`${turn.ts || 'turn'}-${index}`}><div className="archive-turn-meta"><strong>{role === 'operator' ? 'You' : selectedSession.agentName || 'Agent'}</strong><span>{formatTurnDate(turn.ts)}</span></div>{text ? <div className="archive-turn-body"><ReactMarkdown remarkPlugins={[remarkBreaks]}>{text}</ReactMarkdown></div> : null}</article>; }) : <p className="archive-reader-empty">This conversation has no readable chat turns.</p>}</div> : null}
                </div>
              </> : <section className="archive-empty-state archive-reader-placeholder"><div className="archive-empty-mark" aria-hidden="true">⌁</div><div><h3>Select a conversation.</h3><p>Choose a chat from the list to read it here.</p></div></section>}
              </section>
            </div>
          ) : kind === 'dreams' ? (
            <div className="archive-split-view">
              <section className="archive-results-pane" aria-label="Dream diary groups">
                <div className="archive-pane-heading"><span className="eyebrow">Dreams</span><strong>{dreamGroups.length} dream groups</strong></div>
                <div className="archive-session-list">
                  {loading ? <section className="archive-empty-state"><div className="archive-empty-mark" aria-hidden="true">⌁</div><div><h3>Gathering the dreams.</h3><p>Opening the remembered things from your agents.</p></div></section> : null}
                  {error ? <section className="archive-empty-state archive-error"><div className="archive-empty-mark" aria-hidden="true">!</div><div><h3>Could not load the dream archive.</h3><p>{error}</p></div></section> : null}
                  {!loading && !error && !dreamGroups.length ? <section className="archive-empty-state"><div className="archive-empty-mark" aria-hidden="true">⌁</div><div><h3>No dreams match this shelf.</h3><p>Try adjusting the search, date, or agent filter.</p></div></section> : null}
                  {!loading && !error ? dreamGroups.map((group) => <button type="button" key={group.key} className={`archive-session-card dream-archive-card${selectedDreamGroup?.key === group.key ? ' selected' : ''}`} onClick={() => setSelectedDreamGroup(group)}><div className="archive-session-main"><div className="archive-session-meta"><span>{group.agentName}</span><span>{formatArchiveDate(dreamDate(group.entries[0]))}</span></div><h3>{group.agentName} Dreams {formatDreamGroupDay(group.day)}</h3><p>{group.entries.length} remembered states: {group.entries.map((entry) => entry.phase).join(', ')}</p></div><div className="archive-session-side"><strong>{group.entries.length}</strong><span>states</span><em>Remembered</em></div></button>) : null}
                </div>
              </section>
              <section className="archive-reader-pane">
                {selectedDreamGroup ? <>
                  <ArchiveReaderToolbar eyebrow={`${selectedDreamGroup.agentName} · Dreams`} title={selectedDreamGroup.day} detail={`${selectedDreamGroup.entries.length} remembered states`} copyText={selectedDreamGroup.entries.map((entry) => `## ${entry.phase} · ${formatArchiveDate(entry.createdAt)}\n\n${dreamText(entry)}`).join('\n\n')} copyLabel="Copy dreams" />
                  <div className="archive-content-body archive-reader-body">
                    {dreamDetailLoading ? <section className="archive-empty-state"><div className="archive-empty-mark" aria-hidden="true">⌁</div><div><h3>Opening the full dreams.</h3><p>Gathering every remembered state.</p></div></section> : null}
                    {dreamDetailError ? <section className="archive-empty-state archive-error"><div className="archive-empty-mark" aria-hidden="true">!</div><div><h3>Could not open these dreams.</h3><p>{dreamDetailError}</p></div></section> : null}
                    {!dreamDetailLoading && !dreamDetailError ? <div className="archive-reader dream-archive-stack">{selectedDreamGroup.entries.map((entry) => <article className="archive-reader-summary dream-archive-entry" key={entry.id}><div className="archive-turn-meta"><strong>{entry.phase}</strong><span>{formatArchiveDate(entry.createdAt)}</span></div><ReactMarkdown remarkPlugins={[remarkBreaks]}>{dreamText(entry)}</ReactMarkdown><div className="dream-archive-entry-actions"><DreamCopyButton text={`## ${entry.phase} · ${formatArchiveDate(entry.createdAt)}\n\n${dreamText(entry)}`} /></div></article>)}</div> : null}
                  </div>
                </> : <section className="archive-empty-state archive-reader-placeholder"><div className="archive-empty-mark" aria-hidden="true">⌁</div><div><h3>Select a dream group.</h3><p>Choose a day from the list to read Light, Deep, and REM here.</p></div></section>}
              </section>
            </div>
          ) : kind === 'tiddle' ? (
            <div className="archive-split-view">
              <section className="archive-results-pane" aria-label="Tiddle warm cards">
                <div className="archive-pane-heading"><span className="eyebrow">Tiddle</span><strong>{tiddleGroups.length} warm cards</strong></div>
                <div className="archive-session-list">
                  {loading ? <section className="archive-empty-state"><div className="archive-empty-mark" aria-hidden="true">⌁</div><div><h3>Gathering warm cards.</h3><p>Opening Tiddle continuity.</p></div></section> : null}
                  {error ? <section className="archive-empty-state archive-error"><div className="archive-empty-mark" aria-hidden="true">!</div><div><h3>Could not load Tiddle.</h3><p>{error}</p></div></section> : null}
                  {!loading && !error && !tiddleGroups.length ? <section className="archive-empty-state"><div className="archive-empty-mark" aria-hidden="true">⌁</div><div><h3>No warm cards match this shelf.</h3><p>Try another search or agent.</p></div></section> : null}
                  {!loading && !error ? tiddleGroups.map(({ card }) => <button type="button" key={card.id} className={`archive-session-card tiddle-archive-card${selectedTiddle?.card.id === card.id ? ' selected' : ''}`} onClick={() => { setDetailLoading(true); api<{ card: ContinuityCard; history: ContinuityHistoryEntry[] }>(`/api/archive/continuity/cards/${encodeURIComponent(card.agentId)}/${encodeURIComponent(card.id)}?limit=500`).then((detail) => setSelectedTiddle(detail)).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load continuity card.')).finally(() => setDetailLoading(false)); }}><div className="archive-session-main"><div className="archive-session-meta"><span>{card.agentId}</span><span>{formatArchiveDate(card.lastSeen)}</span></div><h3>{card.title}</h3><p>{card.summary}</p></div><div className="archive-session-side"><strong>{card.recurrence}</strong><span>repeats</span><em>Warm</em></div></button>) : null}
                </div>
              </section>
              <section className="archive-reader-pane">
                {selectedTiddle ? <>
                  <ArchiveReaderToolbar eyebrow={`${selectedTiddle.card.agentId} · Tiddle`} title={selectedTiddle.card.title} detail={`${selectedTiddle.card.recurrence} recurrences · Last seen ${formatArchiveDate(selectedTiddle.card.lastSeen)}`} copyText={`# ${selectedTiddle.card.title}\n\n${selectedTiddle.card.summary}`} copyLabel="Copy card" />
                  <div className="archive-content-body archive-reader-body"><div className="archive-reader tiddle-archive-reader"><div className="archive-reader-summary">{selectedTiddle.card.summary}</div><dl className="tiddle-card-details"><div><dt>First seen</dt><dd>{formatArchiveDate(selectedTiddle.card.firstSeen)}</dd></div><div><dt>Last seen</dt><dd>{formatArchiveDate(selectedTiddle.card.lastSeen)}</dd></div><div><dt>Recurrence</dt><dd>{selectedTiddle.card.recurrence}</dd></div><div><dt>Evidence</dt><dd>{selectedTiddle.card.evidence || 'Warm continuity'}</dd></div></dl>{selectedTiddle.card.reason ? <section className="tiddle-reason"><h3>Why it persisted</h3><p>{selectedTiddle.card.reason}</p></section> : null}<section className="tiddle-history"><h3>History</h3>{selectedTiddle.history.length ? selectedTiddle.history.map((entry) => <article key={entry.id} className="tiddle-history-entry"><div className="archive-turn-meta"><strong>{entry.disposition}</strong><span>{formatArchiveDate(entry.at)}</span></div><p>{entry.summaryAfter || entry.reason}</p></article>) : <p className="archive-reader-empty">No history entries are available for this card.</p>}</section></div></div>
                </> : <section className="archive-empty-state archive-reader-placeholder"><div className="archive-empty-mark" aria-hidden="true">⌁</div><div><h3>Select a warm card.</h3><p>Choose a Tiddle card from the list to inspect its history here.</p></div></section>}
              </section>
            </div>
          ) : kind === 'proof' ? (
            <ArchiveRunsProof agents={agents} selectedAgent={selectedAgent} search={search} />
          ) : null}
        </main>
      </div>
    </div>
  );
}
