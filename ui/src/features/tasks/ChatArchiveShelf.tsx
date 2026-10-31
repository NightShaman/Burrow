import { useEffect, useMemo, useRef, useState } from 'react';
import { archiveCacheInvalidated, readArchiveSessionCache, writeArchiveSessionCache } from './archiveCache';
import type { ArchiveRepository } from './archiveRepository';
import { filterArchiveSessions } from './archiveDerivations';
import { archiveSessionContext, archiveSessionTitle, ChatArchiveReader } from './ArchiveReaders';
import { mergeArchiveTurns } from './archiveTurns';
import type { ArchiveDetail, ArchiveSession } from './archiveTypes';

type ShelfProps = { archiveRepository: ArchiveRepository; selectedAgent: string; selectedDate: string; search: string; queryKey: string; onCount: (count: number) => void; agentNames: Map<string, string>; operatorName: string };


export function ChatArchiveShelf({ archiveRepository, selectedAgent, selectedDate, search, queryKey, onCount, agentNames, operatorName }: ShelfProps) {
  const [sessions, setSessions] = useState<ArchiveSession[]>([]);
  const [sessionsCursor, setSessionsCursor] = useState<string | null>(null);
  const [sessionsHasMore, setSessionsHasMore] = useState(false);
  const [sessionsMoreLoading, setSessionsMoreLoading] = useState(false);
  const [selectedSession, setSelectedSession] = useState<ArchiveSession | null>(null);
  const [detail, setDetail] = useState<ArchiveDetail | null>(null);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatStale, setChatStale] = useState(false);
  const [chatRetry, setChatRetry] = useState(0);
  const [detailLoading, setDetailLoading] = useState(false);
  const [earlierLoading, setEarlierLoading] = useState(false);
  const [earlierError, setEarlierError] = useState('');
  const [historyUnavailable, setHistoryUnavailable] = useState(false);
  const earlierAbort = useRef<AbortController | null>(null);
  const loadingEarlier = useRef(false);
  const selectionRef = useRef('');
  const [chatError, setChatError] = useState('');
  const [detailError, setDetailError] = useState('');
  const scopeRef = useRef(queryKey);
  scopeRef.current = queryKey;
  const moreRequests = useRef(new Set<AbortController>());
  useEffect(() => () => {
    moreRequests.current.forEach((request) => request.abort());
    moreRequests.current.clear();
    earlierAbort.current?.abort();
  }, []);
  useEffect(() => {
    const invalidate = () => { setSessions([]); setSelectedSession(null); setDetail(null); setChatRetry((value) => value + 1); };
    window.addEventListener(archiveCacheInvalidated, invalidate);
    return () => window.removeEventListener(archiveCacheInvalidated, invalidate);
  }, []);
  useEffect(() => {
    const abort = new AbortController();
    moreRequests.current.forEach((request) => request.abort()); moreRequests.current.clear();
    setSessionsCursor(null); setSessionsHasMore(false); setSessionsMoreLoading(false);
    const query = search.trim();
    const cached = readArchiveSessionCache(queryKey);
    setSessions(cached?.sessions ?? []);
    setChatStale(Boolean(cached)); setChatLoading(true); setChatError('');
    const timer = window.setTimeout(() => {
      if (!cached) setChatLoading(true);
      setChatError('');
      archiveRepository.listSessions(query, abort.signal, null, selectedDate || undefined, selectedAgent || undefined)
        .then((page) => {
          if (abort.signal.aborted) return;
          setChatStale(false); setSessions(page.items); setSessionsCursor(page.nextCursor); setSessionsHasMore(page.hasMore);
          writeArchiveSessionCache(queryKey, page.items);
        })
        .catch((nextError: Error) => { if (!abort.signal.aborted) setChatError(nextError.message || 'Could not load archive sessions.'); })
        .finally(() => { if (!abort.signal.aborted) setChatLoading(false); });
    }, cached ? 0 : 180);
    return () => { abort.abort(); window.clearTimeout(timer); };
  }, [search, selectedDate, selectedAgent, queryKey, chatRetry, archiveRepository]);

  useEffect(() => {
    const abort = new AbortController();
    earlierAbort.current?.abort();
    loadingEarlier.current = false;
    const identity = selectedSession ? `${selectedSession.agentId}:${selectedSession.sessionId}:${selectedDate}` : '';
    selectionRef.current = identity;
    setDetail(null);
    setEarlierError('');
    setHistoryUnavailable(false);
    setEarlierLoading(false);
    if (!identity || !selectedSession) { setDetailLoading(false); return () => abort.abort(); }
    setDetailError('');
    setDetailLoading(true);
    archiveRepository.loadSession(selectedSession, abort.signal, undefined, selectedDate || undefined)
      .then((page) => { if (!abort.signal.aborted && selectionRef.current === identity) { setDetail(page); setHistoryUnavailable(page.historyStatus === 'unavailable'); } })
      .catch((cause: Error) => { if (!abort.signal.aborted && selectionRef.current === identity) setDetailError(cause.message || 'Could not load this conversation.'); })
      .finally(() => { if (!abort.signal.aborted && selectionRef.current === identity) setDetailLoading(false); });
    return () => { abort.abort(); if (selectionRef.current === identity) selectionRef.current = ''; earlierAbort.current?.abort(); };
  }, [selectedSession, selectedDate, archiveRepository]);
  const loadMoreSessions = async () => {
    if (!sessionsHasMore || !sessionsCursor || sessionsMoreLoading || moreRequests.current.size) return;
    const scope = queryKey; const abort = new AbortController(); moreRequests.current.add(abort);
    const current = () => !abort.signal.aborted && scopeRef.current === scope;
    const query = search.trim(); setSessionsMoreLoading(true); setChatError('');
    try { const date = selectedDate; const page = await archiveRepository.listSessions(query, abort.signal, sessionsCursor, date || undefined, selectedAgent || undefined); if (!current()) return; setSessions((current) => [...current, ...page.items]); setSessionsCursor(page.nextCursor); setSessionsHasMore(page.hasMore); }
    catch (cause) { if (current()) setChatError(cause instanceof Error ? cause.message : 'Could not load more conversations.'); }
    finally { moreRequests.current.delete(abort); if (current()) setSessionsMoreLoading(false); }
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
    archiveRepository.loadSession(selectedSession, abort.signal, cursor, selectedDate || undefined)
      .then((page) => {
        if (abort.signal.aborted || selectionRef.current !== identity) return;
        setDetail((current) => {
          if (!current || current.nextCursor !== cursor) return current;
          const existing = current.session?.turns || current.turns || current.chatTurns || [];
          const incoming = page.session?.turns || page.turns || page.chatTurns || [];
          const merged = mergeArchiveTurns(existing, incoming);
          return { ...current, turns: merged, chatTurns: undefined, session: undefined, hasMore: page.hasMore, nextCursor: page.nextCursor, historyStatus: page.historyStatus };
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
  const visibleSessions = useMemo(() => filterArchiveSessions(sessions, '', selectedDate), [selectedDate, sessions]);
  useEffect(() => { onCount(sessions.length); }, [sessions.length, onCount]);

  return (
<div className="archive-split-view">
              <section className="archive-results-pane" aria-label="Archived conversations">
                <div className="archive-pane-heading"><span className="eyebrow">Chat</span><strong>{visibleSessions.length} conversations</strong></div>
                {chatLoading ? <p role="status">Loading conversations…</p> : null}
                {chatStale ? <p role="status">Showing stale cached conversations while revalidating.</p> : null}
                {chatError ? <div role="alert"><p>{chatError}</p><button type="button" onClick={() => setChatRetry((value) => value + 1)}>Retry conversations</button></div> : null}
                {!chatLoading && !chatError && !visibleSessions.length ? <p>No conversations match this shelf.</p> : null}
                <div className="archive-session-list">{visibleSessions.map((session) => <button type="button" key={`${session.agentId || 'agent'}:${session.sessionId}`} className={`archive-session-card${selectedSession && session.sessionId === selectedSession.sessionId && session.agentId === selectedSession.agentId ? ' selected' : ''}`} onClick={() => { selectionRef.current = ""; earlierAbort.current?.abort(); setSelectedSession({ ...session }); }}><div className="archive-session-main"><div className="archive-session-meta"><span>{session.agentName || session.agentId || 'Unknown agent'}</span><span>{archiveSessionContext(session)}</span></div><h3>{archiveSessionTitle(session)}</h3><p>{session.summary || 'No summary is available yet.'}</p></div><div className="archive-session-side"><strong>{session.chatTurnCount ?? session.turnCount ?? 0}</strong><span>turns</span>{session.archived ? <em>Archived</em> : <em>Active</em>}</div></button>)}{sessionsHasMore ? <button type="button" className="archive-load-more" disabled={sessionsMoreLoading} onClick={() => void loadMoreSessions()}>{sessionsMoreLoading ? 'Loading more conversations…' : 'Load more conversations'}</button> : null}</div>
              </section>
              <section className="archive-reader-pane">
                {selectedDate && detail && !(detail.session?.turns || detail.turns || detail.chatTurns || []).length && !detailLoading && !detailError ? <p role="status">No retained messages on {selectedDate}. This conversation may match its creation, update, or archive date.</p> : null}
                <ChatArchiveReader session={selectedSession} detail={detail} loading={detailLoading} error={detailError} earlierLoading={earlierLoading} earlierError={earlierError} historyUnavailable={historyUnavailable} onLoadEarlier={loadEarlier} onRestart={() => setSelectedSession((current) => current ? { ...current } : null)} agentNames={agentNames} operatorName={operatorName} attachmentAgentId={selectedSession?.agentId ?? undefined} />
              </section>
            </div>
  );
}
