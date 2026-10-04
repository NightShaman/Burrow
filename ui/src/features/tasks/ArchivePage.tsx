import { ownedAgentResource } from '../../app/ownedAgent';
import { useOwnedApi, targetOwnerKey } from '../../app/useOwnedApi';
import { localApiTarget, type ApiTarget } from '../../app/apiTargets';
import { loadModArchives, modsChangedEvent, type ModArchive } from '../../app/modPanels';
import { ModArchiveHost } from '../mods/ModArchiveHost';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Agent } from '../../app/types';
import { ArchiveRunsProof } from './ArchiveRunsProof';
import { archiveQueryCacheKey, readArchiveSessionCache, writeArchiveSessionCache } from './archiveCache';
import { createArchiveRepository, type ArchiveRepository, type ArchiveCalendarKind } from './archiveRepository';
import { archiveSessionDate, buildCalendarDays, dateFromMonthKey, dreamDate, filterArchiveSessions, filterDreamEntries, groupDreamEntries, monthKey } from './archiveDerivations';
import { archiveSessionTitle, ChatArchiveReader, DreamArchiveReader, formatArchiveDate, TiddleArchiveReader } from './ArchiveReaders';
import type { ArchiveDetail, ArchiveKind, ArchiveSession, ContinuityCard, ContinuityCardGroup, DreamEntry, DreamGroup } from './archiveTypes';


const archiveKinds: { id: ArchiveKind; label: string; detail: string }[] = [
  { id: 'chat', label: 'Chat', detail: 'Searchable conversations and session history.' },
  { id: 'dreams', label: 'Dreams', detail: 'Small remembered things from your agents.' },
  { id: 'tiddle', label: 'Tiddle', detail: 'Warm continuity cards and their history.' },
  { id: 'proof', label: 'Proof', detail: 'Operator-readable run outcomes and evidence.' },
];

function formatDreamGroupDay(value: string) {
  const [year, month, day] = value.split('-');
  return month && day && year ? `${month}-${day}-${year}` : value;
}

export function Archive({ agents, operatorName = 'Operator', target = localApiTarget, repository }: { agents: Agent[]; operatorName?: string; target?: ApiTarget | null; repository?: ArchiveRepository }) {
  const owned = useOwnedApi(target);
  const [capturedTarget] = useState(() => target && { ...target });
  const archiveRepository = useMemo(() => {
    const base = repository ?? createArchiveRepository(owned.api);
    const positions: Record<string, number> = { listSessions: 4, listDreams: 3, listContinuityCards: 0, listRuns: 0, listCalendarAvailability: 2 };
    return new Proxy(base, { get(object, key) {
      const method = object[key as keyof typeof object];
      if (typeof key !== 'string' || !(key in positions)) return method;
      return async (...args: any[]) => {
        const index = positions[key];
        if (args[index]) args[index] = ownedAgentResource(agents, args[index], capturedTarget);
        return (method as Function)(...args);
      };
    } });
  }, [owned, repository, agents, capturedTarget]);
  const cacheOwner = targetOwnerKey(target);
  const agentNames = useMemo(() => new Map(agents.map((agent) => [agent.id, agent.name])), [agents]);
  const [modArchives, setModArchives] = useState<ModArchive[]>([]);
  const [modId, setModId] = useState('');
  const activeMod = modArchives.find((mod) => mod.modId === modId);
  useEffect(() => {
    let live = true;
    const refresh = () => { void loadModArchives().then((mods) => { if (live) setModArchives(mods); }).catch(() => { if (live) setModArchives([]); }); };
    refresh(); window.addEventListener(modsChangedEvent, refresh);
    return () => { live = false; window.removeEventListener(modsChangedEvent, refresh); };
  }, []);
  const [kind, setKind] = useState<ArchiveKind>('chat');
  const [selectedAgent, setSelectedAgent] = useState('');
  const selectedAgentRef = useRef(selectedAgent);
  selectedAgentRef.current = selectedAgent;
  const [selectedDate, setSelectedDate] = useState('');
  const [search, setSearch] = useState('');
  const queryKey = archiveQueryCacheKey({ target: cacheOwner, agent: selectedAgent, query: search, date: selectedDate, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, kind });
  const scopeRef = useRef(queryKey);
  scopeRef.current = queryKey;
  const moreRequests = useRef(new Set<AbortController>());
  useEffect(() => {
    setSessionsCursor(null); setSessionsHasMore(false); setSessionsMoreLoading(false);
    setDreamsCursor(null); setDreamsHasMore(false); setDreamsMoreLoading(false);
    setTiddleCursor(null); setTiddleHasMore(false); setTiddleMoreLoading(false);
    setTiddleHistoryCursor(null); setTiddleHistoryHasMore(false); setTiddleHistoryLoading(false);
    return () => {
      moreRequests.current.forEach((request) => request.abort()); moreRequests.current.clear();
      tiddleHistoryRequest.current?.abort(); earlierAbort.current?.abort();
    };
  }, [queryKey]);
  const [sessions, setSessions] = useState<ArchiveSession[]>([]);
  const [sessionsCursor, setSessionsCursor] = useState<string | null>(null);
  const [sessionsHasMore, setSessionsHasMore] = useState(false);
  const [sessionsMoreLoading, setSessionsMoreLoading] = useState(false);
  const [dreamsCursor, setDreamsCursor] = useState<string | null>(null);
  const [dreamsHasMore, setDreamsHasMore] = useState(false);
  const [dreamsMoreLoading, setDreamsMoreLoading] = useState(false);
  const [tiddleCursor, setTiddleCursor] = useState<string | null>(null);
  const [tiddleHasMore, setTiddleHasMore] = useState(false);
  const [tiddleMoreLoading, setTiddleMoreLoading] = useState(false);
  const [tiddleHistoryCursor, setTiddleHistoryCursor] = useState<string | null>(null);
  const [tiddleHistoryHasMore, setTiddleHistoryHasMore] = useState(false);
  const [tiddleHistoryLoading, setTiddleHistoryLoading] = useState(false);
  const [tiddleHistoryError, setTiddleHistoryError] = useState('');
  const tiddleHistoryRequest = useRef<AbortController | null>(null);
  const [selectedSession, setSelectedSession] = useState<ArchiveSession | null>(null);
  const [selectedDreamGroup, setSelectedDreamGroup] = useState<DreamGroup | null>(null);
  const [dreams, setDreams] = useState<DreamEntry[]>([]);
  const [tiddleGroups, setTiddleGroups] = useState<ContinuityCardGroup[]>([]);
  const [tiddleCount, setTiddleCount] = useState<number | null>(null);
  const [selectedTiddleCard, setSelectedTiddleCard] = useState<ContinuityCard | null>(null);
  const [selectedTiddle, setSelectedTiddle] = useState<ContinuityCardGroup | null>(null);
  const [detail, setDetail] = useState<ArchiveDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [stale, setStale] = useState(false);
  const [listRetry, setListRetry] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [earlierLoading, setEarlierLoading] = useState(false);
  const [earlierError, setEarlierError] = useState('');
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const earlierAbort = useRef<AbortController | null>(null);
  const loadingEarlier = useRef(false);
  const selectionRef = useRef('');
  const [dreamDetailLoading, setDreamDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [dreamDetailError, setDreamDetailError] = useState('');

  useEffect(() => {
    const abort = new AbortController();
    archiveRepository.listContinuityCards(selectedAgent, abort.signal)
      .then((page) => { if (!abort.signal.aborted) setTiddleCount(page.items.length); })
      .catch(() => { if (!abort.signal.aborted) setTiddleCount(null); });
    return () => abort.abort();
  }, [selectedAgent]);

  useEffect(() => {
    if (kind !== 'tiddle') return;
    const abort = new AbortController();
    setLoading(true); setError('');
    archiveRepository.listContinuityCards(selectedAgent, abort.signal).then((response) => {
      const cards = response.items.filter((card) => !search.trim() || `${card.title} ${card.summary}`.toLowerCase().includes(search.trim().toLowerCase()));
      if (!abort.signal.aborted) { setTiddleGroups(cards.map((card) => ({ card, history: [], nextCursor: null, hasMore: false }))); setTiddleCursor(response.nextCursor); setTiddleHasMore(response.hasMore); }
    }).catch((cause) => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load Tiddle cards.'); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [kind, search, selectedAgent, queryKey]);

  useEffect(() => {
    const abort = new AbortController();
    if (kind !== 'dreams') return () => abort.abort();
    const load = async () => {
      setLoading(true); setError('');
      try {
        const page = await archiveRepository.listDreams(abort.signal, null, selectedDate || undefined, selectedAgent || undefined);
        if (!abort.signal.aborted) { setDreams(page.items); setDreamsCursor(page.nextCursor); setDreamsHasMore(page.hasMore); }
      } catch (cause) { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load dream archive.'); }
      finally { if (!abort.signal.aborted) setLoading(false); }
    };
    void load();
    return () => abort.abort();
  }, [agents, selectedDate, selectedAgent, search, queryKey]);

  useEffect(() => {
    if (kind !== 'chat') return;
    const abort = new AbortController();
    const query = search.trim();
    const cached = readArchiveSessionCache(queryKey);
    setSessions(cached?.sessions ?? []);
    setStale(Boolean(cached)); setLoading(true); setError('');
    const timer = window.setTimeout(() => {
      if (!cached) setLoading(true);
      setError('');
      archiveRepository.listSessions(query, abort.signal, null, selectedDate || undefined, selectedAgent || undefined)
        .then((page) => {
          if (abort.signal.aborted) return;
          setStale(false); setSessions(page.items); setSessionsCursor(page.nextCursor); setSessionsHasMore(page.hasMore);
          writeArchiveSessionCache(queryKey, page.items);
        })
        .catch((nextError: Error) => { if (!abort.signal.aborted) setError(nextError.message || 'Could not load archive sessions.'); })
        .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    }, cached ? 0 : 180);
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [kind, search, selectedDate, selectedAgent, queryKey, listRetry]);

  useEffect(() => {
    const abort = new AbortController();
    earlierAbort.current?.abort();
    loadingEarlier.current = false;
    const identity = kind === 'chat' && selectedSession ? `${selectedSession.agentId}:${selectedSession.sessionId}` : '';
    selectionRef.current = identity;
    setDetail(null);
    setEarlierError('');
    setHistoryUnavailable(false);
    setEarlierLoading(false);
    if (!identity || !selectedSession) { setDetailLoading(false); return () => abort.abort(); }
    setDetailError('');
    setDetailLoading(true);
    archiveRepository.loadSession(selectedSession, abort.signal)
      .then((page) => { if (!abort.signal.aborted && selectionRef.current === identity) { setDetail(page); setHistoryUnavailable(page.historyStatus === 'unavailable'); } })
      .catch((cause: Error) => { if (!abort.signal.aborted && selectionRef.current === identity) setDetailError(cause.message || 'Could not load this conversation.'); })
      .finally(() => { if (!abort.signal.aborted && selectionRef.current === identity) setDetailLoading(false); });
    return () => { abort.abort(); if (selectionRef.current === identity) selectionRef.current = ''; earlierAbort.current?.abort(); };
  }, [kind, selectedSession]);

  const loadMoreSessions = async () => {
    if (!sessionsHasMore || !sessionsCursor || sessionsMoreLoading) return;
    const scope = queryKey; const abort = new AbortController(); moreRequests.current.add(abort);
    const current = () => !abort.signal.aborted && scopeRef.current === scope;
    const query = search.trim(); setSessionsMoreLoading(true); setError('');
    try { const date = selectedDate; const page = await archiveRepository.listSessions(query, abort.signal, sessionsCursor, date || undefined, selectedAgent || undefined); if (!current()) return; setSessions((current) => [...current, ...page.items]); setSessionsCursor(page.nextCursor); setSessionsHasMore(page.hasMore); }
    catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : 'Could not load more conversations.'); }
    finally { moreRequests.current.delete(abort); if (current()) setSessionsMoreLoading(false); }
  };
  const loadMoreDreams = async () => {
    if (!dreamsHasMore || !dreamsCursor || dreamsMoreLoading) return;
    const scope = queryKey; const abort = new AbortController(); moreRequests.current.add(abort);
    const current = () => !abort.signal.aborted && scopeRef.current === scope;
    setDreamsMoreLoading(true);
    try { const date = selectedDate; const page = await archiveRepository.listDreams(abort.signal, dreamsCursor, date || undefined, selectedAgent || undefined); if (!current()) return; setDreams((current) => [...current, ...page.items]); setDreamsCursor(page.nextCursor); setDreamsHasMore(page.hasMore); }
    catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : 'Could not load more dreams.'); }
    finally { moreRequests.current.delete(abort); if (current()) setDreamsMoreLoading(false); }
  };
  const loadMoreTiddleHistory = async () => {
    if (!selectedTiddleCard || !tiddleHistoryHasMore || !tiddleHistoryCursor || tiddleHistoryLoading) return;
    const card = selectedTiddleCard; const cursor = tiddleHistoryCursor;
    tiddleHistoryRequest.current?.abort();
    const abort = new AbortController(); tiddleHistoryRequest.current = abort;
    setTiddleHistoryLoading(true); setTiddleHistoryError('');
    try {
      const page = await archiveRepository.loadContinuityCard(card, abort.signal, cursor);
      if (abort.signal.aborted) return;
      setSelectedTiddle((current) => current?.card.id === card.id && current.card.agentId === card.agentId && current.nextCursor === cursor ? { ...current, history: [...page.history, ...current.history], nextCursor: page.nextCursor, hasMore: page.hasMore } : current);
      setTiddleHistoryCursor(page.nextCursor ?? null); setTiddleHistoryHasMore(Boolean(page.hasMore));
    } catch (cause) { if (!abort.signal.aborted) setTiddleHistoryError(cause instanceof Error ? cause.message : 'Could not load more card history.'); }
    finally { if (!abort.signal.aborted) setTiddleHistoryLoading(false); }
  };
  const loadMoreTiddle = async () => {
    if (!tiddleHasMore || !tiddleCursor || tiddleMoreLoading) return;
    const scope = queryKey; const abort = new AbortController(); moreRequests.current.add(abort);
    const current = () => !abort.signal.aborted && scopeRef.current === scope;
    setTiddleMoreLoading(true);
    try { const page = await archiveRepository.listContinuityCards(selectedAgent, abort.signal, tiddleCursor); if (!current()) return; const cards = page.items.filter((card) => !search.trim() || `${card.title} ${card.summary}`.toLowerCase().includes(search.trim().toLowerCase())); setTiddleGroups((current) => [...current, ...cards.map((card) => ({ card, history: [], nextCursor: null, hasMore: false }))]); setTiddleCursor(page.nextCursor); setTiddleHasMore(page.hasMore); }
    catch (cause) { if (current()) setError(cause instanceof Error ? cause.message : 'Could not load more cards.'); }
    finally { moreRequests.current.delete(abort); if (current()) setTiddleMoreLoading(false); }
  };

  const loadEarlier = () => {
    if (!selectedSession || !detail?.hasMore || !detail.nextCursor || loadingEarlier.current || historyUnavailable) return;
    const identity = selectionRef.current;
    const cursor = detail.nextCursor;
    const abort = new AbortController();
    earlierAbort.current = abort;
    loadingEarlier.current = true;
    setEarlierLoading(true);
    setEarlierError('');
    archiveRepository.loadSession(selectedSession, abort.signal, cursor)
      .then((page) => {
        if (abort.signal.aborted || selectionRef.current !== identity) return;
        setDetail((current) => {
          if (!current || current.nextCursor !== cursor) return current;
          const existing = current.session?.turns || current.turns || current.chatTurns || [];
          const incoming = page.session?.turns || page.turns || page.chatTurns || [];
          const key = (turn: typeof incoming[number]) => JSON.stringify(turn);
          const seen = new Map<string, number>();
          existing.forEach((turn) => seen.set(key(turn), (seen.get(key(turn)) || 0) + 1));
          const older = incoming.filter((turn) => {
            const fingerprint = key(turn);
            const count = seen.get(fingerprint) || 0;
            if (!count) return true;
            seen.set(fingerprint, count - 1);
            return false;
          });
          return { ...current, turns: [...older, ...existing], chatTurns: undefined, session: undefined, hasMore: page.hasMore, nextCursor: page.nextCursor, historyStatus: page.historyStatus };
        });
        setHistoryUnavailable(page.historyStatus === 'unavailable');
      })
      .catch((cause: Error) => {
        if (abort.signal.aborted || selectionRef.current !== identity) return;
        const status = (cause as Error & { status?: number }).status;
        setEarlierError(status === 409 ? 'History changed or is unavailable. Restart from latest to request a fresh page.' : status === 400 ? 'This page cursor is invalid. Restart from latest to request a fresh page.' : cause.message || 'Earlier messages could not be loaded.');
      })
      .finally(() => { if (!abort.signal.aborted && selectionRef.current === identity) { loadingEarlier.current = false; setEarlierLoading(false); } });
  };

  useEffect(() => {
    if (!selectedDreamGroup || kind !== 'dreams') return;
    const abort = new AbortController();
    const groupKey = selectedDreamGroup.key;
    setDreamDetailLoading(true); setDreamDetailError('');
    Promise.all(selectedDreamGroup.entries.map((entry) => archiveRepository.loadDream(entry, abort.signal)))
      .then((entries) => {
        if (!abort.signal.aborted) setSelectedDreamGroup((group) => group?.key === groupKey ? { ...group, entries } : group);
      })
      .catch((nextError: Error) => { if (!abort.signal.aborted) setDreamDetailError(nextError.message || 'Could not load the full dream.'); })
      .finally(() => { if (!abort.signal.aborted) setDreamDetailLoading(false); });
    return () => abort.abort();
  }, [kind, selectedDreamGroup?.key]);

  useEffect(() => {
    if (!selectedTiddleCard || kind !== 'tiddle') return;
    const abort = new AbortController();
    tiddleHistoryRequest.current?.abort();
    setTiddleHistoryCursor(null); setTiddleHistoryHasMore(false); setTiddleHistoryError('');
    setSelectedTiddle(null);
    setDetailLoading(true);
    setDetailError('');
    archiveRepository.loadContinuityCard(selectedTiddleCard, abort.signal)
      .then((nextDetail) => { if (!abort.signal.aborted) { setSelectedTiddle(nextDetail); setTiddleHistoryCursor(nextDetail.nextCursor ?? null); setTiddleHistoryHasMore(Boolean(nextDetail.hasMore)); } })
      .catch((cause) => { if (!abort.signal.aborted) setDetailError(cause instanceof Error ? cause.message : 'Could not load continuity card.'); })
      .finally(() => { if (!abort.signal.aborted) setDetailLoading(false); });
    return () => { abort.abort(); tiddleHistoryRequest.current?.abort(); };
  }, [kind, selectedTiddleCard, queryKey]);

  const visibleSessions = useMemo(() => filterArchiveSessions(sessions, '', selectedDate), [selectedDate, sessions]);
  const visibleDreams = useMemo(() => filterDreamEntries(dreams, '', search, selectedDate), [dreams, search, selectedDate]);
  const dreamGroups = useMemo<DreamGroup[]>(() => groupDreamEntries(visibleDreams), [visibleDreams]);
  const [calendarMonth, setCalendarMonth] = useState(() => monthKey(new Date()));
  const [calendarDates, setCalendarDates] = useState<string[]>([]);
  const [calendarAvailabilityState, setCalendarAvailabilityState] = useState<'loading' | 'ready' | 'error'>('loading');
  const calendarKind: ArchiveCalendarKind | null = kind === 'chat' ? 'sessions' : kind === 'dreams' ? 'dreams' : null;
  useEffect(() => {
    if (!calendarKind) { setCalendarDates([]); setCalendarAvailabilityState('ready'); return; }
    const abort = new AbortController();
    setCalendarDates([]);
    setCalendarAvailabilityState('loading');
    archiveRepository.listCalendarAvailability(calendarKind, calendarMonth, selectedAgent || undefined, abort.signal)
      .then((response) => {
        if (!abort.signal.aborted && response.kind === calendarKind && response.month === calendarMonth) {
          setCalendarDates(response.dates);
          setCalendarAvailabilityState('ready');
        }
      })
      .catch(() => { if (!abort.signal.aborted) { setCalendarDates([]); setCalendarAvailabilityState('error'); } });
    return () => abort.abort();
  }, [calendarKind, calendarMonth, selectedAgent]);
  const dateBuckets = useMemo(() => calendarDates.map((key) => ({ key, count: 1, year: '', month: '', day: '', label: '' })), [calendarDates]);
  const calendarDays = useMemo(() => buildCalendarDays(calendarMonth, dateBuckets), [calendarMonth, dateBuckets]);
  const availableDates = useMemo(() => new Set(calendarDates), [calendarDates]);
  const calendarLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(dateFromMonthKey(calendarMonth));
  const handleKindChange = (nextKind: ArchiveKind) => {
    setKind(nextKind);
    selectionRef.current = "";
    earlierAbort.current?.abort();
    setSelectedSession(null);
    setSelectedDreamGroup(null);
    setSelectedTiddleCard(null);
    setSelectedTiddle(null);
    setDetail(null);
    setDetailError('');
    setDetailLoading(false);
  };

  return (
    <div className="page-view archive-page">
      <header className="archive-heading">
        <div><h1>Archive</h1><p>Conversations and small remembered things, organized for later.</p></div>
        <div className="archive-heading-tools" hidden={Boolean(activeMod)}><label className="archive-search"><span className="sr-only">Search archive</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={kind === 'chat' ? 'Search conversations' : kind === 'proof' ? 'Search proof runs' : 'Search dreams'} /></label><label className="archive-agent-filter"><span className="sr-only">Filter by agent</span><select value={selectedAgent} onChange={(event) => { setSelectedAgent(event.target.value); setSelectedDate(''); }}><option value="">All agents</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label></div>
      </header>
      <div className="archive-layout">
        <aside className="archive-sidebar" aria-label="Archive navigation">
          <section><span className="archive-sidebar-label">Browse</span>{archiveKinds.map((item) => <button key={item.id} type="button" className={!activeMod && kind === item.id ? 'active' : ''} onClick={() => { setModId(''); handleKindChange(item.id); }}><span>{item.label}</span><span className="archive-count">{item.id === 'dreams' ? dreams.length : item.id === 'tiddle' ? tiddleCount ?? '—' : item.id === 'proof' ? 'Runs' : sessions.length}</span></button>)}</section>
          <section><span className="archive-sidebar-label">MODS</span>{modArchives.map((mod) => <button key={mod.modId} type="button" className={activeMod?.modId === mod.modId ? 'active' : ''} onClick={() => setModId(mod.modId)}>{mod.name}</button>)}</section>
          <section className="archive-calendar" aria-label="Archive calendar">
            <div className="archive-calendar-heading"><span className="archive-sidebar-label">When <small>Local time</small></span><button type="button" className="archive-all-dates" onClick={() => setSelectedDate('')}>All dates</button></div>
            <div className="sr-only" role="status" aria-live="polite">{calendarAvailabilityState === 'loading' ? 'Loading dates with archived records.' : calendarAvailabilityState === 'error' ? 'Could not load archive date availability; all dates remain selectable.' : `${calendarDates.length} dates with archived records in ${calendarMonth}.`}</div>
            <div className="archive-calendar-nav"><button type="button" aria-label="Previous month" onClick={() => { const month = dateFromMonthKey(calendarMonth); setCalendarMonth(monthKey(new Date(month.getFullYear(), month.getMonth() - 1, 1))); }}>‹</button><strong>{calendarLabel}</strong><button type="button" aria-label="Next month" onClick={() => { const month = dateFromMonthKey(calendarMonth); setCalendarMonth(monthKey(new Date(month.getFullYear(), month.getMonth() + 1, 1))); }}>›</button></div>
            <div className="archive-calendar-weekdays" aria-hidden="true">{['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => <span key={`${day}-${index}`}>{day}</span>)}</div>
            <div className="archive-calendar-grid">{calendarDays.map((day, index) => day ? <button key={day.key} type="button" className={`${availableDates.has(day.key) ? 'has-data ' : ''}${selectedDate === day.key ? 'active ' : ''}date-selectable`} onClick={() => setSelectedDate(day.key)} aria-label={`Select ${day.key}${availableDates.has(day.key) ? ', has archived records' : ''}`} aria-pressed={selectedDate === day.key} aria-busy={calendarAvailabilityState === 'loading'}>{day.day}</button> : <span key={`blank-${index}`} aria-hidden="true" />)}</div>
          </section>
        </aside>
        <main className="archive-content">
          {activeMod ? <ModArchiveHost panel={activeMod} date={selectedDate} /> : kind === 'chat' ? (
            <div className="archive-split-view">
              <section className="archive-results-pane" aria-label="Archived conversations">
                <div className="archive-pane-heading"><span className="eyebrow">Chat</span><strong>{visibleSessions.length} conversations</strong></div>
                {loading ? <p role="status">Loading conversations…</p> : null}
                {stale ? <p role="status">Showing stale cached conversations while revalidating.</p> : null}
                {error ? <div role="alert"><p>{error}</p><button type="button" onClick={() => setListRetry((value) => value + 1)}>Retry conversations</button></div> : null}
                {!loading && !error && !visibleSessions.length ? <p>No conversations match this shelf.</p> : null}
                <div className="archive-session-list">{visibleSessions.map((session) => <button type="button" key={`${session.agentId || 'agent'}:${session.sessionId}`} className={`archive-session-card${selectedSession && session.sessionId === selectedSession.sessionId && session.agentId === selectedSession.agentId ? ' selected' : ''}`} onClick={() => { selectionRef.current = ""; earlierAbort.current?.abort(); setSelectedSession(session); }}><div className="archive-session-main"><div className="archive-session-meta"><span>{session.agentName || session.agentId || 'Unknown agent'}</span><span>{formatArchiveDate(archiveSessionDate(session))}</span></div><h3>{archiveSessionTitle(session)}</h3><p>{session.summary || 'No summary is available yet.'}</p></div><div className="archive-session-side"><strong>{session.chatTurnCount ?? session.turnCount ?? 0}</strong><span>turns</span>{session.archived ? <em>Archived</em> : <em>Active</em>}</div></button>)}{sessionsHasMore ? <button type="button" className="archive-load-more" disabled={sessionsMoreLoading} onClick={() => void loadMoreSessions()}>{sessionsMoreLoading ? 'Loading more conversations…' : 'Load more conversations'}</button> : null}</div>
              </section>
              <section className="archive-reader-pane">
                <ChatArchiveReader session={selectedSession} detail={detail} loading={detailLoading} error={detailError} earlierLoading={earlierLoading} earlierError={earlierError} historyUnavailable={historyUnavailable} onLoadEarlier={loadEarlier} onRestart={() => setSelectedSession((current) => current ? { ...current } : null)} agentNames={agentNames} operatorName={operatorName} />
              </section>
            </div>
          ) : kind === 'dreams' ? (
            <div className="archive-split-view">
              <section className="archive-results-pane" aria-label="Dream diary groups">
                <div className="archive-pane-heading"><span className="eyebrow">Dreams</span><strong>{dreamGroups.length} dream groups</strong></div>
                {loading ? <p role="status">Loading conversations…</p> : null}
                {stale ? <p role="status">Showing stale cached conversations while revalidating.</p> : null}
                {error ? <div role="alert"><p>{error}</p><button type="button" onClick={() => setListRetry((value) => value + 1)}>Retry conversations</button></div> : null}
                {!loading && !error && !visibleSessions.length ? <p>No conversations match this shelf.</p> : null}
                <div className="archive-session-list">
                  {loading ? <section className="archive-empty-state"><div className="archive-empty-mark" aria-hidden="true">⌁</div><div><h3>Gathering the dreams.</h3><p>Opening the remembered things from your agents.</p></div></section> : null}
                  {error ? <section className="archive-empty-state archive-error"><div className="archive-empty-mark" aria-hidden="true">!</div><div><h3>Could not load the dream archive.</h3><p>{error}</p></div></section> : null}
                  {!loading && !error && !dreamGroups.length ? <section className="archive-empty-state"><div className="archive-empty-mark" aria-hidden="true">⌁</div><div><h3>No dreams match this shelf.</h3><p>Try adjusting the search, date, or agent filter.</p></div></section> : null}
                  {!loading && !error ? dreamGroups.map((group) => <button type="button" key={group.key} className={`archive-session-card${selectedDreamGroup?.key === group.key ? ' selected' : ''}`} onClick={() => setSelectedDreamGroup(group)}><div className="archive-session-main"><div className="archive-session-meta"><span>{group.agentName}</span><span>{formatArchiveDate(dreamDate(group.entries[0]))}</span></div><h3>{group.agentName} Dreams {formatDreamGroupDay(group.day)}</h3><p>{group.entries.length} remembered states: {group.entries.map((entry) => entry.phase).join(', ')}</p></div><div className="archive-session-side"><strong>{group.entries.length}</strong><span>states</span></div></button>) : null}
                  {error ? null : dreamsHasMore ? <button type="button" className="archive-load-more" disabled={dreamsMoreLoading} onClick={() => void loadMoreDreams()}>{dreamsMoreLoading ? 'Loading more dreams…' : 'Load more dreams'}</button> : null}
                </div>
              </section>
              <section className="archive-reader-pane">
                <DreamArchiveReader group={selectedDreamGroup} loading={dreamDetailLoading} error={dreamDetailError} />
              </section>
            </div>
          ) : kind === 'tiddle' ? (
            <div className="archive-split-view">
              <section className="archive-results-pane" aria-label="Tiddle warm cards">
                <div className="archive-pane-heading"><span className="eyebrow">Tiddle</span><strong>{tiddleGroups.length} warm cards</strong></div>
                {loading ? <p role="status">Loading conversations…</p> : null}
                {stale ? <p role="status">Showing stale cached conversations while revalidating.</p> : null}
                {error ? <div role="alert"><p>{error}</p><button type="button" onClick={() => setListRetry((value) => value + 1)}>Retry conversations</button></div> : null}
                {!loading && !error && !visibleSessions.length ? <p>No conversations match this shelf.</p> : null}
                <div className="archive-session-list">
                  {loading ? <section className="archive-empty-state"><div className="archive-empty-mark" aria-hidden="true">⌁</div><div><h3>Gathering warm cards.</h3><p>Opening Tiddle continuity.</p></div></section> : null}
                  {error ? <section className="archive-empty-state archive-error"><div className="archive-empty-mark" aria-hidden="true">!</div><div><h3>Could not load Tiddle.</h3><p>{error}</p></div></section> : null}
                  {!loading && !error && !tiddleGroups.length ? <section className="archive-empty-state"><div className="archive-empty-mark" aria-hidden="true">⌁</div><div><h3>No warm cards match this shelf.</h3><p>Try another search or agent.</p></div></section> : null}
                  {!loading && !error ? tiddleGroups.map(({ card }) => <button type="button" key={card.id} className={`archive-session-card tiddle-archive-card${selectedTiddleCard?.id === card.id && selectedTiddleCard.agentId === card.agentId ? ' selected' : ''}`} onClick={() => setSelectedTiddleCard(card)}><div className="archive-session-main"><div className="archive-session-meta"><span>{card.agentId}</span><span>{formatArchiveDate(card.lastSeen)}</span></div><h3>{card.title}</h3><p>{card.summary}</p></div><div className="archive-session-side"><strong>{card.recurrence}</strong><span>repeats</span><em>Warm</em></div></button>) : null}
                  {error ? null : tiddleHasMore ? <button type="button" className="archive-load-more" disabled={tiddleMoreLoading} onClick={() => void loadMoreTiddle()}>{tiddleMoreLoading ? 'Loading more cards…' : 'Load more cards'}</button> : null}
                </div>
              </section>
              <section className="archive-reader-pane">
                <TiddleArchiveReader group={selectedTiddle} loading={detailLoading} error={detailError} historyLoading={tiddleHistoryLoading} historyError={tiddleHistoryError} historyHasMore={tiddleHistoryHasMore} onLoadMoreHistory={() => void loadMoreTiddleHistory()} />
              </section>
            </div>
          ) : kind === 'proof' ? (
            <ArchiveRunsProof repository={archiveRepository} selectedAgent={selectedAgent} search={search} />
          ) : null}
        </main>
      </div>
    </div>
  );
}
