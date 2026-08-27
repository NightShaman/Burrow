import { useEffect, useMemo, useState } from 'react';
import type { Agent } from '../../app/types';
import { ArchiveRunsProof } from './ArchiveRunsProof';
import { readArchiveDetailCache, readArchiveSessionCache, writeArchiveDetailCache, writeArchiveSessionCache } from './archiveCache';
import { archiveRepository } from './archiveRepository';
import { archiveSessionDate, buildCalendarDays, buildDateBuckets, dateFromMonthKey, dreamDate, filterArchiveSessions, filterDreamEntries, groupDreamEntries, monthKey } from './archiveDerivations';
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
  const [selectedTiddleCard, setSelectedTiddleCard] = useState<ContinuityCard | null>(null);
  const [selectedTiddle, setSelectedTiddle] = useState<ContinuityCardGroup | null>(null);
  const [detail, setDetail] = useState<ArchiveDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [dreamDetailLoading, setDreamDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [dreamDetailError, setDreamDetailError] = useState('');

  useEffect(() => {
    const abort = new AbortController();
    archiveRepository.listContinuityCards(selectedAgent, abort.signal)
      .then((cards) => { if (!abort.signal.aborted) setTiddleCount(cards.length); })
      .catch(() => { if (!abort.signal.aborted) setTiddleCount(null); });
    return () => abort.abort();
  }, [selectedAgent]);

  useEffect(() => {
    if (kind !== 'tiddle') return;
    const abort = new AbortController();
    setLoading(true); setError('');
    archiveRepository.listContinuityCards(selectedAgent, abort.signal).then((response) => {
      const cards = response.filter((card) => !search.trim() || `${card.title} ${card.summary}`.toLowerCase().includes(search.trim().toLowerCase()));
      if (!abort.signal.aborted) setTiddleGroups(cards.map((card) => ({ card, history: [] })));
    }).catch((cause) => { if (!abort.signal.aborted) setError(cause instanceof Error ? cause.message : 'Could not load Tiddle cards.'); }).finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [kind, search, selectedAgent]);

  useEffect(() => {
    const abort = new AbortController();
    const load = async () => {
      setLoading(true); setError('');
      try {
        const entries = await archiveRepository.listDreams(abort.signal);
        if (!abort.signal.aborted) setDreams(entries);
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
      archiveRepository.listSessions(query, abort.signal)
        .then((nextSessions) => {
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
    archiveRepository.loadSession(selectedSession, abort.signal)
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
    setSelectedTiddle(null);
    setDetailLoading(true);
    setDetailError('');
    archiveRepository.loadContinuityCard(selectedTiddleCard, abort.signal)
      .then((nextDetail) => { if (!abort.signal.aborted) setSelectedTiddle(nextDetail); })
      .catch((cause) => { if (!abort.signal.aborted) setDetailError(cause instanceof Error ? cause.message : 'Could not load continuity card.'); })
      .finally(() => { if (!abort.signal.aborted) setDetailLoading(false); });
    return () => abort.abort();
  }, [kind, selectedTiddleCard]);

  const agentSessions = useMemo(() => filterArchiveSessions(sessions, selectedAgent, ''), [selectedAgent, sessions]);
  const visibleSessions = useMemo(() => filterArchiveSessions(sessions, selectedAgent, selectedDate), [selectedAgent, selectedDate, sessions]);
  const agentDreams = useMemo(() => filterDreamEntries(dreams, selectedAgent, search), [dreams, search, selectedAgent]);
  const visibleDreams = useMemo(() => filterDreamEntries(dreams, selectedAgent, search, selectedDate), [dreams, search, selectedAgent, selectedDate]);
  const dreamGroups = useMemo<DreamGroup[]>(() => groupDreamEntries(visibleDreams), [visibleDreams]);
  const dateBuckets = useMemo(() => buildDateBuckets(kind, agentSessions, agentDreams), [agentDreams, agentSessions, kind]);
  const [calendarMonth, setCalendarMonth] = useState(() => monthKey(new Date()));
  const calendarDays = useMemo(() => buildCalendarDays(calendarMonth, dateBuckets), [calendarMonth, dateBuckets]);
  const calendarLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(dateFromMonthKey(calendarMonth));
  const handleKindChange = (nextKind: ArchiveKind) => {
    setKind(nextKind);
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
                <ChatArchiveReader session={selectedSession} detail={detail} loading={detailLoading} error={detailError} />
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
                  {!loading && !error ? dreamGroups.map((group) => <button type="button" key={group.key} className={`archive-session-card${selectedDreamGroup?.key === group.key ? ' selected' : ''}`} onClick={() => setSelectedDreamGroup(group)}><div className="archive-session-main"><div className="archive-session-meta"><span>{group.agentName}</span><span>{formatArchiveDate(dreamDate(group.entries[0]))}</span></div><h3>{group.agentName} Dreams {formatDreamGroupDay(group.day)}</h3><p>{group.entries.length} remembered states: {group.entries.map((entry) => entry.phase).join(', ')}</p></div><div className="archive-session-side"><strong>{group.entries.length}</strong><span>states</span></div></button>) : null}
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
                <div className="archive-session-list">
                  {loading ? <section className="archive-empty-state"><div className="archive-empty-mark" aria-hidden="true">⌁</div><div><h3>Gathering warm cards.</h3><p>Opening Tiddle continuity.</p></div></section> : null}
                  {error ? <section className="archive-empty-state archive-error"><div className="archive-empty-mark" aria-hidden="true">!</div><div><h3>Could not load Tiddle.</h3><p>{error}</p></div></section> : null}
                  {!loading && !error && !tiddleGroups.length ? <section className="archive-empty-state"><div className="archive-empty-mark" aria-hidden="true">⌁</div><div><h3>No warm cards match this shelf.</h3><p>Try another search or agent.</p></div></section> : null}
                  {!loading && !error ? tiddleGroups.map(({ card }) => <button type="button" key={card.id} className={`archive-session-card tiddle-archive-card${selectedTiddleCard?.id === card.id && selectedTiddleCard.agentId === card.agentId ? ' selected' : ''}`} onClick={() => setSelectedTiddleCard(card)}><div className="archive-session-main"><div className="archive-session-meta"><span>{card.agentId}</span><span>{formatArchiveDate(card.lastSeen)}</span></div><h3>{card.title}</h3><p>{card.summary}</p></div><div className="archive-session-side"><strong>{card.recurrence}</strong><span>repeats</span><em>Warm</em></div></button>) : null}
                </div>
              </section>
              <section className="archive-reader-pane">
                <TiddleArchiveReader group={selectedTiddle} loading={detailLoading} error={detailError} />
              </section>
            </div>
          ) : kind === 'proof' ? (
            <ArchiveRunsProof selectedAgent={selectedAgent} search={search} />
          ) : null}
        </main>
      </div>
    </div>
  );
}
