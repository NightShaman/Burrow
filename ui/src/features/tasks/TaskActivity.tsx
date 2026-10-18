import { useEffect, useRef, useState } from 'react';
import { api, fetchApi, jsonMutation } from '../../app/api';
import { useConfirm } from '../../app/ConfirmDialog';

type Actor = { type: string; id: string | null; name: string | null };
type Attachment = { id: string; name: string; size: number; createdAt: string; createdBy: Actor };
type TaskEvent = { id: string; action: string; actor: Actor; at: string; changes: Record<string, unknown>; details: Record<string, unknown>; sessionId: string | null; runId: string | null };
type History = { events: TaskEvent[]; hasMore: boolean; nextCursor: string | null };
const who = (actor: Actor) => actor.name || actor.id || (actor.type === 'unknown' ? 'Unknown actor' : actor.type);
const date = (value: string) => new Date(value).toLocaleString();
const valueText = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value) ?? '—';

/** Keyed by task ID at the editor boundary so responses cannot leak into another task. */
export function TaskActivity({ taskId, revision }: { taskId: string; revision: string }) {
  const confirm = useConfirm();
  const base = `/api/task-board/tasks/${encodeURIComponent(taskId)}`;
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [history, setHistory] = useState<History>({ events: [], hasMore: false, nextCursor: null });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mounted = useRef(true);
  const generation = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; generation.current++; }; }, []);

  async function refresh() {
    const request = ++generation.current;
    setLoading(true); setError('');
    try {
      const [files, events] = await Promise.all([api<{ attachments: Attachment[] }>(`${base}/attachments`), api<History>(`${base}/history?limit=50`)]);
      if (mounted.current && request === generation.current) { setAttachments(files.attachments ?? []); setHistory({ events: events.events ?? [], hasMore: !!events.hasMore, nextCursor: events.nextCursor }); }
    } catch (e) { if (mounted.current && request === generation.current) setError(`Could not load task activity: ${(e as Error).message}`); }
    finally { if (mounted.current && request === generation.current) setLoading(false); }
  }
  useEffect(() => { void refresh(); }, [taskId, revision]);

  async function perform(action: () => Promise<void>) {
    setBusy(true); setError('');
    try { await action(); } catch (e) { if (mounted.current) setError((e as Error).message); }
    finally { if (mounted.current) setBusy(false); }
  }
  async function upload(file: File) {
    await perform(async () => {
      const content = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('Could not read the file.')); reader.readAsDataURL(file); });
      await api(`${base}/attachments`, jsonMutation('POST', { name: file.name, mimeType: file.type || 'application/octet-stream', content }));
      if (mounted.current) await refresh();
    });
  }
  async function older() {
    const request = generation.current;
    await perform(async () => {
      const page = await api<History>(`${base}/history?limit=50&before=${encodeURIComponent(history.nextCursor!)}`);
      if (mounted.current && request === generation.current) setHistory(current => ({ ...page, events: [...current.events, ...page.events.filter(event => !current.events.some(existing => existing.id === event.id))] }));
    });
  }
  return <div className="task-activity" aria-label="Task documents and history">
    {error && <p role="alert">{error} <button type="button" disabled={busy || loading} onClick={() => void refresh()}>Retry</button></p>}
    <section aria-labelledby="task-documents-heading"><h3 id="task-documents-heading">Documents</h3>
      <label className="task-file-picker">Attach a document<input type="file" disabled={busy || loading} onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void upload(file); }} /></label>
      <p className="hint">Files are stored with this task. Server upload limit defaults to 25 MiB; your administrator may change it.</p>
      {loading ? <p role="status">Loading documents and history…</p> : !attachments.length && !error && <p>No documents attached.</p>}
      <ul className="task-document-list">{attachments.map(file => <li key={file.id}><div><strong>{file.name}</strong><small>{new Intl.NumberFormat().format(file.size)} bytes · {who(file.createdBy)} · {date(file.createdAt)}</small></div><div><button type="button" disabled={busy} onClick={() => void perform(async () => {
        const response = await fetchApi(`${base}/attachments/${encodeURIComponent(file.id)}`);
        if (!response.ok) throw new Error(`Download failed (${response.status}).`);
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a'); link.href = url; link.download = file.name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
      })}>Download<span className="sr-only"> {file.name}</span></button><button type="button" disabled={busy} onClick={() => void perform(async () => {
        if (!await confirm({ title: 'Remove document?', message: `Remove “${file.name}” from this task?`, confirmLabel: 'Remove document', tone: 'danger' })) return;
        await api(`${base}/attachments/${encodeURIComponent(file.id)}`, { method: 'DELETE' }); if (mounted.current) await refresh();
      })}>Remove<span className="sr-only"> {file.name}</span></button></div></li>)}</ul>
    </section>
    <section aria-labelledby="task-history-heading"><header className="task-activity-heading"><h3 id="task-history-heading">History</h3><button type="button" disabled={busy || loading} onClick={() => void refresh()}>Refresh history</button></header>
      <p className="hint">Oldest to newest within loaded history. Earlier activity may predate audit tracking.</p>
      {history.hasMore && history.nextCursor && <button type="button" disabled={busy || loading} onClick={() => void older()}>Load older activity</button>}
      {!loading && !error && !history.events.length && <p>No recorded activity.</p>}
      <ol className="task-history-list">{[...history.events].reverse().map(event => <li key={event.id}><strong>{event.action.replaceAll('_', ' ')}</strong><small>{who(event.actor)} ({event.actor.type}) · <time dateTime={event.at}>{date(event.at)}</time></small>
        {Object.keys(event.changes ?? {}).length > 0 && <details><summary>Changes</summary><dl>{Object.entries(event.changes).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{value && typeof value === 'object' && 'before' in value && 'after' in value ? `${valueText(value.before)} → ${valueText(value.after)}` : valueText(value)}</dd></div>)}</dl></details>}
        {Object.keys(event.details ?? {}).length > 0 && <details><summary>Details</summary><pre>{JSON.stringify(event.details, null, 2)}</pre></details>}
        {(event.sessionId || event.runId) && <small>Session: {event.sessionId || '—'} · Run: {event.runId || '—'}</small>}
      </li>)}</ol>
    </section>{busy && <p role="status">Working…</p>}
  </div>;
}
