import { useEffect, useRef, useState } from 'react';
import type { ArchiveRepository } from './archiveRepository';
import { formatArchiveDate, TiddleArchiveReader } from './ArchiveReaders';
import type { ContinuityCard, ContinuityCardGroup } from './archiveTypes';

type ShelfProps = { archiveRepository: ArchiveRepository; selectedAgent: string; search: string; queryKey: string; onCount: (count: number) => void };


export function TiddleArchiveShelf({ archiveRepository, selectedAgent, search, queryKey, onCount }: ShelfProps) {
  const [tiddleCursor, setTiddleCursor] = useState<string | null>(null);
  const [tiddleHasMore, setTiddleHasMore] = useState(false);
  const [tiddleMoreLoading, setTiddleMoreLoading] = useState(false);
  const [tiddleHistoryCursor, setTiddleHistoryCursor] = useState<string | null>(null);
  const [tiddleHistoryHasMore, setTiddleHistoryHasMore] = useState(false);
  const [tiddleHistoryLoading, setTiddleHistoryLoading] = useState(false);
  const [tiddleHistoryError, setTiddleHistoryError] = useState('');
  const tiddleHistoryRequest = useRef<AbortController | null>(null);
  const [tiddleGroups, setTiddleGroups] = useState<ContinuityCardGroup[]>([]);
  const [selectedTiddleCard, setSelectedTiddleCard] = useState<ContinuityCard | null>(null);
  const [selectedTiddle, setSelectedTiddle] = useState<ContinuityCardGroup | null>(null);
  const [tiddleLoading, setTiddleLoading] = useState(false);
  const [tiddleRetry, setTiddleRetry] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tiddleError, setTiddleError] = useState('');
  const [detailError, setDetailError] = useState('');
  const scopeRef = useRef(queryKey);
  scopeRef.current = queryKey;
  const moreRequests = useRef(new Set<AbortController>());
  useEffect(() => () => {
    moreRequests.current.forEach((request) => request.abort());
    moreRequests.current.clear();
    tiddleHistoryRequest.current?.abort();
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    moreRequests.current.forEach((request) => request.abort()); moreRequests.current.clear();
    setTiddleCursor(null); setTiddleHasMore(false); setTiddleMoreLoading(false);
    setTiddleLoading(true); setTiddleError('');
    archiveRepository.listContinuityCards(selectedAgent, abort.signal).then((response) => {
      const cards = response.items.filter((card) => !search.trim() || `${card.title} ${card.summary}`.toLowerCase().includes(search.trim().toLowerCase()));
      if (!abort.signal.aborted) { setTiddleGroups(cards.map((card) => ({ card, history: [], nextCursor: null, hasMore: false }))); setTiddleCursor(response.nextCursor); setTiddleHasMore(response.hasMore); }
    }).catch((cause) => { if (!abort.signal.aborted) setTiddleError(cause instanceof Error ? cause.message : 'Could not load Tiddle cards.'); }).finally(() => { if (!abort.signal.aborted) setTiddleLoading(false); });
    return () => abort.abort();
  }, [search, selectedAgent, queryKey, tiddleRetry, archiveRepository]);
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
    if (!tiddleHasMore || !tiddleCursor || tiddleMoreLoading || moreRequests.current.size) return;
    const scope = queryKey; const abort = new AbortController(); moreRequests.current.add(abort);
    const current = () => !abort.signal.aborted && scopeRef.current === scope;
    setTiddleMoreLoading(true);
    try { const page = await archiveRepository.listContinuityCards(selectedAgent, abort.signal, tiddleCursor); if (!current()) return; const cards = page.items.filter((card) => !search.trim() || `${card.title} ${card.summary}`.toLowerCase().includes(search.trim().toLowerCase())); setTiddleGroups((current) => [...current, ...cards.map((card) => ({ card, history: [], nextCursor: null, hasMore: false }))]); setTiddleCursor(page.nextCursor); setTiddleHasMore(page.hasMore); }
    catch (cause) { if (current()) setTiddleError(cause instanceof Error ? cause.message : 'Could not load more cards.'); }
    finally { moreRequests.current.delete(abort); if (current()) setTiddleMoreLoading(false); }
  };
  useEffect(() => {
    if (!selectedTiddleCard) return;
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
  }, [selectedTiddleCard, queryKey, archiveRepository]);
  useEffect(() => { onCount(tiddleGroups.length); }, [tiddleGroups.length, onCount]);

  return (
<div className="archive-split-view">
              <section className="archive-results-pane" aria-label="Tiddle warm cards">
                <div className="archive-pane-heading"><span className="eyebrow">Tiddle</span><strong>{tiddleGroups.length} warm cards</strong></div>
                {tiddleLoading ? <p role="status">Loading warm cards…</p> : null}
                {tiddleError ? <div role="alert"><p>{tiddleError}</p><button type="button" onClick={() => setTiddleRetry((value) => value + 1)}>Retry warm cards</button></div> : null}
                <div className="archive-session-list">
                  {tiddleLoading ? <section className="archive-empty-state"><div className="archive-empty-mark" aria-hidden="true">⌁</div><div><h3>Gathering warm cards.</h3><p>Opening Tiddle continuity.</p></div></section> : null}
                  {tiddleError ? <section className="archive-empty-state archive-error"><div className="archive-empty-mark" aria-hidden="true">!</div><div><h3>Could not load Tiddle.</h3><p>{tiddleError}</p></div></section> : null}
                  {!tiddleLoading && !tiddleError && !tiddleGroups.length ? <section className="archive-empty-state"><div className="archive-empty-mark" aria-hidden="true">⌁</div><div><h3>No warm cards match this shelf.</h3><p>Try another search or agent.</p></div></section> : null}
                  {!tiddleLoading && !tiddleError ? tiddleGroups.map(({ card }) => <button type="button" key={card.id} className={`archive-session-card tiddle-archive-card${selectedTiddleCard?.id === card.id && selectedTiddleCard.agentId === card.agentId ? ' selected' : ''}`} onClick={() => setSelectedTiddleCard(card)}><div className="archive-session-main"><div className="archive-session-meta"><span>{card.agentId}</span><span>{formatArchiveDate(card.lastSeen)}</span></div><h3>{card.title}</h3><p>{card.summary}</p></div><div className="archive-session-side"><strong>{card.recurrence}</strong><span>repeats</span><em>Warm</em></div></button>) : null}
                  {tiddleError ? null : tiddleHasMore ? <button type="button" className="archive-load-more" disabled={tiddleMoreLoading} onClick={() => void loadMoreTiddle()}>{tiddleMoreLoading ? 'Loading more cards…' : 'Load more cards'}</button> : null}
                </div>
              </section>
              <section className="archive-reader-pane">
                <TiddleArchiveReader group={selectedTiddle} loading={detailLoading} error={detailError} historyLoading={tiddleHistoryLoading} historyError={tiddleHistoryError} historyHasMore={tiddleHistoryHasMore} onLoadMoreHistory={() => void loadMoreTiddleHistory()} />
              </section>
            </div>
  );
}
