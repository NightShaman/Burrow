import { useEffect, useRef, useState } from 'react';
import type { ArchiveRepository } from './archiveRepository';
import type { ArchiveWorkflowEvent } from './archiveTypes';

type ShelfProps = {
  archiveRepository: ArchiveRepository; selectedAgent: string; selectedDate: string;
  search: string; queryKey: string; agentNames: Map<string, string>;
};

// Never turn event-controlled text into HTML, Markdown, or an arbitrary external link.
export function workflowArchiveRunUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com' && !url.username && !url.password && !url.port &&
      /^\/[^/]+\/[^/]+\/actions\/runs\/\d+(?:\/attempts\/\d+)?\/?$/.test(url.pathname) && !url.search && !url.hash ? url.href : undefined;
  } catch { return undefined; }
}

function eventTime(value?: string | null) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}
function resultText(value: unknown): string {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value, null, 2) ?? '—'; } catch { return 'Result unavailable.'; }
}
const identity = (event: ArchiveWorkflowEvent) => JSON.stringify([event.agentId, event.id]);
const message = (cause: unknown) => cause instanceof Error ? cause.message : 'Could not load workflow events.';
function uniqueEvents(items: ArchiveWorkflowEvent[]) {
  return [...new Map(items.map(event => [identity(event), event])).values()];
}

export function WorkflowEventsArchiveShelf(props: ShelfProps) {
  // Filters own both selection and every request (including pagination) even when
  // the transport ignores AbortSignal. No event payloads are cached in storage.
  return <WorkflowEventsShelf key={props.queryKey} {...props} />;
}
function WorkflowEventsShelf({ archiveRepository, selectedAgent, selectedDate, search, agentNames }: ShelfProps) {
  const [events, setEvents] = useState<ArchiveWorkflowEvent[]>([]);
  const [selectedKey, setSelectedKey] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [moreLoading, setMoreLoading] = useState(false);
  const [error, setError] = useState('');
  const [moreError, setMoreError] = useState('');
  const [retry, setRetry] = useState(0);
  const moreRequest = useRef<AbortController | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    moreRequest.current?.abort(); moreRequest.current = null;
    setEvents([]); setSelectedKey(''); setCursor(null); setHasMore(false);
    setLoading(true); setMoreLoading(false); setError(''); setMoreError('');
    const timer = window.setTimeout(() => {
      archiveRepository.listWorkflowEvents(search.trim(), abort.signal, null, selectedDate || undefined, selectedAgent || undefined)
        .then(page => {
          if (abort.signal.aborted) return;
          setEvents(uniqueEvents(page.items)); setCursor(page.nextCursor); setHasMore(page.hasMore);
        })
        .catch(cause => { if (!abort.signal.aborted) setError(message(cause)); })
        .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    }, 180);
    return () => { abort.abort(); window.clearTimeout(timer); moreRequest.current?.abort(); };
  }, [archiveRepository, selectedAgent, selectedDate, search, retry]);

  const loadMore = async () => {
    if (!hasMore || !cursor || moreRequest.current || loading) return;
    const abort = new AbortController(); moreRequest.current = abort;
    setMoreLoading(true); setMoreError('');
    try {
      const page = await archiveRepository.listWorkflowEvents(search.trim(), abort.signal, cursor, selectedDate || undefined, selectedAgent || undefined);
      if (abort.signal.aborted) return;
      setEvents(current => uniqueEvents([...current, ...page.items]));
      setCursor(page.nextCursor); setHasMore(page.hasMore);
    } catch (cause) { if (!abort.signal.aborted) setMoreError(message(cause)); }
    finally {
      if (moreRequest.current === abort) moreRequest.current = null;
      if (!abort.signal.aborted) setMoreLoading(false);
    }
  };
  const selected = events.find(event => identity(event) === selectedKey);
  const agentName = (event: ArchiveWorkflowEvent) => event.agentName || agentNames.get(event.agentId) || event.agentId || 'Unknown agent';
  const runUrl = selected ? workflowArchiveRunUrl(selected.url) : undefined;

  return <div className="archive-split-view">
    <section className="archive-results-pane" aria-label="Archived workflow events">
      <div className="archive-pane-heading"><span className="eyebrow">Workflow Events</span><strong>{events.length} events{hasMore ? ' loaded' : ''}</strong></div>
      {loading && <p role="status">Loading workflow events…</p>}
      {error && <div role="alert"><p>{error}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Retry workflow events</button></div>}
      {!loading && !error && !events.length && <p>No workflow events match this shelf.</p>}
      <div className="archive-session-list">
        {events.map(event => <button type="button" key={identity(event)} className={`archive-session-card${selectedKey === identity(event) ? ' selected' : ''}`} aria-pressed={selectedKey === identity(event)} onClick={() => setSelectedKey(identity(event))}>
          <div className="archive-session-main"><div className="archive-session-meta"><span>{agentName(event)}</span><span>Received {eventTime(event.createdAt)}</span></div><h3>{event.workflow || 'Workflow event'}</h3><p>{event.repository} · Run #{event.runId} · attempt {event.runAttempt}</p><p>GitHub: {event.conclusion || 'unknown'}</p></div>
          <div className="archive-session-side"><span>Burrow handling</span><em>{event.status || 'unknown'}</em></div>
        </button>)}
        {moreError && <p role="alert">{moreError}</p>}
        {hasMore && cursor && <button type="button" className="archive-load-more" disabled={moreLoading} onClick={() => void loadMore()}>{moreLoading ? 'Loading more workflow events…' : moreError ? 'Retry more workflow events' : 'Load more workflow events'}</button>}
      </div>
    </section>
    <section className="archive-reader-pane" aria-label="Workflow event details">
      {!selected ? <p className="archive-reader-empty">Select a workflow event to read its retained details.</p> : <>
        <div className="archive-reader-toolbar"><div><span className="eyebrow">Workflow Event</span><h2>{selected.workflow || 'Workflow event'}</h2><p>{selected.repository} · {agentName(selected)}</p></div></div>
        <div className="archive-content-body workflow-archive-details">
          <dl className="tiddle-card-details">
            {[
              ['GitHub conclusion', selected.conclusion || 'unknown'], ['Burrow handling', selected.status || 'unknown'],
              ['GitHub run', `#${selected.runId} · attempt ${selected.runAttempt}`], ['Commit', selected.headSha],
              ['Agent', agentName(selected)], ['Destination session', selected.sessionId],
              ['Event ID', selected.id], ['Watch ID', selected.watchId], ['Burrow run', selected.chatRunId || '—'],
              ['Completed', eventTime(selected.completedAt)], ['Received', eventTime(selected.createdAt)],
              ['Started', eventTime(selected.startedAt)], ['Finished', eventTime(selected.finishedAt)],
            ].map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value || '—'}</dd></div>)}
          </dl>
          {runUrl && <p><a href={runUrl} target="_blank" rel="noopener noreferrer">Open GitHub run #{selected.runId}</a></p>}
          <h3>Instruction</h3><pre>{selected.instruction || 'No instruction retained.'}</pre>
          {selected.error && <><h3>Error</h3><pre>{selected.error}</pre></>}
          {selected.result != null && <><h3>Result</h3><pre>{resultText(selected.result)}</pre></>}
        </div>
      </>}
    </section>
  </div>;
}
