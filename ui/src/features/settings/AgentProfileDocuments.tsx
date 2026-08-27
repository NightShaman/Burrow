import { useEffect, useState } from 'react';
import { apiForTarget } from '../../app/api';
import { targetForResource, type ApiTarget } from '../../app/apiTargets';
import { Field, SettingSection } from './SettingsPrimitives';

type ProfileDocument = { kind: 'SOUL' | 'RULES' | 'ORIENTATION' | 'TOOLS' | 'DREAM_MEMORY'; markdown: string };
const profileDocumentKinds: ProfileDocument['kind'][] = ['SOUL', 'RULES', 'ORIENTATION', 'TOOLS', 'DREAM_MEMORY'];
const profileDocumentLabels: Record<ProfileDocument['kind'], string> = { SOUL: 'SOUL.md', RULES: 'RULES.md', ORIENTATION: 'ORIENTATION.md', TOOLS: 'TOOLS.md', DREAM_MEMORY: 'DreamMemory.md' };

export function AgentProfileDocuments({ agentId, targets }: { agentId: string; targets: ApiTarget[] }) {
  const owner = targetForResource(targets, agentId);
  const request = <T,>(path: string, init?: RequestInit) => apiForTarget<T>(owner.target, path, init);
  const [documents, setDocuments] = useState<ProfileDocument[]>(profileDocumentKinds.map(kind => ({ kind, markdown: '' })));
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
  return <SettingSection title="Profile documents"><p className="settings-description">These documents define this agent’s identity, operating rules, orientation, and verified environment facts.</p>{state === 'loading' ? <p className="settings-empty">Loading profile documents…</p> : <details className="profile-documents-accordion"><summary>Show profile documents</summary><div className="profile-documents-content">{documents.map((document, index) => <Field key={document.kind} label={profileDocumentLabels[document.kind]}><textarea value={document.markdown} onChange={event => setDocuments(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, markdown: event.target.value } : item))} rows={8} spellCheck="false" /></Field>)}{error && <p className="settings-request-error" role="alert">{error}</p>}<div className="card-actions"><button className="primary" onClick={() => void save()} disabled={state !== 'idle'}>{state === 'saving' ? 'Saving…' : 'Save profile documents'}</button></div></div></details>}</SettingSection>;
}

