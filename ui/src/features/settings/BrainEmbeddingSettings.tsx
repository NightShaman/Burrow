import { useEffect, useRef, useState } from 'react';
import { api } from '../../app/api';
import { usePolling } from '../../app/usePolling';
import type { SavedProvider } from '../../app/types';
import { Field, SettingSection } from './SettingsPrimitives';

type Status = { enabled: boolean; connectionId: string | null; model: string | null; generation: string; total: string; indexed: string; pending: string; failed: string; storage: string; lastError: string | null };
type Discovery = { connectionId: string; provider: string; models: { id: string; name: string }[]; capabilityDisclosure: string };
const root = '/api/settings/brain-embeddings';
const json = (method: string, body?: unknown) => ({ method, headers: { 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

export function BrainEmbeddingSettings({ savedProviders }: { savedProviders: SavedProvider[] }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [connectionId, setConnectionId] = useState('');
  const [model, setModel] = useState('');
  const [discovery, setDiscovery] = useState<Discovery | null>(null);
  const [error, setError] = useState('');
  const [discoveryError, setDiscoveryError] = useState('');
  const [tested, setTested] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState('load');
  // Immutable tickets fence every completion against mount, draft and status epochs.
  const owner = useRef<object | null>(null);
  const epoch = useRef(0);
  const generation = useRef<string | null>(null);
  const ticket = () => ({ owner: owner.current, epoch: epoch.current, generation: generation.current });
  const current = (t: ReturnType<typeof ticket>) => t.owner !== null && t.owner === owner.current && t.epoch === epoch.current && t.generation === generation.current;
  const accept = (s: Status) => { generation.current = s.generation; setStatus(s); };
  const edit = () => { epoch.current++; setTested(''); setConfirmed(false); setError(''); setBusy(''); };
  useEffect(() => {
    owner.current = {}; const t = ticket();
    api<Status>(root).then(s => { if (!current(t)) return; accept(s); setEnabled(s.enabled); setConnectionId(s.connectionId ?? ''); setModel(s.model ?? ''); setBusy(''); }).catch(() => { if (current(t)) { setError('Could not load embedding settings. Reopen this section to retry. Brains CRUD remains available.'); setBusy(''); } });
    return () => { owner.current = null; epoch.current++; };
  }, []);
  useEffect(() => {
    setDiscovery(null); setDiscoveryError('');
    if (!connectionId) return;
    const t = ticket(); let cancelled = false;
    api<Discovery>(`${root}/models?connectionId=${encodeURIComponent(connectionId)}`).then(s => { if (!cancelled && current(t) && s.connectionId === connectionId) setDiscovery(s); }).catch(() => { if (!cancelled && current(t)) setDiscoveryError('Embedding discovery unavailable. Check the connection and provider capabilities, or enter a model ID and test it.'); });
    return () => { cancelled = true; };
  }, [connectionId]);
  usePolling(async (cancelled, signal) => {
    const t = ticket();
    try { const s = await api<Status>(root, { signal }); if (!cancelled() && current(t)) { accept(s); } }
    catch { if (!cancelled() && current(t)) setError('Could not refresh indexing status. Polling will retry; Brains CRUD remains available.'); }
  }, 3000, !!status && !busy, `${busy}:${status?.generation ?? ''}`);
  const request = async (action: 'save' | 'test' | 'reindex') => {
    epoch.current++; const t = ticket(); setBusy(action); setError('');
    const selection = { connectionId: connectionId || null, model: model.trim() || null };
    try {
      if (action === 'test') {
        const result = await api<{ ok: true; dimensions: number }>(`${root}/test`, json('POST', selection));
        if (current(t)) setTested(`Test successful · ${result.dimensions} dimensions`);
      } else {
        const s = await api<Status>(action === 'save' ? root : `${root}/reindex`, json(action === 'save' ? 'PUT' : 'POST', action === 'save' ? { enabled, ...(enabled || (selection.connectionId && selection.model) ? selection : { connectionId: null, model: null }) } : undefined));
        if (current(t)) accept(s);
      }
    } catch { if (current(t)) setError(`Could not ${action} embeddings. Check the saved connection, supported embedding model and provider availability, then retry. Saved memories are unchanged.`); }
    finally { if (t.owner === owner.current && t.epoch === epoch.current) setBusy(''); }
  };
  const selected = !!connectionId && !!model.trim();
  const manual = !discovery?.models.some(m => m.id === model.trim());
  const locked = !!busy;
  return <SettingSection title="Brain memory"><div className="curator-card">
    <p className="hint">Brains are explicit agent-owned saved memories, never automatically preloaded. Optional global embeddings are off by default and augment only agent-invoked brain_search. CRUD stays lexical and reads stay exact; Dreams and conversations are not embedded.</p>
    <label><input type="checkbox" checked={enabled} disabled={locked || !status} onChange={e => { edit(); setEnabled(e.target.checked); }} /> Enable Brains embeddings globally</label>
    <Field label="Existing model connection"><select value={connectionId} disabled={locked || !status} onChange={e => { edit(); setConnectionId(e.target.value); setModel(''); }}><option value="">Choose a connection</option>{connectionId && !savedProviders.some(p => p.id === connectionId) && <option value={connectionId}>Configured connection (unavailable)</option>}{savedProviders.map(p => <option key={p.id} value={p.id}>{p.provider}</option>)}</select></Field>
    <Field label="Discovered embedding model"><select value={discovery?.models.some(m => m.id === model) ? model : ''} disabled={locked || !discovery} onChange={e => { edit(); setModel(e.target.value); }}><option value="">Choose an embedding model or enter ID below</option>{discovery?.models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field>
    {discovery && <p className="hint">{discovery.capabilityDisclosure}{!discovery.models.length && ' No embedding models advertised. Use a manual ID and test.'}</p>}
    {discoveryError && <p role="alert" className="settings-request-error">{discoveryError}</p>}
    <Field label="Embedding model ID (manual fallback)"><input value={model} disabled={locked || !status} onChange={e => { edit(); setModel(e.target.value); }} /></Field>
    <label><input type="checkbox" checked={confirmed} disabled={locked} onChange={e => setConfirmed(e.target.checked)} /> I confirm provider requests: hosted providers receive test text and, when enabled or reindexed, saved Brain contents and search queries. Provider charges may apply.</label>
    <button type="button" disabled={locked || !selected || !confirmed} onClick={() => void request('test')}>Test embedding model</button>
    {tested && <p role="status">{tested}</p>}
    <button type="button" className="primary" disabled={locked || !status || (enabled && (!selected || !confirmed || (manual && !tested)))} onClick={() => void request('save')}>Save embedding settings</button>
    <button type="button" disabled={locked || !status?.enabled || !confirmed} onClick={() => void request('reindex')}>Reindex all Brains asynchronously</button>
    {busy && <p role="status">{busy === 'load' ? 'Loading settings…' : `${busy} request in progress…`}</p>}
    {status && <p role="status">{status.enabled ? 'Enabled' : 'Disabled'} · Generation {status.generation} · Indexed {status.indexed} / {status.total} · Pending {status.pending} · Failed {status.failed} · Storage {status.storage}. Partial coverage remains searchable lexically. Indexing runs asynchronously; status refreshes every 3 seconds.</p>}
    {status?.lastError && <p role="alert">Indexing error: {status.lastError}. Check provider availability and model support; failed jobs retry automatically.</p>}
    {error && <p role="alert" className="settings-request-error">{error}</p>}
    <p className="settings-help">Manage saved memories independently in the Brains workspace. Saved memory is not verification of current runtime truth.</p>
  </div></SettingSection>;
}
