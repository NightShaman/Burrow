import { useEffect, useMemo, useRef, useState } from 'react';
import type { ArchiveRepository } from './archiveRepository';
import { dreamDate, filterDreamEntries, groupDreamEntries } from './archiveDerivations';
import { DreamArchiveReader, formatArchiveDate } from './ArchiveReaders';
import type { DreamEntry, DreamGroup } from './archiveTypes';

type ShelfProps = { archiveRepository: ArchiveRepository; selectedAgent: string; selectedDate: string; search: string; queryKey: string; onCount: (count: number) => void };

function formatDreamGroupDay(value: string) {
  const [year, month, day] = value.split('-');
  return month && day && year ? `${month}-${day}-${year}` : value;
}

export function DreamArchiveShelf({ archiveRepository, selectedAgent, selectedDate, search, queryKey, onCount }: ShelfProps) {
  const [dreamsCursor, setDreamsCursor] = useState<string | null>(null);
  const [dreamsHasMore, setDreamsHasMore] = useState(false);
  const [dreamsMoreLoading, setDreamsMoreLoading] = useState(false);
  const [selectedDreamGroup, setSelectedDreamGroup] = useState<DreamGroup | null>(null);
  const [dreams, setDreams] = useState<DreamEntry[]>([]);
  const [dreamsLoading, setDreamsLoading] = useState(false);
  const [dreamsRetry, setDreamsRetry] = useState(0);
  const [dreamDetailLoading, setDreamDetailLoading] = useState(false);
  const [dreamsError, setDreamsError] = useState('');
  const [dreamDetailError, setDreamDetailError] = useState('');
  const scopeRef = useRef(queryKey);
  scopeRef.current = queryKey;
  const moreRequests = useRef(new Set<AbortController>());
  useEffect(() => () => {
    moreRequests.current.forEach((request) => request.abort());
    moreRequests.current.clear();
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    const load = async () => {
      moreRequests.current.forEach((request) => request.abort()); moreRequests.current.clear();
      setDreamsCursor(null); setDreamsHasMore(false); setDreamsMoreLoading(false);
      setDreamsLoading(true); setDreamsError('');
      try {
        const page = await archiveRepository.listDreams(abort.signal, null, selectedDate || undefined, selectedAgent || undefined);
        if (!abort.signal.aborted) { setDreams(page.items); setDreamsCursor(page.nextCursor); setDreamsHasMore(page.hasMore); }
      } catch (cause) { if (!abort.signal.aborted) setDreamsError(cause instanceof Error ? cause.message : 'Could not load dream archive.'); }
      finally { if (!abort.signal.aborted) setDreamsLoading(false); }
    };
    void load();
    return () => abort.abort();
  }, [selectedDate, selectedAgent, search, queryKey, dreamsRetry, archiveRepository]);
  const loadMoreDreams = async () => {
    if (!dreamsHasMore || !dreamsCursor || dreamsMoreLoading || moreRequests.current.size) return;
    const scope = queryKey; const abort = new AbortController(); moreRequests.current.add(abort);
    const current = () => !abort.signal.aborted && scopeRef.current === scope;
    setDreamsMoreLoading(true);
    try { const date = selectedDate; const page = await archiveRepository.listDreams(abort.signal, dreamsCursor, date || undefined, selectedAgent || undefined); if (!current()) return; setDreams((current) => [...current, ...page.items]); setDreamsCursor(page.nextCursor); setDreamsHasMore(page.hasMore); }
    catch (cause) { if (current()) setDreamsError(cause instanceof Error ? cause.message : 'Could not load more dreams.'); }
    finally { moreRequests.current.delete(abort); if (current()) setDreamsMoreLoading(false); }
  };
  useEffect(() => {
    if (!selectedDreamGroup) return;
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
  }, [selectedDreamGroup?.key, archiveRepository]);
  const visibleDreams = useMemo(() => filterDreamEntries(dreams, '', search, selectedDate), [dreams, search, selectedDate]);
  const dreamGroups = useMemo<DreamGroup[]>(() => groupDreamEntries(visibleDreams), [visibleDreams]);
  useEffect(() => { onCount(dreams.length); }, [dreams.length, onCount]);

  return (
<div className="archive-split-view">
              <section className="archive-results-pane" aria-label="Dream diary groups">
                <div className="archive-pane-heading"><span className="eyebrow">Dreams</span><strong>{dreamGroups.length} dream groups</strong></div>
                {dreamsLoading ? <p role="status">Loading dreams…</p> : null}
                {dreamsError ? <div role="alert"><p>{dreamsError}</p><button type="button" onClick={() => setDreamsRetry((value) => value + 1)}>Retry dreams</button></div> : null}
                <div className="archive-session-list">
                  {dreamsLoading ? <section className="archive-empty-state"><div className="archive-empty-mark" aria-hidden="true">⌁</div><div><h3>Gathering the dreams.</h3><p>Opening the remembered things from your agents.</p></div></section> : null}
                  {dreamsError ? <section className="archive-empty-state archive-error"><div className="archive-empty-mark" aria-hidden="true">!</div><div><h3>Could not load the dream archive.</h3><p>{dreamsError}</p></div></section> : null}
                  {!dreamsLoading && !dreamsError && !dreamGroups.length ? <section className="archive-empty-state"><div className="archive-empty-mark" aria-hidden="true">⌁</div><div><h3>No dreams match this shelf.</h3><p>Try adjusting the search, date, or agent filter.</p></div></section> : null}
                  {!dreamsLoading && !dreamsError ? dreamGroups.map((group) => <button type="button" key={group.key} className={`archive-session-card${selectedDreamGroup?.key === group.key ? ' selected' : ''}`} onClick={() => setSelectedDreamGroup(group)}><div className="archive-session-main"><div className="archive-session-meta"><span>{group.agentName}</span><span>{formatArchiveDate(dreamDate(group.entries[0]))}</span></div><h3>{group.agentName} Dreams {formatDreamGroupDay(group.day)}</h3><p>{group.entries.length} remembered states: {group.entries.map((entry) => entry.phase).join(', ')}</p></div><div className="archive-session-side"><strong>{group.entries.length}</strong><span>states</span></div></button>) : null}
                  {dreamsError ? null : dreamsHasMore ? <button type="button" className="archive-load-more" disabled={dreamsMoreLoading} onClick={() => void loadMoreDreams()}>{dreamsMoreLoading ? 'Loading more dreams…' : 'Load more dreams'}</button> : null}
                </div>
              </section>
              <section className="archive-reader-pane">
                <DreamArchiveReader group={selectedDreamGroup} loading={dreamDetailLoading} error={dreamDetailError} />
              </section>
            </div>
  );
}
