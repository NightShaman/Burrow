import { useEffect, useRef, useState } from 'react';
import type { ArchiveRepository } from './archiveRepository';
import { DreamArchiveReader } from './ArchiveReaders';
import type { DreamArchiveGroup, DreamGroupSummary, DreamPhase } from './archiveTypes';

type ShelfProps = { archiveRepository: ArchiveRepository; selectedAgent: string; selectedDate: string; search: string; queryKey: string; onCount: (count: number) => void };
const phases: DreamPhase[] = ['light', 'deep', 'rem'];
const phaseName = (phase: DreamPhase) => phase === 'rem' ? 'REM' : phase === 'light' ? 'Light' : 'Deep';
const formatDay = (day: string) => {
  const [year, month, date] = day.split('-');
  return year && month && date ? `${month}-${date}-${year}` : day;
};
const identity = (group: DreamGroupSummary) => JSON.stringify([group.agentId, group.day, group.timezone]);
const unique = (groups: DreamGroupSummary[]) => [...new Map(groups.map(group => [identity(group), group])).values()];
const message = (cause: unknown) => cause instanceof Error ? cause.message : 'Could not load dream archive.';

export function DreamArchiveShelf(props: ShelfProps) {
  return <DreamShelf key={props.queryKey} {...props} />;
}
function DreamShelf({ archiveRepository, selectedAgent, selectedDate, search, onCount }: ShelfProps) {
  const [groups, setGroups] = useState<DreamGroupSummary[]>([]);
  const [selected, setSelected] = useState<DreamGroupSummary | null>(null);
  const [detail, setDetail] = useState<DreamArchiveGroup | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState('');
  const [moreError, setMoreError] = useState('');
  const [retry, setRetry] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState('');
  const [detailRetry, setDetailRetry] = useState(0);
  const moreRequest = useRef<AbortController | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    moreRequest.current?.abort(); moreRequest.current = null;
    setGroups([]); setSelected(null); setDetail(null); setCursor(null); setHasMore(false);
    setLoading(true); setMoreLoading(false); setError(''); setMoreError('');
    void archiveRepository.listDreams(abort.signal, null, selectedDate || undefined, selectedAgent || undefined, search)
      .then(page => { if (!abort.signal.aborted) { setGroups(unique(page.items)); setCursor(page.nextCursor); setHasMore(page.hasMore); } })
      .catch(cause => { if (!abort.signal.aborted) setError(message(cause)); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => { abort.abort(); moreRequest.current?.abort(); };
  }, [archiveRepository, selectedAgent, selectedDate, search, retry]);
  useEffect(() => { if (!loading && !error) onCount(groups.length); }, [groups.length, loading, error, onCount]);
  useEffect(() => {
    if (!selected) return;
    const abort = new AbortController();
    setDetail(null); setDetailLoading(true); setDetailError('');
    void archiveRepository.loadDreamGroup(selected, abort.signal)
      .then(group => { if (!abort.signal.aborted) setDetail(group); })
      .catch(cause => { if (!abort.signal.aborted) setDetailError(message(cause)); })
      .finally(() => { if (!abort.signal.aborted) setDetailLoading(false); });
    return () => abort.abort();
  }, [selected, detailRetry, archiveRepository]);
  const loadMore = async () => {
    if (!hasMore || !cursor || loading || moreRequest.current) return;
    const abort = new AbortController(); moreRequest.current = abort;
    setMoreLoading(true); setMoreError('');
    try {
      const page = await archiveRepository.listDreams(abort.signal, cursor, selectedDate || undefined, selectedAgent || undefined, search);
      if (abort.signal.aborted) return;
      setGroups(current => unique([...current, ...page.items])); setCursor(page.nextCursor); setHasMore(page.hasMore);
    } catch (cause) { if (!abort.signal.aborted) setMoreError(message(cause)); }
    finally { if (moreRequest.current === abort) moreRequest.current = null; if (!abort.signal.aborted) setMoreLoading(false); }
  };
  return <div className="archive-split-view">
    <section className="archive-results-pane" aria-label="Dream diary groups">
      <div className="archive-pane-heading"><span className="eyebrow">Dreams</span><strong>{groups.length} dream groups{hasMore ? ' loaded' : ''}</strong></div>
      {loading && <p role="status">Loading dreams…</p>}
      {error && <div role="alert"><p>{error}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Retry dreams</button></div>}
      {!loading && !error && !groups.length && <section className="archive-empty-state"><div className="archive-empty-mark" aria-hidden="true">⌁</div><div><h3>No dreams match this shelf.</h3><p>Try adjusting the search, date, or agent filter.</p></div></section>}
      <div className="archive-session-list">
        {groups.map(group => {
          const diaryCount = phases.reduce((count, phase) => count + group.phases[phase].diaryCount, group.otherDiaries.diaryCount);
          const recordedPhases = phases.filter(phase => group.phases[phase].diaryCount || group.phases[phase].attemptCount);
          const records = [
            ...recordedPhases.map(phaseName),
            ...(group.otherDiaries.diaryCount ? ['Other diaries'] : []),
            ...(group.cycleAttempts.count ? ['Cycle records'] : []),
          ];
          return <button type="button" key={identity(group)} className={`archive-session-card${selected && identity(selected) === identity(group) ? ' selected' : ''}`} aria-pressed={!!selected && identity(selected) === identity(group)} onClick={() => setSelected(group)}>
            <div className="archive-session-main"><div className="archive-session-meta"><span>{group.agentName}</span><span>{formatDay(group.day)}</span></div><h3>{group.agentName} Dreams {formatDay(group.day)}</h3><p>{diaryCount} retained {diaryCount === 1 ? 'diary' : 'diaries'}{records.length ? ` · ${records.join(', ')}` : ''}</p></div><div className="archive-session-side"><strong>{diaryCount}</strong><span>{diaryCount === 1 ? 'diary' : 'diaries'}</span></div>
          </button>;
        })}
        {moreError && <p role="alert">{moreError}</p>}
        {hasMore && cursor && <button type="button" className="archive-load-more" disabled={moreLoading} onClick={() => void loadMore()}>{moreLoading ? 'Loading more dreams…' : moreError ? 'Retry more dreams' : 'Load more dreams'}</button>}
      </div>
    </section>
    <section className="archive-reader-pane"><DreamArchiveReader group={detail} selected={selected} loading={detailLoading} error={detailError} onRetry={() => setDetailRetry(value => value + 1)} /></section>
  </div>;
}
