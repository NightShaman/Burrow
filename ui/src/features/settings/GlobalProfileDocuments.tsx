import { createPortal } from 'react-dom';
import { useUnsavedChanges, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../app/api';
import { Field, SettingSection } from './SettingsPrimitives';

type GlobalProfileDocument = { kind: 'RULES' | 'ORIENTATION'; markdown: string };
const documentKinds: GlobalProfileDocument['kind'][] = ['RULES', 'ORIENTATION'];
const documentLabels: Record<GlobalProfileDocument['kind'], string> = { RULES: 'Global Rules', ORIENTATION: 'Global Orientation' };
const emptyDocuments = () => documentKinds.map(kind => ({ kind, markdown: '' }));

export function GlobalProfileDocuments({ overflowTarget }: { overflowTarget?: HTMLElement | null }) {
  const [documents, setDocuments] = useState<GlobalProfileDocument[]>(emptyDocuments);
  const [baseline, setBaseline] = useState<GlobalProfileDocument[]>(emptyDocuments);
  const navigate = useUnsavedNavigation();
  const [selectedKind, setSelectedKind] = useState<GlobalProfileDocument['kind']>('RULES');
  const [state, setState] = useState<'loading' | 'idle' | 'saving' | 'error'>('loading');
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState('');
  const requestVersion = useRef(0);

  useEffect(() => {
    const version = ++requestVersion.current;
    const controller = new AbortController();
    setState('loading');
    setError('');
    setDocuments(emptyDocuments());
    api<{ documents: GlobalProfileDocument[] }>('/api/settings/global-profile-documents', { signal: controller.signal }).then(result => {
      if (controller.signal.aborted || requestVersion.current !== version) return;
      const byKind = new Map((result.documents ?? []).map(document => [document.kind, document.markdown]));
      const next = documentKinds.map(kind => ({ kind, markdown: byKind.get(kind) ?? '' }));
      setDocuments(next); setBaseline(next);
      setState('idle');
    }).catch(cause => {
      if (controller.signal.aborted || requestVersion.current !== version) return;
      setError(cause instanceof Error ? `Could not load Global documents: ${cause.message}` : 'Could not load Global documents.');
      setState('error');
    });
    return () => controller.abort();
  }, [retry]);

  const update = (kind: GlobalProfileDocument['kind'], markdown: string) => setDocuments(current => current.map(document => document.kind === kind ? { ...document, markdown } : document));
  const save = async () => {
    if (state !== 'idle') return false;
    const version = requestVersion.current;
    setState('saving');
    setError('');
    try {
      const result = await api<{ documents: GlobalProfileDocument[] }>('/api/settings/global-profile-documents', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ documents }) });
      if (requestVersion.current !== version) return false;
      const byKind = new Map((result.documents ?? []).map(document => [document.kind, document.markdown]));
      const next = documentKinds.map(kind => ({ kind, markdown: byKind.get(kind) ?? '' }));
      setDocuments(next); setBaseline(next);
      return true;
    } catch (cause) {
      if (requestVersion.current === version) setError(cause instanceof Error ? `Could not save Global documents: ${cause.message}` : 'Could not save Global documents.');
      return false;
    } finally {
      if (requestVersion.current === version) setState('idle');
    }
  };

  useUnsavedChanges({ dirty: state !== 'loading' && state !== 'error' && JSON.stringify(documents) !== JSON.stringify(baseline), busy: state === 'saving', save, discard: () => { setDocuments(baseline); setError(''); } });
  const selected = documents.find(document => document.kind === selectedKind) ?? documents[0];
  const overflow = <div className="settings-overflow-content profile-document-overflow"><SettingSection title={documentLabels[selected.kind]}><Field label="Markdown"><textarea value={selected.markdown} disabled={state !== 'idle'} onChange={event => update(selected.kind, event.target.value)} rows={24} spellCheck="false" /></Field>{error && <p className="settings-request-error" role="alert">{error}</p>}<div className="card-actions"><button className="primary" type="button" onClick={() => void save()} disabled={state !== 'idle'}>{state === 'saving' ? 'Saving…' : 'Save Global documents'}</button></div></SettingSection></div>;

  return <><SettingSection title="Global documents">
    <p className="settings-description">Choose a Global document to edit.</p>
    {state === 'error' && <button type="button" onClick={() => setRetry(value => value + 1)}>Retry loading</button>}
    {state === 'loading' ? <p className="settings-empty">Loading Global documents…</p> : <div className="profile-document-selector">{documents.map(document => <button type="button" className={document.kind === selected.kind ? 'active' : ''} aria-pressed={document.kind === selected.kind} onClick={() => { if (document.kind !== selectedKind) navigate(() => setSelectedKind(document.kind)); }} key={document.kind}><strong>{documentLabels[document.kind]}</strong></button>)}</div>}
    {error && <p className="settings-request-error" role="alert">{error}</p>}
  </SettingSection>{overflowTarget && createPortal(overflow, overflowTarget)}</>;
}
