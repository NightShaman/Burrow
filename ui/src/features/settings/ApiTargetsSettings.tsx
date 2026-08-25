import { useCallback, useEffect, useState } from 'react';
import { apiLocal } from '../../app/api';
import { apiTargetsChangedEvent, normalizeApiTarget, type ApiTarget, type ApiTargetContribution } from '../../app/apiTargets';
import { useConfirm } from '../../app/ConfirmDialog';
import { Field, SettingSection } from './SettingsPrimitives';

type TargetResponse = { ok: true; target?: unknown; targets?: unknown };
type DraftTarget = { id: string; name: string; baseUrl: string; enabled: boolean };
const emptyDraft = (): DraftTarget => ({ id: '', name: '', baseUrl: '', enabled: true });

function errorMessage(cause: unknown, action: string) {
  return cause instanceof Error ? `${action}: ${cause.message}` : `${action}.`;
}

export function ApiTargetsSettings({ contribution }: { contribution: ApiTargetContribution }) {
  const confirm = useConfirm();
  const [targets, setTargets] = useState<ApiTarget[]>([]);
  const [draft, setDraft] = useState<DraftTarget>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [status, setStatus] = useState<'loading' | 'idle' | 'saving' | 'deleting'>('loading');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    setStatus('loading'); setError('');
    try {
      const response = await apiLocal<TargetResponse>(contribution.endpoint);
      const values = Array.isArray(response.targets) ? response.targets : [];
      setTargets(values.map(normalizeApiTarget).filter((target): target is ApiTarget => Boolean(target)));
    } catch (cause) { setError(errorMessage(cause, 'Could not load API targets')); }
    finally { setStatus('idle'); }
  }, [contribution.endpoint]);

  useEffect(() => { void load(); }, [load]);

  const reset = () => { setDraft(emptyDraft()); setEditingId(null); setError(''); };
  const edit = (target: ApiTarget) => { setDraft({ ...target }); setEditingId(target.id); setError(''); };
  const save = async () => {
    const id = draft.id.trim(); const name = draft.name.trim(); const baseUrl = draft.baseUrl.trim();
    if (!id || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) return setError('Target ID must use letters, numbers, dots, underscores, or hyphens.');
    if (!name) return setError('Target name is required.');
    let normalizedUrl = '';
    try { const url = new URL(baseUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); normalizedUrl = url.toString().replace(/\/$/, ''); }
    catch { return setError('Base URL must be a valid http or https URL.'); }
    setStatus('saving'); setError('');
    try {
      const body = { id, name, baseUrl: normalizedUrl, enabled: draft.enabled };
      const endpoint = editingId ? `${contribution.endpoint}/${encodeURIComponent(editingId)}` : contribution.endpoint;
      const response = await apiLocal<TargetResponse>(endpoint, { method: editingId ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const saved = normalizeApiTarget(response.target);
      if (!saved) await load();
      else setTargets((current) => editingId ? current.map((target) => target.id === editingId ? saved : target) : [...current, saved]);
      reset(); window.dispatchEvent(new Event(apiTargetsChangedEvent));
    } catch (cause) { setError(errorMessage(cause, 'Could not save API target')); }
    finally { setStatus('idle'); }
  };
  const remove = async (target: ApiTarget) => {
    if (!await confirm({ title: 'Delete API target?', message: `Delete ${target.name}? Agents and sessions owned by that runtime will no longer appear.`, confirmLabel: 'Delete target', tone: 'danger' })) return;
    setStatus('deleting'); setError('');
    try {
      await apiLocal(`${contribution.endpoint}/${encodeURIComponent(target.id)}`, { method: 'DELETE' });
      setTargets((current) => current.filter((item) => item.id !== target.id));
      if (editingId === target.id) reset();
      window.dispatchEvent(new Event(apiTargetsChangedEvent));
    } catch (cause) { setError(errorMessage(cause, 'Could not delete API target')); }
    finally { setStatus('idle'); }
  };

  return <div className="api-target-settings">
    <SettingSection title={editingId ? 'Edit API target' : 'Add API target'}>
      <p className="settings-description">Connect another Burrow runtime so its agents and owned resources appear in this UI.</p>
      <div className="field-pair compact-fields"><Field label="Target ID"><input value={draft.id} onChange={(event) => setDraft((current) => ({ ...current, id: event.target.value }))} disabled={Boolean(editingId) || status !== 'idle'} placeholder="node-one" /></Field><Field label="Name"><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} disabled={status !== 'idle'} placeholder="Node One" /></Field></div>
      <Field label="Base URL"><input type="url" value={draft.baseUrl} onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))} disabled={status !== 'idle'} placeholder="http://node-one:8787" /></Field>
      <label className="api-target-enabled"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} disabled={status !== 'idle'} /> Enabled</label>
      <div className="setting-actions">{editingId && <button className="secondary" type="button" onClick={reset} disabled={status !== 'idle'}>Cancel</button>}<button className="primary" type="button" onClick={() => void save()} disabled={status !== 'idle'}>{status === 'saving' ? 'Saving…' : editingId ? 'Save target' : 'Add target'}</button></div>
      {error && <p className="settings-request-error" role="alert">{error}</p>}
    </SettingSection>
    <SettingSection title="Configured targets">
      {status === 'loading' ? <p className="settings-empty">Loading API targets…</p> : targets.length === 0 ? <p className="settings-empty">No remote API targets configured.</p> : <div className="api-target-list">{targets.map((target) => <article className="api-target-card" key={target.id}><div><strong>{target.name}</strong><small>{target.baseUrl}</small><span>{target.id} · {target.enabled ? 'Enabled' : 'Disabled'}</span></div><div className="api-target-actions"><button className="secondary" type="button" onClick={() => edit(target)} disabled={status !== 'idle'}>Edit</button><button className="danger" type="button" onClick={() => void remove(target)} disabled={status !== 'idle'}>Delete</button></div></article>)}</div>}
    </SettingSection>
  </div>;
}
