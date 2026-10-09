import { useEffect, useRef, useState } from 'react';
import { api, jsonMutation } from '../../app/api';
import type { Agent } from '../../app/types';
import './albdruck.css';

export type Brain = {
  id: string; agentId: string; title: string; content: string; sourceRefs: string[];
  revision: number; operatorOwned: boolean; createdAt: string; updatedAt: string;
  origin: 'explicit_saved_memory' | 'migrated_albdruck' | string;
  legacyStatus: string | null; legacySnapshot: unknown | null; evidenceDisclosure?: string;
};
type Results = { items: Brain[]; nextCursor: string | null };
type Draft = { title: string; content: string; sourceRefs: string };
type ErrorKind = 'list' | 'conflict' | 'other' | '';
const emptyDraft: Draft = { title: '', content: '', sourceRefs: '' };
const localTime = (value: string) => { const date = new Date(value); return Number.isNaN(date.valueOf()) ? 'Unknown' : date.toLocaleString(); };
const ownerId = (agent: Agent) => agent.resourceId ?? agent.id;
const sourceRefs = (text: string) => text.split('\n').map(value => value.trim()).filter(Boolean);
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Request failed.';
const toDraft = (brain: Brain): Draft => ({ title: brain.title, content: brain.content, sourceRefs: brain.sourceRefs.join('\n') });

export function Brains({ agents }: { agents: Agent[] }) {
  const urlOwner = new URLSearchParams(window.location.search).get('agentId') ?? '';
  const [agentId, setAgentId] = useState(() => agents.some(agent => ownerId(agent) === urlOwner) ? urlOwner : ownerId(agents[0] ?? ({ id: '' } as Agent)));
  const [query, setQuery] = useState(''); const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState<string | null>(null); const [results, setResults] = useState<Results>({ items: [], nextCursor: null });
  const [selected, setSelected] = useState<Brain | null>(null); const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [creating, setCreating] = useState(false); const [listBusy, setListBusy] = useState(false); const [writeBusy, setWriteBusy] = useState(false);
  const [error, setError] = useState(''); const [errorKind, setErrorKind] = useState<ErrorKind>(''); const [reloadTick, setReloadTick] = useState(0);
  const [checked, setChecked] = useState<Brain[]>([]);
  const [bulkReport, setBulkReport] = useState<string[]>([]);
  const listSequence = useRef(0); const editorGeneration = useRef(0);
  const invalidateEditor = () => { ++editorGeneration.current; setChecked([]); setBulkReport([]); };

  useEffect(() => () => { ++editorGeneration.current; ++listSequence.current; }, []);
  useEffect(() => {
    const owners = agents.map(ownerId);
    if (agentId && owners.includes(agentId)) return;
    const next = owners.includes(urlOwner) ? urlOwner : (owners[0] ?? '');
    invalidateEditor(); setWriteBusy(false); setAgentId(next); setCursor(null); setQuery(''); setSearch(''); setSelected(null); setCreating(false); setDraft(emptyDraft); setError(''); setErrorKind('');
  }, [agents, agentId, urlOwner]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (agentId) params.set('agentId', agentId); else params.delete('agentId');
    window.history.replaceState(null, '', `${window.location.pathname}${params.size ? `?${params}` : ''}${window.location.hash}`);
  }, [agentId]);
  useEffect(() => {
    const token = ++listSequence.current;
    if (!agentId) { setResults({ items: [], nextCursor: null }); setListBusy(false); return; }
    setListBusy(true);
    const params = new URLSearchParams({ agentId, query: search, limit: '50' }); if (cursor) params.set('cursor', cursor);
    void api<Results>(`/api/brains?${params}`).then(value => { if (token === listSequence.current) { setResults(value); if (errorKind === 'list') { setError(''); setErrorKind(''); } } }).catch(cause => { if (token === listSequence.current) { setError(errorText(cause)); setErrorKind('list'); } }).finally(() => { if (token === listSequence.current) setListBusy(false); });
    return () => { ++listSequence.current; };
  }, [agentId, search, cursor, reloadTick]);

  const changeOwner = (next: string) => { if (writeBusy) return; invalidateEditor(); setAgentId(next); setCursor(null); setQuery(''); setSearch(''); setSelected(null); setCreating(false); setDraft(emptyDraft); setError(''); setErrorKind(''); };
  const open = (brain: Brain) => { if (writeBusy) return; invalidateEditor(); setCreating(false); setSelected(brain); setDraft(toDraft(brain)); setError(''); setErrorKind(''); };
  const beginCreate = () => { if (writeBusy) return; invalidateEditor(); setCreating(true); setSelected(null); setDraft(emptyDraft); setError(''); setErrorKind(''); };
  const reloadFirstPage = () => { setCursor(null); setReloadTick(value => value + 1); };
  const navigate = (next: string | null) => { if (writeBusy) return; invalidateEditor(); setSelected(null); setCreating(false); setDraft(emptyDraft); setCursor(next); setError(''); setErrorKind(''); };

  async function reloadDetail() {
    if (!selected || writeBusy) return;
    const owner = agentId; const target = selected; const generation = editorGeneration.current; setWriteBusy(true); setError(''); setErrorKind('');
    try {
      const fresh = await api<Brain>(`/api/brains/${encodeURIComponent(target.id)}?agentId=${encodeURIComponent(owner)}`);
      if (generation !== editorGeneration.current) return;
      setSelected(fresh); setDraft(toDraft(fresh));
    } catch (cause) { if (generation === editorGeneration.current) { setError(errorText(cause)); setErrorKind('other'); } }
    finally { if (generation === editorGeneration.current) setWriteBusy(false); }
  }
  async function save() {
    if (!agentId || !draft.title.trim() || !draft.content.trim() || writeBusy) return;
    const owner = agentId; const current = selected; const generation = editorGeneration.current; setWriteBusy(true); setError(''); setErrorKind('');
    try {
      const body = { title: draft.title.trim(), content: draft.content.trim(), sourceRefs: sourceRefs(draft.sourceRefs), ...(current ? { expectedRevision: current.revision } : {}) };
      const saved = await api<Brain>(current ? `/api/brains/${encodeURIComponent(current.id)}?agentId=${encodeURIComponent(owner)}` : `/api/brains?agentId=${encodeURIComponent(owner)}`, jsonMutation(current ? 'PUT' : 'POST', body));
      if (generation !== editorGeneration.current) return;
      setSelected(saved); setCreating(false); setDraft(toDraft(saved)); reloadFirstPage();
    } catch (cause) { if (generation === editorGeneration.current) { const conflict = errorText(cause).includes('conflict'); setError(conflict ? 'This memory changed since you opened it. Reload it before saving.' : errorText(cause)); setErrorKind(conflict && current ? 'conflict' : 'other'); } }
    finally { if (generation === editorGeneration.current) setWriteBusy(false); }
  }
  async function remove() {
    if (!selected || writeBusy) return; const owner = agentId; const target = selected; const generation = editorGeneration.current; setWriteBusy(true); setError(''); setErrorKind('');
    try {
      await api(`/api/brains/${encodeURIComponent(target.id)}?agentId=${encodeURIComponent(owner)}`, jsonMutation('DELETE', { expectedRevision: target.revision }));
      if (generation !== editorGeneration.current) return; setSelected(null); setChecked(values => values.filter(value => value.id !== target.id)); setDraft(emptyDraft); reloadFirstPage();
    } catch (cause) { if (generation === editorGeneration.current) { const conflict = errorText(cause).includes('conflict'); setError(conflict ? 'This memory changed since you opened it. Reload it before deleting.' : errorText(cause)); setErrorKind(conflict ? 'conflict' : 'other'); } }
    finally { if (generation === editorGeneration.current) setWriteBusy(false); }
  }
  async function removeChecked() {
    if (!checked.length || writeBusy || listBusy) return;
    const targets = checked; const owner = agentId; const generation = editorGeneration.current;
    setWriteBusy(true); setError(''); setErrorKind(''); setBulkReport([]);
    // Each record is an independent operator mutation, not an atomic batch.
    const outcomes = await Promise.all(targets.map(async target => {
      try {
        await api(`/api/brains/${encodeURIComponent(target.id)}?agentId=${encodeURIComponent(owner)}`, jsonMutation('DELETE', { expectedRevision: target.revision }));
        return { target, deleted: true, message: `${target.title}: deleted` };
      } catch (cause) {
        return { target, deleted: false, message: `${target.title}: not deleted — ${errorText(cause)}. Reload the list before retrying a conflict.` };
      }
    }));
    if (generation !== editorGeneration.current) return;
    const deleted = new Set(outcomes.filter(value => value.deleted).map(value => value.target.id));
    setChecked(targets.filter(target => !deleted.has(target.id)));
    setBulkReport(outcomes.map(value => value.message));
    if (selected && deleted.has(selected.id)) { setSelected(null); setDraft(emptyDraft); }
    setWriteBusy(false); reloadFirstPage();
  }
  const busy = listBusy || writeBusy;
  return <div className="albdruck-page"><header><h1>Brains</h1><p>Explicit saved memories, isolated by agent owner. Saved memory is not verification of current runtime truth.</p></header>
    <div className="albdruck-controls"><label>Agent owner<select value={agentId} onChange={event => changeOwner(event.target.value)} disabled={!agents.length || writeBusy}>{!agents.length && <option value="">No agents available</option>}{agents.map(agent => <option key={agent.id} value={ownerId(agent)}>{agent.name}</option>)}</select></label><button type="button" onClick={beginCreate} disabled={!agentId || busy}>New memory</button></div>
    <form className="brain-search" onSubmit={event => { event.preventDefault(); navigate(null); setSearch(query); }}><label>Search memories<input value={query} disabled={writeBusy} onChange={event => setQuery(event.target.value)} /></label><button disabled={!agentId || busy}>Search</button></form>
    {error && <p role="alert">{error} {errorKind === 'list' && <button type="button" onClick={reloadFirstPage}>Retry</button>}{errorKind === 'conflict' && selected && <button type="button" disabled={writeBusy} onClick={() => void reloadDetail()}>Reload memory</button>}</p>}{busy && <p role="status">Loading…</p>}{!agentId && <p>No agent available. Memories require an agent owner.</p>}
    <div className="albdruck-columns"><section aria-label="Memory results"><h2>Saved memories</h2>{!listBusy && agentId && !results.items.length && <p>No saved memories for this agent.</p>}<div className="memory-bulk"><label><input type="checkbox" aria-label="Select all memories on this page" disabled={busy || !results.items.length} checked={!!results.items.length && results.items.every(item => checked.some(value => value.id === item.id))} onChange={event => setChecked(event.target.checked ? results.items : [])} />Select page</label><button type="button" disabled={busy || !checked.length} onClick={() => void removeChecked()}>Delete selected memories ({checked.length})</button><button type="button" disabled={busy} onClick={() => { setChecked([]); reloadFirstPage(); }}>Reload list</button></div>{!!bulkReport.length && <div role="status"><p>Independent deletion results (not atomic):</p><ul>{bulkReport.map((message, index) => <li key={index}>{message}</li>)}</ul></div>}<ul>{results.items.map(item => <li key={item.id}><input type="checkbox" aria-label={`Select memory: ${item.title}`} disabled={busy} checked={checked.some(value => value.id === item.id)} onChange={event => setChecked(values => event.target.checked ? [...values, item] : values.filter(value => value.id !== item.id))} /><button type="button" disabled={writeBusy} onClick={() => open(item)}>{item.title}</button><p>{item.origin === 'migrated_albdruck' ? 'Migrated from legacy Albdruck' : 'Explicit saved memory'} · revision {item.revision} · {localTime(item.updatedAt)}</p></li>)}</ul><div>{results.nextCursor && <button type="button" disabled={busy} onClick={() => navigate(results.nextCursor)}>Next page</button>}{cursor && <button type="button" disabled={busy} onClick={() => navigate(null)}>First page</button>}</div></section>
      {(creating || selected) && <section aria-label="Memory editor"><h2>{creating ? 'New memory' : 'Edit memory'}</h2>{selected && <><p>Owner: {selected.agentId} · revision {selected.revision} · {selected.operatorOwned ? 'Operator-owned' : 'Runtime-owned'}</p><p>Origin: {selected.origin === 'migrated_albdruck' ? 'Migrated from legacy Albdruck' : 'Explicit saved memory'}</p></>}
        <form onSubmit={event => { event.preventDefault(); void save(); }}><label>Title<input required disabled={writeBusy} value={draft.title} onChange={event => setDraft(value => ({ ...value, title: event.target.value }))} /></label><label>Content<textarea required disabled={writeBusy} rows={12} value={draft.content} onChange={event => setDraft(value => ({ ...value, content: event.target.value }))} /></label><label>Source references (one per line)<textarea disabled={writeBusy} rows={4} value={draft.sourceRefs} onChange={event => setDraft(value => ({ ...value, sourceRefs: event.target.value }))} /></label><button disabled={writeBusy || !draft.title.trim() || !draft.content.trim()}>{creating ? 'Create memory' : 'Save memory'}</button>{selected && <button type="button" disabled={writeBusy} onClick={() => void remove()}>Delete memory</button>}</form>
        {selected?.origin === 'migrated_albdruck' && <details><summary>Legacy migration details</summary><p>Status: {selected.legacyStatus ?? 'Unknown'}</p><pre>{JSON.stringify(selected.legacySnapshot, null, 2)}</pre></details>}
      </section>}</div>
  </div>;
}

export const Albdruck = Brains;
