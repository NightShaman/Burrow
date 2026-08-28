import { createPortal } from 'react-dom';
import { useEffect, useState } from 'react';
import { apiForTarget } from '../../app/api';
import { targetForResource, type ApiTarget } from '../../app/apiTargets';
import { Field, SettingSection } from './SettingsPrimitives';

type ProfileDocument = { kind: 'SOUL' | 'RULES' | 'ORIENTATION' | 'PREFERENCES' | 'TOOLS' | 'DREAM_MEMORY'; markdown: string };
const profileDocumentKinds: ProfileDocument['kind'][] = ['SOUL', 'RULES', 'ORIENTATION', 'PREFERENCES', 'TOOLS', 'DREAM_MEMORY'];
const profileDocumentLabels: Record<ProfileDocument['kind'], string> = { SOUL: 'SOUL.md', RULES: 'RULES.md', ORIENTATION: 'ORIENTATION.md', PREFERENCES: 'PREFERENCES.md', TOOLS: 'TOOLS.md', DREAM_MEMORY: 'DreamMemory.md' };

export function AgentProfileDocuments({ agentId, targets, overflowTarget }: { agentId: string; targets: ApiTarget[]; overflowTarget?: HTMLElement | null }) {
  const owner = targetForResource(targets, agentId);
  const request = <T,>(path: string, init?: RequestInit) => apiForTarget<T>(owner.target, path, init);
  const [documents, setDocuments] = useState<ProfileDocument[]>(profileDocumentKinds.map(kind => ({ kind, markdown: '' })));
  const [selectedKind, setSelectedKind] = useState<ProfileDocument['kind']>('SOUL');
  const [state, setState] = useState<'loading' | 'idle' | 'saving'>('loading');
  const [error, setError] = useState('');

  useEffect(() => {
    const controller = new AbortController();
    setState('loading'); setError('');
    request<{ documents: ProfileDocument[] }>(`/api/agents/${encodeURIComponent(owner.resourceId)}/profile-documents`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      const byKind = new Map((result.documents ?? []).map(document => [document.kind, document.markdown]));
      setDocuments(profileDocumentKinds.map(kind => ({ kind, markdown: byKind.get(kind) ?? '' })));
      setState('idle');
    }).catch(cause => {
      if (controller.signal.aborted) return;
      setError(cause instanceof Error ? `Could not load profile documents: ${cause.message}` : 'Could not load profile documents.');
      setState('idle');
    });
    return () => controller.abort();
  }, [owner.target.id, owner.resourceId]);
  const save = async () => {
    setState('saving'); setError('');
    try { await request(`/api/agents/${encodeURIComponent(owner.resourceId)}/profile-documents`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ documents }) }); }
    catch (cause) { setError(cause instanceof Error ? `Could not save profile documents: ${cause.message}` : 'Could not save profile documents.'); }
    finally { setState('idle'); }
  };
  const update = (kind: ProfileDocument['kind'], markdown: string) => setDocuments(current => current.map(item => item.kind === kind ? { ...item, markdown } : item));

  if (overflowTarget) {
    const selected = documents.find(document => document.kind === selectedKind) ?? documents[0];
    const overflow = <div className="settings-overflow-content profile-document-overflow"><SettingSection title={profileDocumentLabels[selected.kind]}><Field label="Markdown"><textarea value={selected.markdown} onChange={event => update(selected.kind, event.target.value)} rows={24} spellCheck="false" /></Field>{error && <p className="settings-request-error" role="alert">{error}</p>}<div className="card-actions"><button className="primary" type="button" onClick={() => void save()} disabled={state !== 'idle'}>{state === 'saving' ? 'Saving…' : 'Save profile documents'}</button></div></SettingSection></div>;
    return <><SettingSection title="Profile documents"><p className="settings-description">Choose a profile document to edit.</p>{state === 'loading' ? <p className="settings-empty">Loading profile documents…</p> : <div className="profile-document-selector">{documents.map(document => <button type="button" className={document.kind === selected.kind ? 'active' : ''} aria-pressed={document.kind === selected.kind} onClick={() => setSelectedKind(document.kind)} key={document.kind}><strong>{profileDocumentLabels[document.kind]}</strong></button>)}</div>}{error && <p className="settings-request-error" role="alert">{error}</p>}</SettingSection>{createPortal(overflow, overflowTarget)}</>;
  }

  return <SettingSection title="Profile documents"><p className="settings-description">These documents define this agent’s identity, operating rules, orientation, and verified environment facts.</p>{state === 'loading' ? <p className="settings-empty">Loading profile documents…</p> : <details className="profile-documents-accordion"><summary>Show profile documents</summary><div className="profile-documents-content">{documents.map(document => <Field key={document.kind} label={profileDocumentLabels[document.kind]}><textarea value={document.markdown} onChange={event => update(document.kind, event.target.value)} rows={8} spellCheck="false" /></Field>)}{error && <p className="settings-request-error" role="alert">{error}</p>}<div className="card-actions"><button className="primary" onClick={() => void save()} disabled={state !== 'idle'}>{state === 'saving' ? 'Saving…' : 'Save profile documents'}</button></div></div></details>}</SettingSection>;
}
