import { useEffect, useRef, useState } from 'react';
import { api, jsonMutation } from '../../app/api';
import type { Agent } from '../../app/types';
import './albdruck.css';
import { ConversationPurge } from './ConversationPurge';
export type Document = { claim: string; rationale: string | null; alternatives: unknown[]; constraints: unknown[]; relationships: unknown[] };
type RecordItem = { id: string; document: Document; state: string; created_at: string; updated_at: string; evidence?: { sourceRef: unknown; status: string; content: string | null }[]; revisions?: { id: string; operation: string; document: unknown; created_at: string }[] };
type Results = { items: RecordItem[]; nextCursor: string | null };
type Original = { agentId: string; sessionId: string; entryId: string; timestamp: string; role: string; content: string; sourceRef: { kind: "conversation_entry"; agentId: string; sessionId: string; entryId: string }; provenance: { store: "live" | "archive"; reset: boolean; archiveId?: string; kind?: string; generation?: number; archivedAt?: string } };
type HistoryResults = { items: Original[]; nextCursor: string | null };
const retentionKeys = ['knowledgeDays', 'evidenceDays', 'revisionDays', 'conversationDays', 'operationalDays', 'attachmentDays'] as const;
const retentionLabels: Record<typeof retentionKeys[number], string> = { knowledgeDays: 'Derived knowledge (days)', evidenceDays: 'Preserved evidence excerpts (days)', revisionDays: 'Knowledge revisions (days)', conversationDays: 'Original conversations (days)', operationalDays: 'Operational traces (days)', attachmentDays: 'Attachments (days)' };
type Policy = Record<typeof retentionKeys[number], number | null>;
export function parseDocument(text: string): Document {
  const d = JSON.parse(text);
  if (!d || typeof d.claim !== 'string' || !d.claim.trim() || (d.rationale !== null && d.rationale !== undefined && typeof d.rationale !== 'string') || ['alternatives','constraints','relationships'].some(k => d[k] !== undefined && !Array.isArray(d[k]))) throw new Error('Claim is required; rationale must be text or null; alternatives, constraints and relationships must be arrays.');
  return { claim: d.claim.trim(), rationale: d.rationale ?? null, alternatives: d.alternatives ?? [], constraints: d.constraints ?? [], relationships: d.relationships ?? [] };
}
export function parseDays(text: string): number | null {
  if (!text.trim()) return null;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) throw new Error('Retention must be a positive whole number of days, or blank for unlimited.');
  return n;
}
const json = (value: unknown) => JSON.stringify(value, null, 2);
const localTime = (value: string) => new Date(value).toLocaleString();
export function Albdruck({ agents }: { agents: Agent[] }) {
  const [purgeConversation, setPurgeConversation] = useState<{agentId: string; sessionId: string} | null>(null);
  const [scope, setScope] = useState('agent'); const [agentId, setAgentId] = useState('');
  const [mode, setMode] = useState('knowledge'); const [query, setQuery] = useState(''); const [search, setSearch] = useState('');
  const [cursor, setCursor] = useState(''); const [results, setResults] = useState<Results>({ items: [], nextCursor: null });
  const [history, setHistory] = useState<HistoryResults>({ items: [], nextCursor: null });
  const [detail, setDetail] = useState<RecordItem | null>(null); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  const [reason, setReason] = useState(''); const [editor, setEditor] = useState(''); const [operation, setOperation] = useState('correct');
  const [refresh, setRefresh] = useState(0); const sequence = useRef(0); const detailSequence = useRef(0);
  const [policy, setPolicy] = useState<Record<string,string> | null>(null); const [retentionBusy, setRetentionBusy] = useState(false); const retentionSequence = useRef(0);
  const available = agents;
  const selectedId = agentId || available[0]?.resourceId || available[0]?.id || '';
  const params = new URLSearchParams(scope === 'global' ? { scope } : { scope, agentId: selectedId });
  const suffix = `?${params}`; const request = <T,>(path: string, init?: RequestInit) => api<T>(`/api/albdruck/${path}`, init);
  useEffect(() => {
    const token = ++sequence.current; ++detailSequence.current; setDetail(null); setReason(''); setError(''); setResults({items:[],nextCursor:null}); setHistory({items:[],nextCursor:null});
    if (scope === 'agent' && !selectedId) { setBusy(false); return; }
    setBusy(true);
    const recall = mode === 'recall';
    if (recall && !search.trim()) { setBusy(false); return; }
    const path = recall ? `history${suffix}` : `knowledge${suffix}&query=${encodeURIComponent(search)}&cursor=${encodeURIComponent(cursor)}&pageSize=50`;
    const init = recall ? jsonMutation('POST', { query: search, ...(cursor ? { cursor } : {}), pageSize: 50 }) : undefined;
    void (recall ? request<HistoryResults>(path, init).then(r => { if (token === sequence.current) setHistory(r); }) : request<Results>(path).then(r => { if (token === sequence.current) setResults(r); })).catch(e => { if (token === sequence.current) setError(String(e.message)); }).finally(() => { if (token === sequence.current) setBusy(false); });
    return () => { ++sequence.current; ++detailSequence.current; };
  }, [suffix, mode, search, cursor, refresh]);
  useEffect(() => {
    const token = ++retentionSequence.current; setPolicy(null);
    void request<Policy>('retention').then(p => { if (token === retentionSequence.current) setPolicy(Object.fromEntries(retentionKeys.map(k => [k,p[k] === null ? '' : String(p[k])]))); }).catch(e => { if (token === retentionSequence.current) setError(e.message); });
    return () => { ++retentionSequence.current; };
  }, []);
  async function open(id: string) {
    const token = ++detailSequence.current; setDetail(null); setError(''); setReason('');
    try { const d = await request<RecordItem>(`knowledge/${encodeURIComponent(id)}${suffix}`); if (token === detailSequence.current) { setDetail(d); setEditor(json(d.document)); } } catch(e) { if (token === detailSequence.current) setError((e as Error).message); }
  }
  async function review() {
    if (!detail || !reason.trim()) return;
    const token = detailSequence.current; setBusy(true); setError('');
    try {
      const body = operation === 'delete' ? {reason:reason.trim()} : {operation,reason:reason.trim(), ...(operation === 'correct' ? {document:parseDocument(editor)} : {})};
      await request(`knowledge/${encodeURIComponent(detail.id)}${suffix}`, jsonMutation(operation === 'delete' ? 'DELETE' : 'PUT', body));
      if (token === detailSequence.current) { setRefresh(r => r+1); }
    } catch(e) { if (token === detailSequence.current) setError((e as Error).message); } finally { if (token === detailSequence.current) setBusy(false); }
  }
  async function saveRetention() {
    if (!policy) return; const token = retentionSequence.current; setRetentionBusy(true); setError('');
    try { const body = Object.fromEntries(retentionKeys.map(k => [k,parseDays(policy[k])])); await request('retention', jsonMutation('PUT', body)); if (token === retentionSequence.current) setError('Retention policy saved.'); }
    catch(e) { if (token === retentionSequence.current) setError((e as Error).message); } finally { if (token === retentionSequence.current) setRetentionBusy(false); }
  }
  return <div className="albdruck-page"><h1>Albdruck — Knowledge & Recall</h1><p>Derived knowledge is not original evidence and must never serve as evidence for itself.</p>
    <div className="albdruck-controls"><label>Scope <select value={scope} onChange={e => {setScope(e.target.value);setCursor('');}}><option value="agent">Agent</option><option value="global">Global</option></select></label>{scope === 'agent' && <label>Agent <select value={selectedId} onChange={e => {setAgentId(e.target.value);setCursor('');}}>{available.map(a => <option key={a.id} value={a.resourceId ?? a.id}>{a.name}</option>)}</select></label>}
    <label>View <select value={mode} onChange={e => {setMode(e.target.value);setCursor('');setSearch('');setQuery('');}}><option value="knowledge">Knowledge</option><option value="recall">Recall — original conversations</option></select></label></div>
    {mode === 'recall' && <p>Recall searches full original conversation entries, including archived and reset originals. Knowledge search remains separate.</p>}
    <form onSubmit={e => {e.preventDefault();setSearch(query);setCursor('');setRefresh(r=>r+1);}}><label>{mode === 'recall' ? 'Search originals' : 'Search knowledge'} <input value={query} onChange={e=>setQuery(e.target.value)} /></label><button disabled={busy || (mode === 'recall' && !query.trim())}>Search</button></form>
    {error && <p role="status">{error}</p>}{busy && <p role="status">Loading…</p>}{scope === 'agent' && !selectedId && <p>No agent available. Choose global scope to search globally.</p>}
    {mode === 'recall' ? <section aria-label="Original conversation results"><h2>Original conversations</h2>{!busy && search && !history.items.length && <p>No matching originals.</p>}<ul>{history.items.map(item => <li key={`${item.agentId}:${item.sessionId}:${item.entryId}`}><h3>Original conversation · {item.provenance.store === 'live' ? 'Live' : item.provenance.reset ? 'Reset archive' : 'Archive'}</h3><p>{item.agentId} · {item.sessionId} · {item.entryId} · {item.role} · {localTime(item.timestamp)}</p><pre>{item.content}</pre><button disabled={Boolean(purgeConversation)} onClick={() => setPurgeConversation({agentId:item.agentId,sessionId:item.sessionId})}>Permanently purge this conversation</button><details><summary>Source and provenance</summary><pre>{json(item.sourceRef)}</pre><pre>{json(item.provenance)}</pre></details></li>)}</ul>{history.nextCursor && <button disabled={busy} onClick={()=>setCursor(history.nextCursor!)}>Next page</button>}{cursor && <button onClick={()=>setCursor('')}>First page</button>}</section> : <div className="albdruck-columns"><section aria-label="Knowledge results"><h2>Knowledge results</h2>{!busy && !results.items.length && <p>No matching knowledge.</p>}<ul>{results.items.map(item=><li key={item.id}><button onClick={()=>void open(item.id)}>{item.document.claim}</button><p>Updated {localTime(item.updated_at)}</p></li>)}</ul>{results.nextCursor && <button disabled={busy} onClick={()=>setCursor(results.nextCursor!)}>Next page</button>}{cursor && <button onClick={()=>setCursor('')}>First page</button>}</section>
    {detail && <section aria-label="Knowledge detail"><h2>{detail.document.claim}</h2><p>State: {detail.state} · Updated {localTime(detail.updated_at)}</p><h3>Rationale</h3><p>{detail.document.rationale ?? 'Not provided'}</p>{(['alternatives','constraints','relationships'] as const).map(k=><div key={k}><h3>{k}</h3><pre>{json(detail.document[k])}</pre></div>)}
      <h3>Evidence</h3>{detail.evidence?.map((e,i)=><article key={i}><h4>{e.status === 'live_original' ? 'Original conversation' : e.status === 'preserved_excerpt' ? 'Preserved excerpt' : 'Unavailable'}</h4>{e.status === 'preserved_excerpt' && <p>This excerpt is not an original conversation.</p>}<pre>{json(e.sourceRef)}</pre>{e.status !== 'unavailable' && <pre>{e.content}</pre>}</article>)}
      <h3>Revisions</h3>{detail.revisions?.map(r=><article key={r.id}><p>{r.operation} · {localTime(r.created_at)}</p><pre>{json(r.document)}</pre></article>)}
      {detail.state === 'active' && <form onSubmit={e=>{e.preventDefault();void review();}}><h3>Review knowledge</h3><label>Operation <select value={operation} onChange={e=>setOperation(e.target.value)}><option value="correct">Correct</option><option value="supersede">Supersede</option><option value="delete">Archive</option></select></label>{operation === 'correct' && <label>Replacement document (JSON)<textarea rows={14} value={editor} onChange={e=>setEditor(e.target.value)} /></label>}<label>Reason (required)<textarea required value={reason} onChange={e=>setReason(e.target.value)} /></label><p>Supersede marks this record inactive; it does not create a replacement. Archive is a soft deletion with a revision, not full erasure. Both disappear from list and recall; archived knowledge remains accessible in detail until retention.</p><button disabled={busy || !reason.trim()}>Apply {operation === 'delete' ? 'archive' : operation}</button></form>}
    </section>}</div>}
    {purgeConversation && <ConversationPurge key={`${purgeConversation.agentId}:${purgeConversation.sessionId}`} conversation={purgeConversation} onClose={() => setPurgeConversation(null)} onPurged={() => { setCursor(''); setRefresh(r => r+1); }} />}
    <section><h2>Independent retention</h2><p>Blank disables that domain’s Albdruck age cleanup. Defaults: knowledge, evidence, revisions and conversations unlimited; operational traces have no Albdruck age limit but the existing Dreams trace policy may apply; attachments 30 days. These limits are independent of working memory and other conversation retention. Saving does not run pruning. Evidence expiry clears preserved excerpts, not original references; revision expiry removes old audit rows; knowledge expiry also removes its derived evidence and revisions. Conversation expiry preserves durable knowledge and evidence, and skips current or active sessions. Attachment ingestion uses the saved attachment limit.</p>{policy && <form onSubmit={e=>{e.preventDefault();void saveRetention();}}><div className="albdruck-controls">{retentionKeys.map(k=><label key={k}>{retentionLabels[k]} <input type="number" min="1" step="1" placeholder="Unlimited" value={policy[k]} onChange={e=>setPolicy({...policy,[k]:e.target.value})}/></label>)}</div><button disabled={retentionBusy}>Save retention</button></form>}</section>
  </div>;
}
