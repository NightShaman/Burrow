import { useEffect, useMemo, useState } from 'react';
import { api } from '../../app/api';
import type { Agent } from '../../app/types';
import { taskArchiveDate } from '../tasks/TaskArchiveShelf';

type ForgeRecord = {
  id: string; jobId: string; connectionId: string; modelId: string; kind: string; mode?: string | null;
  prompt: string; status: string; createdAt: string; updatedAt: string; deletedAt?: string | null;
  agentId?: string | null; error?: string | null; calls?: unknown[]; outcome?: unknown;
};

export function ForgeArchiveShelf({ agents, selectedAgent, selectedDate, search, onDates }: {
  agents: Agent[]; selectedAgent: string; selectedDate: string; search: string; onDates: (dates: string[]) => void;
}) {
  const [records, setRecords] = useState<ForgeRecord[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    setLoading(true); setError('');
    void api<{ records: ForgeRecord[] }>('/api/archive/forge', { signal: abort.signal })
      .then(result => { if (!abort.signal.aborted) setRecords(result.records); })
      .catch(cause => { if (!abort.signal.aborted) setError(`Could not load Forge evidence: ${(cause as Error).message}`); })
      .finally(() => { if (!abort.signal.aborted) setLoading(false); });
    return () => abort.abort();
  }, [retry]);
  const agentId = agents.find(agent => agent.id === selectedAgent)?.resourceId ?? selectedAgent;
  const scoped = useMemo(() => records.filter(record => !agentId || record.agentId === agentId), [records, agentId]);
  useEffect(() => { onDates([...new Set(scoped.map(record => taskArchiveDate(record.createdAt)).filter(Boolean))]); }, [scoped, onDates]);
  const visible = scoped.filter(record => (!selectedDate || taskArchiveDate(record.createdAt) === selectedDate) &&
    (!search.trim() || [record.prompt, record.modelId, record.connectionId, record.status, record.jobId, record.error].join(' ').toLowerCase().includes(search.trim().toLowerCase())))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
  const selected = visible.find(record => record.id === selectedId);
  return <div className="archive-split-view forge-archive-shelf">
    <section className="archive-results-pane" aria-label="Forge execution evidence">
      <div className="archive-pane-heading"><span className="eyebrow">Forge</span><strong>{visible.length} runs</strong><button type="button" disabled={loading} onClick={() => setRetry(value => value + 1)}>Refresh</button></div>
      {loading && <p role="status">Loading Forge evidence…</p>}
      {error && <div role="alert"><p>{error}</p><button type="button" onClick={() => setRetry(value => value + 1)}>Retry Forge evidence</button></div>}
      <div className="archive-session-list">
        {!loading && !error && !visible.length && <section className="archive-empty-state"><h3>No Forge runs match.</h3></section>}
        {!loading && !error && visible.map(record => <button type="button" key={record.id} className={`archive-session-card${selected?.id === record.id ? ' selected' : ''}`} aria-pressed={selected?.id === record.id} onClick={() => setSelectedId(record.id)}>
          <div className="archive-session-main"><div className="archive-session-meta"><span>{record.mode ?? record.kind}</span><time dateTime={record.createdAt}>{new Date(record.createdAt).toLocaleString()}</time></div><h3>{record.modelId}</h3><p>{record.prompt}</p></div><div className="archive-session-side"><span>{record.status}</span>{record.deletedAt && <em>Deleted</em>}</div>
        </button>)}
      </div>
    </section>
    <section className="archive-reader-pane" aria-label="Forge run details">
      {selected && !loading && !error ? <>
        <header className="archive-reader-toolbar"><div><h2>{selected.modelId}</h2><p>{selected.status} · {new Date(selected.createdAt).toLocaleString()}</p></div></header>
        <div className="archive-content-body"><div className="archive-reader forge-evidence-reader">
          {selected.deletedAt && <p className="proof-muted">Job and media deleted from Forge on {new Date(selected.deletedAt).toLocaleString()}.</p>}
          <h3>Prompt</h3><p className="forge-evidence-prompt">{selected.prompt}</p>
          <dl className="tiddle-card-details"><div><dt>Job</dt><dd>{selected.jobId}</dd></div><div><dt>Connection</dt><dd>{selected.connectionId}</dd></div></dl>
          <h3>Outcome</h3>{selected.error && <p>{selected.error}</p>}<pre>{JSON.stringify(selected.outcome ?? { status: selected.status }, null, 2)}</pre>
          {selected.calls?.length ? <><h3>Calls</h3><pre>{JSON.stringify(selected.calls, null, 2)}</pre></> : null}
        </div></div>
      </> : <div className="archive-reader-empty"><h3>Select a Forge run</h3></div>}
    </section>
  </div>;
}
