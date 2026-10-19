import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../app/api';
import { Field, SettingSection } from './SettingsPrimitives';

type ProfileDocument = { kind: 'SOUL' | 'RULES' | 'ORIENTATION' | 'PREFERENCES' | 'TOOLS' | 'DREAM_MEMORY'; markdown: string };
type GlobalProfile = { useGlobalRules: boolean; useGlobalOrientation: boolean };
const profileDocumentKinds: ProfileDocument['kind'][] = ['SOUL', 'RULES', 'ORIENTATION', 'PREFERENCES', 'TOOLS', 'DREAM_MEMORY'];
const profileDocumentLabels: Record<ProfileDocument['kind'], string> = { SOUL: 'SOUL.md', RULES: 'RULES.md', ORIENTATION: 'ORIENTATION.md', PREFERENCES: 'PREFERENCES.md', TOOLS: 'TOOLS.md', DREAM_MEMORY: 'DreamMemory.md' };
const emptyDocuments = () => profileDocumentKinds.map(kind => ({ kind, markdown: '' }));
const emptyGlobalProfile = (): GlobalProfile => ({ useGlobalRules: false, useGlobalOrientation: false });

export function AgentProfileDocuments({ agentId, overflowTarget }: { agentId: string; overflowTarget?: HTMLElement | null }) {
  const resourceId = agentId.includes('::') ? agentId.slice(agentId.indexOf('::') + 2) : agentId;
  const request = <T,>(path: string, init?: RequestInit) => api<T>(path, init);
  const [documents, setDocuments] = useState<ProfileDocument[]>(emptyDocuments);
  const [globalProfile, setGlobalProfile] = useState<GlobalProfile>(emptyGlobalProfile);
  const [selectedKind, setSelectedKind] = useState<ProfileDocument['kind']>('SOUL');
  const [state, setState] = useState<'loading' | 'idle' | 'saving' | 'error'>('loading');
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState('');
  const requestVersion = useRef(0);

  useEffect(() => {
    const version = ++requestVersion.current;
    const controller = new AbortController();
    setState('loading'); setError(''); setDocuments(emptyDocuments()); setGlobalProfile(emptyGlobalProfile());
    request<{ documents: ProfileDocument[]; globalProfile: GlobalProfile }>(`/api/agents/${encodeURIComponent(resourceId)}/profile-documents`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted || requestVersion.current !== version) return;
      const byKind = new Map((result.documents ?? []).map(document => [document.kind, document.markdown]));
      setDocuments(profileDocumentKinds.map(kind => ({ kind, markdown: byKind.get(kind) ?? '' })));
      setGlobalProfile({ useGlobalRules: result.globalProfile?.useGlobalRules === true, useGlobalOrientation: result.globalProfile?.useGlobalOrientation === true });
      setState('idle');
    }).catch(cause => {
      if (controller.signal.aborted || requestVersion.current !== version) return;
      setError(cause instanceof Error ? `Could not load profile documents: ${cause.message}` : 'Could not load profile documents.');
      setState('error');
    });
    return () => controller.abort();
  }, [agentId, retry]);
  const save = async () => {
    if (state !== 'idle') return;
    const version = requestVersion.current;
    setState('saving'); setError('');
    try { await request(`/api/agents/${encodeURIComponent(resourceId)}/profile-documents`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ documents, globalProfile }) }); }
    catch (cause) { if (requestVersion.current === version) setError(cause instanceof Error ? `Could not save profile documents: ${cause.message}` : 'Could not save profile documents.'); }
    finally { if (requestVersion.current === version) setState('idle'); }
  };
  const update = (kind: ProfileDocument['kind'], markdown: string) => setDocuments(current => current.map(item => item.kind === kind ? { ...item, markdown } : item));
  const globalControls = <fieldset className="profile-global-controls" disabled={state !== 'idle'}><legend>Global documents</legend>
    <label><input type="checkbox" checked={globalProfile.useGlobalRules} onChange={event => setGlobalProfile(current => ({ ...current, useGlobalRules: event.target.checked }))} /><span><strong>Include Global Rules</strong><small>{globalProfile.useGlobalRules ? 'Global Rules first, then this agent’s RULES.md.' : 'Use only this agent’s RULES.md.'}</small></span></label>
    <label><input type="checkbox" checked={globalProfile.useGlobalOrientation} onChange={event => setGlobalProfile(current => ({ ...current, useGlobalOrientation: event.target.checked }))} /><span><strong>Include Global Orientation</strong><small>{globalProfile.useGlobalOrientation ? 'Global Orientation first, then this agent’s ORIENTATION.md.' : 'Use only this agent’s ORIENTATION.md.'}</small></span></label>
  </fieldset>;

  if (overflowTarget) {
    const selected = documents.find(document => document.kind === selectedKind) ?? documents[0];
    const overflow = <div className="settings-overflow-content profile-document-overflow"><SettingSection title={profileDocumentLabels[selected.kind]}><Field label="Markdown"><textarea value={selected.markdown} disabled={state !== 'idle'} onChange={event => update(selected.kind, event.target.value)} rows={24} spellCheck="false" /></Field>{error && <p className="settings-request-error" role="alert">{error}</p>}<div className="card-actions"><button className="primary" type="button" onClick={() => void save()} disabled={state !== 'idle'}>{state === 'saving' ? 'Saving…' : 'Save profile documents'}</button></div></SettingSection></div>;
    return <><SettingSection title="Profile documents">{state === 'error' && <button type="button" onClick={() => setRetry(value => value + 1)}>Retry loading</button>}<p className="settings-description">Choose a local profile document to edit.</p>{state === 'loading' ? <p className="settings-empty">Loading profile documents…</p> : <>{globalControls}<div className="profile-document-selector">{documents.map(document => <button type="button" className={document.kind === selected.kind ? 'active' : ''} aria-pressed={document.kind === selected.kind} onClick={() => setSelectedKind(document.kind)} key={document.kind}><strong>{profileDocumentLabels[document.kind]}</strong></button>)}</div></>}{error && <p className="settings-request-error" role="alert">{error}</p>}</SettingSection>{createPortal(overflow, overflowTarget)}</>;
  }

  return <SettingSection title="Profile documents">{state === 'error' && <button type="button" onClick={() => setRetry(value => value + 1)}>Retry loading</button>}<p className="settings-description">These local documents define this agent’s identity, operating rules, orientation, and verified environment facts.</p>{state === 'loading' ? <p className="settings-empty">Loading profile documents…</p> : <>{globalControls}<details className="profile-documents-accordion"><summary>Show local profile documents</summary><div className="profile-documents-content">{documents.map(document => <Field key={document.kind} label={profileDocumentLabels[document.kind]}><textarea value={document.markdown} onChange={event => update(document.kind, event.target.value)} rows={8} spellCheck="false" /></Field>)}{error && <p className="settings-request-error" role="alert">{error}</p>}<div className="card-actions"><button className="primary" onClick={() => void save()} disabled={state !== 'idle'}>{state === 'saving' ? 'Saving…' : 'Save profile documents'}</button></div></div></details></>}</SettingSection>;
}
