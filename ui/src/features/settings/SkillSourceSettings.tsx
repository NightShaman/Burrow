import { useEffect, useRef, useState } from 'react';
import { api, fetchApi } from '../../app/api';
import { useConfirm } from '../../app/ConfirmDialog';
import { Field, SettingSection } from './SettingsPrimitives';

export type GitSkillSource = { repository: string; ref: string; path: string; enabled: boolean; cron: string | null; timezone: string; fetchTimeoutMs: number; syncing?: boolean; syncExpiresAt?: string | null; nextSyncAt?: string | null; lastCheckedAt?: string | null; lastSuccessAt?: string | null; installedRevision?: string | null; observedRevision?: string | null; lastError?: string | null };
export type SkillRecord = { id: string; name: string; description: string; content: string; lifecycle: string; global: boolean; source: string; version: string; createdAt?: string; updatedAt?: string; storage?: string; contentOwner?: string; installedPath?: string | null; installedHash?: string | null; gitSource?: GitSkillSource | null };
type Receipt = { id: string; status: string; revision: string | null; contentHash: string | null; error: string | null; startedAt: string; completedAt: string | null };
type Artifact = { path: string; bytes: number; executable: boolean };
const localTime = (value: string | null | undefined) => { if (!value) return '—'; const date = new Date(value); return Number.isNaN(date.getTime()) ? 'Unavailable' : date.toLocaleString(); };
const defaults: GitSkillSource = { repository: '', ref: 'main', path: '.', enabled: false, cron: '0 */6 * * *', timezone: 'UTC', fetchTimeoutMs: 120000 };
const sourceDraft = (source: GitSkillSource | null | undefined): GitSkillSource => source ? { ...source, cron: source.cron ?? defaults.cron } : defaults;
const json = (method: string, value: unknown): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

export function SkillSourceSettings({ skill, onRefresh, compact = false }: { skill: SkillRecord; onRefresh: () => void; compact?: boolean }) {
  const confirm = useConfirm();
  const base = `/api/settings/skills/${encodeURIComponent(skill.id)}`;
  const [source, setSource] = useState<GitSkillSource | null>(skill.gitSource ?? null);
  const [draft, setDraft] = useState<GitSkillSource>(sourceDraft(skill.gitSource));
  const [history, setHistory] = useState<Receipt[]>([]);
  const [cursor, setCursor] = useState<string | number | null>(null);
  const [files, setFiles] = useState<Artifact[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  const dirty = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    Promise.all([
      api<{ source: GitSkillSource | null }>(`${base}/source`, { signal: controller.signal }),
      api<{ history: Receipt[]; nextCursor: string | number | null }>(`${base}/history?limit=50`, { signal: controller.signal }),
      api<{ files: Artifact[] }>(`${base}/files`, { signal: controller.signal }),
    ]).then(([result, receipts, artifacts]) => {
      if (controller.signal.aborted) return;
      setSource(result.source ?? null); if (!dirty.current) setDraft(sourceDraft(result.source));
      setHistory(receipts.history ?? []); setCursor(receipts.nextCursor ?? null); setFiles(artifacts.files ?? []); setLoaded(true);
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
  const save = () => act(async () => {
    const { repository, ref, path, enabled, cron, timezone, fetchTimeoutMs } = draft;
    await api(`${base}/source`, json('PUT', { repository, ref, path, enabled, cron, timezone, fetchTimeoutMs }));
    dirty.current = false;
    setNotice('Source saved. Sync to install upstream content.');
  });
  const detach = async () => {
    if (busy || !loaded) return;
    if (!await confirm({ title: 'Remove Git source?', message: 'Keep the installed text and assignments as operator-managed content. Automatic updates will stop.', confirmLabel: 'Remove source', tone: 'danger' }) || !mounted.current) return;
    await act(async () => { await api(`${base}/source`, { method: 'DELETE' }); dirty.current = false; setNotice('Source removed; installed text retained.'); });
  };
  const download = (file: Artifact) => act(async () => {
    const response = await fetchApi(`${base}/files/${encodeURIComponent(file.path)}`);
    if (!response.ok) throw new Error(`Download failed (HTTP ${response.status}).`);
    const url = URL.createObjectURL(await response.blob());
    const link = document.createElement('a'); link.href = url; link.download = file.path.split('/').pop() || 'artifact'; link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, false);
  return <>
    {error && <p role="alert" className="settings-error">{error}<button type="button" disabled={busy} onClick={() => { setError(''); setRevision(value => value + 1); }}>Retry source</button></p>}
    {notice && <p role="status" className="hint">{notice}</p>}
    <SettingSection title="Source">
      {compact && source && <p className="hint"><strong>{source.repository}</strong><br />{source.ref} · {source.path}</p>}
      <details className="skill-disclosure" open={compact ? undefined : true}><summary>Installed details &amp; source settings</summary>
      <dl className="skill-source-facts"><dt>Storage</dt><dd>{skill.storage ?? skill.source}</dd><dt>Ownership</dt><dd>{skill.contentOwner ?? 'Not supplied by catalog'}</dd><dt>Installed content version</dt><dd><code>{skill.installedHash ?? skill.version}</code></dd>{skill.installedPath && <><dt>Installed path</dt><dd><code>{skill.installedPath}</code></dd></>}</dl>
      {!loaded && !error && <p role="status">Loading source…</p>}
      <fieldset disabled={!loaded || busy || source?.syncing} className="skill-source-fields" onChange={() => { dirty.current = true; }}>
        <Field label="Repository"><input value={draft.repository} onChange={e => setDraft({ ...draft, repository: e.target.value })} placeholder="HTTPS, SSH, or absolute local Git path" /></Field>
        <Field label="Ref"><input value={draft.ref} onChange={e => setDraft({ ...draft, ref: e.target.value })} /></Field>
        <Field label="Skill path"><input value={draft.path} onChange={e => setDraft({ ...draft, path: e.target.value })} /></Field>
        <label className="skill-check"><input type="checkbox" checked={draft.enabled} onChange={e => setDraft({ ...draft, enabled: e.target.checked })} /> Automatic sync</label>
        <Field label="Sync schedule"><input value={draft.cron ?? ''} onChange={e => setDraft({ ...draft, cron: e.target.value })} /></Field>
        <Field label="Sync timezone"><input value={draft.timezone} onChange={e => setDraft({ ...draft, timezone: e.target.value })} /></Field>
        <Field label="Fetch timeout (ms)"><input type="number" min="1" max="2147483647" value={draft.fetchTimeoutMs} onChange={e => setDraft({ ...draft, fetchTimeoutMs: Number(e.target.value) })} /></Field>
        <p className="hint">Path selects SKILL.md or its package directory. Pinned tags and commits do not follow new commits. Disabling automatic sync retains installed content. Private HTTPS credentials are not configured here.</p>
        <div className="skill-actions"><button type="button" disabled={!draft.repository.trim() || !draft.ref.trim() || !draft.path.trim() || (draft.enabled && !draft.cron?.trim()) || !draft.timezone.trim() || !Number.isInteger(draft.fetchTimeoutMs) || draft.fetchTimeoutMs <= 0 || draft.fetchTimeoutMs > 2147483647} onClick={save}>{source ? 'Save source' : 'Connect Git source'}</button>{source && <button type="button" className="danger" disabled={skill.storage === 'filesystem'} onClick={() => void detach()}>Remove source</button>}</div>
      </fieldset>
      {source && skill.storage === 'filesystem' && <p className="hint">Packages cannot be detached without copying. Disable automatic sync to retain artifacts without scheduled updates.</p>}
      </details>
    </SettingSection>
    <SettingSection title="Update status">
      {source ? <><p role="status">{source.syncing ? 'Sync in progress' : source.lastError ? 'Last sync failed; installed content retained' : source.lastSuccessAt ? 'Installed upstream content' : 'Not synced yet'}</p><details className="skill-disclosure" open={compact ? undefined : true}><summary>Sync details</summary><dl className="skill-source-facts">{Object.entries({ 'Installed revision': source.installedRevision, 'Observed revision': source.observedRevision, 'Last checked': localTime(source.lastCheckedAt), 'Last success': localTime(source.lastSuccessAt), 'Next automatic sync': source.enabled ? localTime(source.nextSyncAt) : 'Disabled', 'Last error': source.lastError }).map(([label, value]) => <span key={label}><dt>{label}</dt><dd>{value || '—'}</dd></span>)}</dl></details><button type="button" disabled={!loaded || busy || source.syncing} onClick={() => void act(async () => { const result = await api<{ status: string }>(`${base}/sync`, json('POST', {})); setNotice(`Sync ${result.status}.`); })}>Sync now</button><button type="button" className="secondary" disabled={busy} onClick={() => { setRevision(value => value + 1); onRefresh(); }}>Refresh status</button></> : <p className="hint">{skill.contentOwner && skill.contentOwner !== 'operator' ? 'No Git update source. Instructions are managed by the installation.' : 'No Git source connected. Use Edit text to change instructions.'}</p>}
    </SettingSection>
    <details className="skill-disclosure" open={compact ? undefined : true}><summary>Sync history</summary><SettingSection title="Recorded syncs">
      {history.length ? <ol className="skill-sync-history">{history.map(receipt => <li key={receipt.id}><strong>{receipt.status}</strong><small>{localTime(receipt.completedAt ?? receipt.startedAt)}</small>{receipt.revision && <code>{receipt.revision}</code>}{receipt.contentHash && <code>{receipt.contentHash}</code>}{receipt.error && <p className="settings-error">{receipt.error}</p>}</li>)}</ol> : <p className="hint">No sync attempts recorded.</p>}
      {cursor != null && <button type="button" className="secondary" disabled={busy} onClick={() => void act(async () => { const result = await api<{ history: Receipt[]; nextCursor: string | number | null }>(`${base}/history?limit=50&before=${encodeURIComponent(cursor)}`); setHistory(rows => [...rows, ...result.history.filter(row => !rows.some(old => old.id === row.id))]); setCursor(result.nextCursor); }, false)}>Load older syncs</button>}
    </SettingSection>
    </details><details className="skill-disclosure" open={compact ? undefined : true}><summary>Package files ({files.length})</summary><SettingSection title="Package artifacts">{files.length ? <ul className="skill-artifacts">{files.map(file => <li key={file.path}><code>{file.path}</code><small>{file.bytes.toLocaleString()} bytes{file.executable ? ' · executable' : ''}</small><button type="button" className="secondary" disabled={busy} onClick={() => void download(file)}>Download {file.path}</button></li>)}</ul> : <p className="hint">No supporting artifacts. Instructions are shown in the reading pane.</p>}<p className="hint">Downloads are files, never executed by this interface.</p></SettingSection></details>
  </>;
}
