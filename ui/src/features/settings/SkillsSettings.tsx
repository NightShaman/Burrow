import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { apiForTarget } from '../../app/api';
import { targetForResource, type ApiTarget } from '../../app/apiTargets';
import type { Agent } from '../../app/types';
import { Field, SettingSection } from './SettingsPrimitives';

type Skill = { id: string; name: string; description: string; content: string; lifecycle: string; global: boolean; source: 'sqlite'; version: string };
type Grants = { assignedSkillIds: string[]; globalSkillIds: string[] };
type Draft = { id: string; name: string; description: string; content: string; lifecycle: string; global: boolean };
const empty: Draft = { id: '', name: '', description: '', content: '', lifecycle: 'available', global: false };
const body = (value: unknown, method = 'PUT'): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

export function SkillsSettings({ agents, agentId, targets, configurationTarget, overflowTarget, agentView = false }: { agents: Agent[]; agentId: string; targets: ApiTarget[]; configurationTarget?: HTMLElement | null; overflowTarget?: HTMLElement | null; agentView?: boolean }) {
  const owner = targetForResource(targets, agentId);
  const request = <T,>(path: string, init?: RequestInit) => apiForTarget<T>(owner.target, path, init);
  const [skills, setSkills] = useState<Skill[]>([]);
  const [assignments, setAssignments] = useState<Record<string, Grants>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  const [importedFileName, setImportedFileName] = useState('');
  const importInputRef = useRef<HTMLInputElement>(null);
  const selectedAgent = agents.find(agent => agent.id === agentId) ?? agents[0];
  const selectedGrants = selectedAgent ? assignments[selectedAgent.id] : undefined;
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false); setError('');
    Promise.all([
      request<{ skills: Skill[] }>('/api/settings/skills', { signal: controller.signal }),
      Promise.all(agents.map(async agent => {
        const located = targetForResource(targets, agent.id);
        const grants = await apiForTarget<Grants>(located.target, `/api/agents/${encodeURIComponent(located.resourceId)}/skills`, { signal: controller.signal });
        return [agent.id, grants] as const;
      })),
    ]).then(([catalog, rows]) => {
      if (controller.signal.aborted) return;
      setSkills(catalog.skills); setAssignments(Object.fromEntries(rows)); setLoaded(true);
      setSelectedId(current => current && catalog.skills.some(skill => skill.id === current) ? current : null);
    }).catch(cause => { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : 'Could not load skills.'); setLoaded(true); } });
    return () => controller.abort();
  }, [owner.target.id, owner.resourceId, agents, targets, revision]);

  const selected = skills.find(skill => skill.id === selectedId);
  useEffect(() => { setDraft(selected ? { id: selected.id, name: selected.name, description: selected.description, content: selected.content, lifecycle: selected.lifecycle, global: selected.global } : empty); }, [selected]);
  const act = async (operation: () => Promise<unknown>) => { setBusy(true); setError(''); try { await operation(); setRevision(value => value + 1); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save skills.'); } finally { setBusy(false); } };
  const save = () => act(async () => {
    const url = selected ? `/api/settings/skills/${encodeURIComponent(selected.id)}` : '/api/settings/skills';
    const { id, ...updates } = draft;
    await request(url, body(selected ? updates : draft, selected ? 'PATCH' : 'POST'));
    if (!selected) setSelectedId(id);
  });
  const toggleAssignment = (agent: Agent, skillId: string) => act(async () => {
    const grants = assignments[agent.id]; if (!grants) return;
    const next = new Set(grants.assignedSkillIds); next.has(skillId) ? next.delete(skillId) : next.add(skillId);
    const located = targetForResource(targets, agent.id);
    await apiForTarget(located.target, `/api/agents/${encodeURIComponent(located.resourceId)}/skills`, body({ skillIds: [...next] }));
  });
  const importText = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    setImportedFileName('');
    if (!/\.(?:md|markdown|txt)$/i.test(file.name)) {
      setError('Choose a Markdown or plain-text skill file (.md, .markdown, or .txt).');
      return;
    }
    try {
      const content = await file.text();
      const baseName = file.name.replace(/\.(?:md|markdown|txt)$/i, '');
      const id = baseName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const name = baseName.replace(/[-_]+/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase());
      setSelectedId(null);
      setDraft({ ...empty, id, name, content });
      setImportedFileName(file.name);
    } catch {
      setImportedFileName('');
      setError(`Could not read “${file.name}”. Choose a readable Markdown or plain-text file.`);
    }
  };

  const editor = <SettingSection title={selected ? `Edit ${selected.name}` : 'Create text skill'}>
    <p className="hint">Database text skills have one shared copy. Filesystem and asset skills remain read-only.</p>
    {!selected && <div className="skill-import"><span className="skill-import-label">Import text skill</span><input ref={importInputRef} className="skill-import-input" type="file" aria-label="Import text skill" accept=".md,.markdown,.txt,text/markdown,text/plain" disabled={busy} onChange={event => { void importText(event.target.files?.[0]); event.target.value = ''; }} /><div className="skill-import-control"><button type="button" className="secondary skill-import-trigger" disabled={busy} onClick={() => importInputRef.current?.click()}>Choose text file</button><span className={importedFileName ? 'skill-import-name selected' : 'skill-import-name'} aria-live="polite">{importedFileName || 'No file selected'}</span></div><small>Markdown or plain text · .md, .markdown, .txt. Loads the complete file for review; nothing is saved until you create the skill.</small></div>}
    <div className="skill-fields">
      <Field label="ID"><input value={draft.id} disabled={busy || Boolean(selected)} onChange={event => setDraft({ ...draft, id: event.target.value })} placeholder="skill-id" /></Field>
      <Field label="Name"><input value={draft.name} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} /></Field>
      <Field label="Description"><input value={draft.description} disabled={busy} onChange={event => setDraft({ ...draft, description: event.target.value })} /></Field>
      <Field label="Lifecycle"><select value={draft.lifecycle} disabled={busy} onChange={event => setDraft({ ...draft, lifecycle: event.target.value })}>{['available', 'experimental', 'deprecated', 'disabled'].map(value => <option key={value}>{value}</option>)}</select></Field>
      <Field label="Content"><textarea rows={12} value={draft.content} disabled={busy} onChange={event => setDraft({ ...draft, content: event.target.value })} /></Field>
      <label className="skill-check"><input type="checkbox" checked={draft.global} disabled={busy} onChange={event => setDraft({ ...draft, global: event.target.checked })} /> Assign globally</label>
      <div className="skill-actions"><button type="button" disabled={busy || !draft.id.trim() || !draft.name.trim()} onClick={save}>{selected ? 'Save skill' : 'Create skill'}</button>{selected && <button type="button" className="danger" disabled={busy} onClick={() => { if (window.confirm(`Delete skill “${selected.name}”?`)) void act(async () => { await request(`/api/settings/skills/${encodeURIComponent(selected.id)}`, { method: 'DELETE' }); setSelectedId(null); }); }}>Delete skill</button>}</div>
    </div>
  </SettingSection>;

  const libraryAssignments = <SettingSection title="Assignments"><p className="hint">Assign the selected database skill globally or to specific agents. These are assignments, not separate copies.</p>{!selected ? <p className="hint">Select a database skill to manage assignments.</p> : selected.global ? <p><strong>Global</strong><br /><small>Available to every agent.</small></p> : agents.length ? agents.map(agent => <label className="skill-check" key={agent.id}><input type="checkbox" checked={assignments[agent.id]?.assignedSkillIds.includes(selected.id) ?? false} disabled={busy} onChange={() => toggleAssignment(agent, selected.id)} /> {agent.name}</label>) : <p className="hint">No agents configured.</p>}</SettingSection>;
  const agentAssignments = <SettingSection title={`${selectedAgent?.name ?? 'Agent'} skills`}><p className="hint">Direct assignments supplement global skills. Filesystem and asset-backed skills are managed outside Settings.</p>{!selectedGrants ? <p className="hint">Loading assignments…</p> : <><h3>Database skills</h3>{skills.length ? skills.map(skill => <label className="skill-check" key={skill.id}><input type="checkbox" checked={selectedGrants.assignedSkillIds.includes(skill.id)} disabled={busy || selectedGrants.globalSkillIds.includes(skill.id)} onChange={() => selectedAgent && toggleAssignment(selectedAgent, skill.id)} /> {skill.name} {selectedGrants.globalSkillIds.includes(skill.id) && <small>(global)</small>}</label>) : <p className="hint">No database text skills.</p>}</>}</SettingSection>;

  return <>
    {!agentView && <nav className="settings-prototype-section-items skill-library" aria-label="Skills library"><button type="button" className={!selectedId ? 'active' : ''} onClick={() => setSelectedId(null)}>New text skill</button>{skills.map(skill => <button type="button" key={skill.id} className={selectedId === skill.id ? 'active' : ''} onClick={() => setSelectedId(skill.id)}>{skill.name}<small>{skill.id}{skill.global ? ' · global' : ''}</small></button>)}</nav>}
    {error && <p className="settings-error" role="alert">{error}</p>}{!loaded && <p className="hint">Loading skills…</p>}
    {loaded && (agentView ? agentAssignments : <>{configurationTarget && createPortal(editor, configurationTarget)}{overflowTarget && createPortal(libraryAssignments, overflowTarget)}</>)}
  </>;
}
