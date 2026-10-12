import { useEffect, useRef, useState } from 'react';
import { api, jsonMutation } from '../../app/api';
import type { GitSkillSource, SkillRecord } from './SkillSourceSettings';
import { Field, SettingSection } from './SettingsPrimitives';

type Source = Omit<GitSkillSource, 'cron'> & { cron: string | null };
export type SkillPreview = { name: string; description: string; content: string; suggestedId: string; storage: string; revision: string; contentHash: string; files: { path: string; bytes: number; executable: boolean }[]; source: Source };
const initial = { repository: '', path: '', ref: 'HEAD', enabled: false, cron: '0 */6 * * *', fetchTimeoutMs: 120000 };

export function SkillRepositoryImport({ onInstalled }: { onInstalled: (skill: SkillRecord) => void }) {
  const [draft, setDraft] = useState(initial);
  const [preview, setPreview] = useState<SkillPreview | null>(null);
  const [id, setId] = useState('');
  const [global, setGlobal] = useState(false);
  const [lifecycle, setLifecycle] = useState('available');
  const [busy, setBusy] = useState<'preview' | 'install' | null>(null);
  const [error, setError] = useState('');
  const request = useRef<AbortController | null>(null);
  useEffect(() => () => request.current?.abort(), []);
  const valid = draft.repository.trim() && draft.path.trim() && draft.ref.trim() && (!draft.enabled || draft.cron.trim()) && Number.isInteger(draft.fetchTimeoutMs) && draft.fetchTimeoutMs > 0 && draft.fetchTimeoutMs <= 2147483647;
  const change = (updates: Partial<typeof initial>) => { setDraft(value => ({ ...value, ...updates })); setPreview(null); setError(''); };
  const run = async (install: boolean) => {
    if (request.current || !valid || (install && (!preview || !id.trim()))) return;
    const controller = new AbortController(); request.current = controller;
    setBusy(install ? 'install' : 'preview'); setError('');
    try {
      if (install && preview) {
        const { repository, ref, path, enabled, cron, fetchTimeoutMs } = preview.source;
        const result = await api<{ skill: SkillRecord }>('/api/settings/skills/git/import', jsonMutation('POST', { repository, ref, path, enabled, cron, fetchTimeoutMs, id: id.trim(), global, lifecycle, expectedRevision: preview.revision }, { signal: controller.signal }));
        if (!controller.signal.aborted) onInstalled(result.skill);
      } else {
        const result = await api<{ preview: SkillPreview }>('/api/settings/skills/git/preview', jsonMutation('POST', { ...draft, repository: draft.repository.trim(), path: draft.path.trim(), cron: draft.enabled ? draft.cron : null }, { signal: controller.signal }));
        if (!controller.signal.aborted) { setPreview(result.preview); setId(result.preview.suggestedId); }
      }
    } catch (cause) {
      if (controller.signal.aborted) return;
      const message = (cause instanceof Error || cause instanceof DOMException) ? cause.message : 'Repository request failed.';
      if (message === 'skill_revision_changed') { setPreview(null); setError('The repository changed since your preview. Preview again before installing. Nothing was installed by this request.'); }
      else if (message === 'skill_already_exists') setError('A skill with this ID already exists. It has not been overwritten. Choose a different ID or select the installed skill in the library.');
      else if (/timeout|deadline|abort/i.test(message)) { if (install) setPreview(null); setError(install ? 'The install response timed out. Reload the library to check whether it completed before trying again.' : 'Preview timed out. Check the repository and try again.'); }
      else setError(message);
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setBusy(null);
    }
  };
  return <SettingSection title="Repository import">
    <p className="hint">Choose a repository and a skill directory. Preview the real instructions and files before installing; no placeholder skill is created.</p>
    <fieldset className="skill-source-fields" disabled={Boolean(busy)}>
      <Field label="Repository"><input value={draft.repository} onChange={e => change({ repository: e.target.value })} placeholder="HTTPS, SSH, or absolute local Git path" /></Field>
      <Field label="Skill path"><input value={draft.path} onChange={e => change({ path: e.target.value })} placeholder="skills/my-skill or ." /></Field>
      <p className="hint">Select a directory to include companion files, or SKILL.md for instructions only.</p>
      <details className="skill-disclosure"><summary>Ref &amp; automatic updates</summary><div className="skill-source-fields">
        <div className="skill-compact-field"><Field label="Ref"><input value={draft.ref} onChange={e => change({ ref: e.target.value })} /></Field>
</div><label className="skill-check"><input type="checkbox" checked={draft.enabled} onChange={e => change({ enabled: e.target.checked })} /> Automatic sync</label>
        <div className="field-pair skill-field-pair">{draft.enabled && <Field label="Sync schedule"><input value={draft.cron} onChange={e => change({ cron: e.target.value })} /></Field>}
        <Field label="Fetch timeout (ms)"><input type="number" min="1" max="2147483647" value={draft.fetchTimeoutMs} onChange={e => change({ fetchTimeoutMs: Number(e.target.value) })} /></Field>
        </div><p className="hint">HEAD uses the repository default. Tags and commits stay pinned. Automatic sync is off unless enabled. Sync schedules use the operator timezone.</p>
      </div></details>
      <button type="button" disabled={!valid} onClick={() => void run(false)}>{busy === 'preview' ? 'Fetching preview…' : preview ? 'Refresh preview' : 'Preview skill'}</button>
    </fieldset>
    {error && <p role="alert" className="settings-error">{error}</p>}
    {busy && <p role="status">{busy === 'preview' ? 'Fetching and validating the repository…' : 'Installing validated content and its source…'}</p>}
    {preview && <div className="skill-repository-preview">
      <h3>{preview.name}</h3><p className="hint">{preview.description || 'No description supplied.'}</p>
      <dl className="skill-source-facts"><dt>Storage</dt><dd>{preview.storage === 'filesystem' ? 'Package with companion files' : 'Text instructions'}</dd><dt>Previewed revision</dt><dd><code>{preview.revision}</code></dd></dl>
      <pre className="skill-instructions">{preview.content}</pre>
      <details className="skill-disclosure"><summary>Included files ({preview.files.length})</summary><ul className="skill-artifacts">{preview.files.map(file => <li key={file.path}><code>{file.path}</code><small>{file.bytes.toLocaleString()} bytes{file.executable ? ' · executable' : ''}</small></li>)}</ul><p className="hint">Files are installed, not executed by this interface.</p></details>
      <fieldset className="skill-source-fields" disabled={Boolean(busy)}>
        <details className="skill-disclosure"><summary>Install ID &amp; availability</summary><div className="skill-source-fields">
          <Field label="Install ID"><input value={id} onChange={e => { setId(e.target.value); setError(''); }} /></Field>
          <Field label="Lifecycle"><select value={lifecycle} onChange={e => setLifecycle(e.target.value)}>{['available', 'experimental', 'deprecated', 'disabled'].map(value => <option key={value}>{value}</option>)}</select></Field>
          <label className="skill-check"><input type="checkbox" checked={global} onChange={e => setGlobal(e.target.checked)} /> Assign globally</label>
        </div></details>
        <p className="hint">Install as <strong>{id || '—'}</strong>. {global ? 'Available to every agent.' : 'Assign to agents after installation.'}</p>
        <button type="button" disabled={!id.trim()} onClick={() => void run(true)}>{busy === 'install' ? 'Installing…' : 'Install skill'}</button>
      </fieldset>
    </div>}
  </SettingSection>;
}
