import { loadModArchives, modsChangedEvent, type ModArchive } from '../../app/modPanels';
import { ModArchiveHost } from '../mods/ModArchiveHost';
import { useEffect, useMemo, useState } from 'react';
import type { Agent } from '../../app/types';
import { ArchiveRunsProof } from './ArchiveRunsProof';
import { archiveQueryCacheKey } from './archiveCache';
import { createArchiveRepository, type ArchiveRepository, type ArchiveCalendarKind } from './archiveRepository';
import { buildCalendarDays, dateFromMonthKey, monthKey } from './archiveDerivations';
import type { ArchiveKind } from './archiveTypes';
import { ChatArchiveShelf } from './ChatArchiveShelf';
import { DreamArchiveShelf } from './DreamArchiveShelf';
import { TiddleArchiveShelf } from './TiddleArchiveShelf';
const archiveKinds: { id: ArchiveKind; label: string; detail: string }[] = [
  { id: 'chat', label: 'Chat', detail: 'Searchable conversations and session history.' },
  { id: 'dreams', label: 'Dreams', detail: 'Small remembered things from your agents.' },
  { id: 'tiddle', label: 'Tiddle', detail: 'Warm continuity cards and their history.' },
  { id: 'proof', label: 'Proof', detail: 'Operator-readable run outcomes and evidence.' },
];

export function Archive({ agents, operatorName = 'Operator', repository }: { agents: Agent[]; operatorName?: string; repository?: ArchiveRepository }) {
  const archiveRepository = useMemo(() => {
    const base = repository ?? createArchiveRepository();
    return base;
  }, [repository]);
  const cacheOwner = 'local';
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
  const [selectedDate, setSelectedDate] = useState('');
  const [search, setSearch] = useState('');
  const queryKey = archiveQueryCacheKey({ target: cacheOwner, agent: selectedAgent, query: search, date: selectedDate, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, kind });
  const [chatCount, setChatCount] = useState<number | null>(null);
  const [dreamCount, setDreamCount] = useState<number | null>(null);
  const [tiddleCount, setTiddleCount] = useState<number | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(() => monthKey(new Date()));
  const [calendarDates, setCalendarDates] = useState<string[]>([]);
  const [calendarAvailabilityState, setCalendarAvailabilityState] = useState<'loading' | 'ready' | 'error'>('loading');
  const calendarKind: ArchiveCalendarKind | null = activeMod ? null : kind === 'chat' ? 'sessions' : kind === 'dreams' ? 'dreams' : null;
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
  }, [calendarKind, calendarMonth, selectedAgent, archiveRepository]);
  const dateBuckets = useMemo(() => calendarDates.map((key) => ({ key, count: 1, year: '', month: '', day: '', label: '' })), [calendarDates]);
  const calendarDays = useMemo(() => buildCalendarDays(calendarMonth, dateBuckets), [calendarMonth, dateBuckets]);
  const availableDates = useMemo(() => new Set(calendarDates), [calendarDates]);
  const calendarLabel = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(dateFromMonthKey(calendarMonth));
  return (
    <div className="page-view archive-page">
      <header className="archive-heading">
        <div><h1>Archive</h1><p>Conversations and small remembered things, organized for later.</p></div>
        <div className="archive-heading-tools" hidden={Boolean(activeMod)}><label className="archive-search"><span className="sr-only">Search archive</span><input type="search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={kind === 'chat' ? 'Search conversations' : kind === 'proof' ? 'Search proof runs' : 'Search dreams'} /></label><label className="archive-agent-filter"><span className="sr-only">Filter by agent</span><select value={selectedAgent} onChange={(event) => { setSelectedAgent(event.target.value); setSelectedDate(''); }}><option value="">All agents</option>{agents.map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label></div>
      </header>
      <div className="archive-layout">
        <aside className="archive-sidebar" aria-label="Archive navigation">
          <section><span className="archive-sidebar-label">Browse</span>{archiveKinds.map((item) => <button key={item.id} type="button" className={!activeMod && kind === item.id ? 'active' : ''} onClick={() => { setModId(''); setKind(item.id); }}><span>{item.label}</span><span className="archive-count">{item.id === 'dreams' ? dreamCount ?? '—' : item.id === 'tiddle' ? tiddleCount ?? '—' : item.id === 'proof' ? 'Runs' : chatCount ?? '—'}</span></button>)}</section>
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
            <ChatArchiveShelf key={queryKey} archiveRepository={archiveRepository} selectedAgent={selectedAgent} selectedDate={selectedDate} search={search} queryKey={queryKey} onCount={setChatCount} agentNames={agentNames} operatorName={operatorName} />
          ) : kind === 'dreams' ? (
            <DreamArchiveShelf key={queryKey} archiveRepository={archiveRepository} selectedAgent={selectedAgent} selectedDate={selectedDate} search={search} queryKey={queryKey} onCount={setDreamCount} />
          ) : kind === 'tiddle' ? (
            <TiddleArchiveShelf key={queryKey} archiveRepository={archiveRepository} selectedAgent={selectedAgent} search={search} queryKey={queryKey} onCount={setTiddleCount} />
          ) : <ArchiveRunsProof repository={archiveRepository} selectedAgent={selectedAgent} search={search} />}
        </main>
      </div>
    </div>
  );
}
