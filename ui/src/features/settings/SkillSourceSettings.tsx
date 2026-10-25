import { useEffect, useRef, useState } from 'react';
import { api } from '../../app/api';
import { useConfirm } from '../../app/ConfirmDialog';
import { useUnsavedChanges } from '../../app/UnsavedChanges';
import { Field, SettingSection } from './SettingsPrimitives';

export type GitSkillSource = { repository: string; ref: string; path: string; enabled: boolean; cron: string | null; timezone?: string; effectiveTimezone?: string; fetchTimeoutMs: number; syncing?: boolean; syncExpiresAt?: string | null; nextSyncAt?: string | null; lastCheckedAt?: string | null; lastSuccessAt?: string | null; installedRevision?: string | null; observedRevision?: string | null; lastError?: string | null };
export type SkillRecord = { id: string; name: string; description: string; content: string; lifecycle: string; global: boolean; source: string; version: string; createdAt?: string; updatedAt?: string; storage?: string; contentOwner?: string; installedPath?: string | null; installedHash?: string | null; gitSource?: GitSkillSource | null };
const defaults: GitSkillSource = { repository: '', ref: 'main', path: '.', enabled: false, cron: '0 */6 * * *', fetchTimeoutMs: 120000 };
const sourceDraft = (source: GitSkillSource | null | undefined): GitSkillSource => source ? { ...source, cron: source.cron ?? defaults.cron } : defaults;
const editable = (source: GitSkillSource) => { const { repository, ref, path, enabled, cron, fetchTimeoutMs } = source; return { repository, ref, path, enabled, cron, fetchTimeoutMs }; };
const json = (method: string, value: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

export function SkillSourceSettings({ skill, onRefresh }: { skill: SkillRecord; onRefresh: () => void }) {
  const confirm = useConfirm();
  const base = `/api/settings/skills/${encodeURIComponent(skill.id)}`;
  const [source, setSource] = useState<GitSkillSource | null>(skill.gitSource ?? null);
  const [draft, setDraft] = useState<GitSkillSource>(sourceDraft(skill.gitSource));
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const baseline = useRef(sourceDraft(skill.gitSource));
  const saving = useRef(false);
  const dirty = useRef(false);
  const currentDraft = useRef(draft);
  currentDraft.current = draft;
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    api<{ source: GitSkillSource | null }>(`${base}/source`, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setSource(result.source ?? null); if (!dirty.current) { baseline.current = sourceDraft(result.source); setDraft(sourceDraft(result.source)); } setLoaded(true);
    }).catch(cause => { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : 'Could not load source.'); setLoaded(false); } });
    return () => controller.abort();
  }, [base, revision]);
  // Recover scheduled or in-flight syncs without inventing a terminal outcome.
  useEffect(() => {
    if (!source?.syncing) return;
    const timer = window.setTimeout(() => { setRevision(value => value + 1); onRefresh(); }, 3000);
    return () => window.clearTimeout(timer);
  }, [source, onRefresh]);
  const act = async (operation: () => Promise<void>, refresh = true) => {
    setBusy(true); setError(''); setNotice('');
    try { await operation(); } catch (cause) { setError((cause instanceof Error || cause instanceof DOMException) && /abort|deadline|timeout/i.test(cause.message) ? 'Request timed out; synchronization may still be running. Refresh status to check its recorded outcome.' : cause instanceof Error ? cause.message : 'Source operation failed.'); }
    finally { if (!mounted.current) return; setBusy(false); if (refresh) { setRevision(value => value + 1); onRefresh(); } }
  };
  const save = async (): Promise<boolean> => {
    if (saving.current || busy || !loaded || source?.syncing) return false;
    const snapshot = editable(draft);
    if (!snapshot.repository.trim() || !snapshot.ref.trim() || !snapshot.path.trim() || (snapshot.enabled && !snapshot.cron?.trim()) || !Number.isInteger(snapshot.fetchTimeoutMs) || snapshot.fetchTimeoutMs <= 0 || snapshot.fetchTimeoutMs > 2147483647) { setError('Enter a repository, ref, path, and valid sync settings.'); return false; }
    saving.current = true; setBusy(true); setError(''); setNotice('');
    try {
      await api(`${base}/source`, json('PUT', snapshot));
      baseline.current = { ...baseline.current, ...snapshot };
      dirty.current = JSON.stringify(editable(currentDraft.current)) !== JSON.stringify(snapshot);
      setNotice('Source saved. Sync to install upstream content.');
      setRevision(value => value + 1); onRefresh();
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save source.'); return false; }
    finally { saving.current = false; if (mounted.current) setBusy(false); }
  };
  useUnsavedChanges({ dirty: loaded && JSON.stringify(editable(draft)) !== JSON.stringify(editable(baseline.current)), busy, save, discard: () => { setDraft(baseline.current); dirty.current = false; setError(''); } });
  const detach = async () => {
    if (busy || !loaded) return;
    if (!await confirm({ title: 'Remove Git source?', message: 'Keep the installed text and assignments as operator-managed content. Automatic updates will stop.', confirmLabel: 'Remove source', tone: 'danger' }) || !mounted.current) return;
    await act(async () => { await api(`${base}/source`, { method: 'DELETE' }); dirty.current = false; setNotice('Source removed; installed text retained.'); });
  };
  return <>
    {error && <p role="alert" className="settings-error">{error}<button type="button" disabled={busy} onClick={() => { setError(''); setRevision(value => value + 1); }}>Retry source</button></p>}
    {notice && <p role="status" className="hint">{notice}</p>}
    <SettingSection title="Source">
      {!loaded && !error && <p role="status">Loading source…</p>}
      <fieldset disabled={!loaded || busy || source?.syncing} className="skill-source-fields" onChange={() => { dirty.current = true; }}>
        <Field label="Repository"><input value={draft.repository} onChange={e => setDraft({ ...draft, repository: e.target.value })} placeholder="HTTPS, SSH, or absolute local Git path" /></Field>
        <div className="field-pair skill-field-pair skill-ref-path"><Field label="Ref"><input value={draft.ref} onChange={e => setDraft({ ...draft, ref: e.target.value })} /></Field>
        <Field label="Skill path"><input value={draft.path} onChange={e => setDraft({ ...draft, path: e.target.value })} /></Field>
        </div><label className="skill-check"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} /> Automatic sync</label>
        <div className="field-pair skill-field-pair"><Field label="Sync schedule"><input value={draft.cron ?? ''} onChange={e => setDraft({ ...draft, cron: e.target.value })} /><small className="field-hint">Uses the operator timezone.</small></Field>
        <Field label="Fetch timeout (ms)"><input type="number" min="1" max="2147483647" value={draft.fetchTimeoutMs} onChange={e => setDraft({ ...draft, fetchTimeoutMs: Number(e.target.value) })} /></Field></div><p className="hint">Path selects SKILL.md or its package directory. Pinned tags and commits do not follow new commits. Disabling automatic sync retains installed content. Private HTTPS credentials are not configured here.</p>
        <div className="model-actions"><button type="button" disabled={!draft.repository.trim() || !draft.ref.trim() || !draft.path.trim() || (draft.enabled && !draft.cron?.trim()) || !Number.isInteger(draft.fetchTimeoutMs) || draft.fetchTimeoutMs <= 0 || draft.fetchTimeoutMs > 2147483647} onClick={() => void save()}>{source ? 'Save source' : 'Connect Git source'}</button>{source && <button type="button" className="danger" disabled={skill.storage === 'filesystem'} onClick={() => void detach()}>Remove source</button>}</div>
      </fieldset>
      {source && skill.storage === 'filesystem' && <p className="hint">Packages cannot be detached without copying. Disable automatic sync to retain artifacts without scheduled updates.</p>}
    </SettingSection>
    {source && <SettingSection title="Updates">
      {source.syncing && <p role="status">Sync in progress…</p>}
      {source.lastError && <p className="settings-request-error" role="alert">Last update failed: {source.lastError}. Installed content retained.</p>}
      <div className="model-actions"><button type="button" disabled={!loaded || busy || source.syncing} onClick={() => void act(async () => { const result = await api<{ status: string }>(`${base}/sync`, json('POST', {})); setNotice(`Sync ${result.status}.`); })}>Sync now</button><button type="button" className="secondary" disabled={busy} onClick={() => { setRevision(value => value + 1); onRefresh(); }}>Refresh status</button></div>
    </SettingSection>}
  </>;
}
