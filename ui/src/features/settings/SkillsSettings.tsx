import { createPortal } from 'react-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfirm } from '../../app/ConfirmDialog';
import { api } from '../../app/api';
import type { Agent } from '../../app/types';
import { SkillSourceSettings, type SkillRecord } from './SkillSourceSettings';
import { SkillRepositoryImport } from './SkillRepositoryImport';
import { Field, SettingSection } from './SettingsPrimitives';

type Skill = SkillRecord;
type Grants = { assignedSkillIds: string[]; globalSkillIds: string[] };
type Draft = { id: string; name: string; description: string; content: string; lifecycle: string; global: boolean };
const empty: Draft = { id: '', name: '', description: '', content: '', lifecycle: 'available', global: false };
const body = (value: unknown, method = 'PUT'): RequestInit => ({ method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });

export function SkillsSettings({ agents, agentId, configurationTarget, overflowTarget, agentView = false, workspace = false }: { agents: Agent[]; agentId: string; configurationTarget?: HTMLElement | null; overflowTarget?: HTMLElement | null; agentView?: boolean; workspace?: boolean }) {
  const confirm = useConfirm();
  const deleting = useRef(false);
  const deletionOwner = useRef<object | null>(null);
  useEffect(() => { const owner = {}; deletionOwner.current = owner; return () => { deletionOwner.current = null; }; }, [agentId]);
  const resourceId = agentId.includes('::') ? agentId.slice(agentId.indexOf('::') + 2) : agentId;
  const request = <T,>(path: string, init?: RequestInit) => api<T>(path, init);
  const [workflow, setWorkflow] = useState<'inspect' | 'text' | 'repo'>('inspect');
  const [editing, setEditing] = useState(false);
  const [search, setSearch] = useState('');
  const [lifecycleFilter, setLifecycleFilter] = useState('all');
  const [assignmentFilter, setAssignmentFilter] = useState('all');
  const [skills, setSkills] = useState<Skill[]>([]);
  const [assignments, setAssignments] = useState<Record<string, Grants>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [revision, setRevision] = useState(0);
  const refreshSkills = useCallback(() => setRevision(value => value + 1), []);
  const [importedFileName, setImportedFileName] = useState('');
  const importInputRef = useRef<HTMLInputElement>(null);
  const selectedAgent = agents.find(agent => agent.id === agentId) ?? agents[0];
  const selectedGrants = selectedAgent ? assignments[selectedAgent.id] : undefined;
  const registryKey = JSON.stringify(agents.map(agent => [agent.id, agent.resourceId ?? agent.id]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false); setError('');
    Promise.all([
      request<{ skills: Skill[] }>('/api/settings/skills', { signal: controller.signal }),
      Promise.all(agents.map(async agent => {
        const locatedResourceId = agent.resourceId ?? agent.id;
        const grants = await api<Grants>( `/api/agents/${encodeURIComponent(locatedResourceId)}/skills`, { signal: controller.signal });
        return [agent.id, grants] as const;
      })),
    ]).then(([catalog, rows]) => {
      if (controller.signal.aborted) return;
      setSkills(catalog.skills); setAssignments(Object.fromEntries(rows)); setLoaded(true);
      setSelectedId(current => current && catalog.skills.some(skill => skill.id === current) ? current : null);
    }).catch(cause => { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : 'Could not load skills.'); setLoaded(true); } });
    return () => controller.abort();
  }, [agentId, resourceId, registryKey, revision]);

  const selected = skills.find(skill => skill.id === selectedId);
  const draftBaseline = useRef<{ owner: string; value: Draft } | null>(null);
  const draftOwner = JSON.stringify(['local', resourceId]);
  useEffect(() => {
    const next: Draft = selected ? { id: selected.id, name: selected.name, description: selected.description, content: selected.content, lifecycle: selected.lifecycle, global: selected.global } : empty;
    const previous = draftBaseline.current;
    setDraft(current => previous?.owner === draftOwner && previous.value.id === next.id
      ? Object.fromEntries(Object.entries(next).map(([key, value]) => [key, current[key as keyof Draft] !== previous.value[key as keyof Draft] ? current[key as keyof Draft] : value])) as Draft
      : next);
    draftBaseline.current = { owner: draftOwner, value: next };
  }, [selected, draftOwner]);
  const act = async (operation: () => Promise<unknown>) => { setBusy(true); setError(''); try { await operation(); setRevision(value => value + 1); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save skills.'); } finally { setBusy(false); } };
  const save = () => act(async () => {
    const url = selected ? `/api/settings/skills/${encodeURIComponent(selected.id)}` : '/api/settings/skills';
    const { id, ...updates } = draft;
    await request(url, body(selected ? (selected.gitSource || (selected.contentOwner && selected.contentOwner !== 'operator') ? { lifecycle: draft.lifecycle, global: draft.global } : updates) : draft, selected ? 'PATCH' : 'POST'));
    if (!selected) setSelectedId(id);
    setWorkflow('inspect'); setEditing(false);
  });
  const toggleAssignment = (agent: Agent, skillId: string) => act(async () => {
    const grants = assignments[agent.id]; if (!grants) return;
    const next = new Set(grants.assignedSkillIds); next.has(skillId) ? next.delete(skillId) : next.add(skillId);
    const locatedResourceId = agent.resourceId ?? agent.id;
    await api(`/api/agents/${encodeURIComponent(locatedResourceId)}/skills`, body({ skillIds: [...next] }));
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
      setSelectedId(null); setWorkflow('text');
      setDraft({ ...empty, id, name, content });
      setImportedFileName(file.name);
    } catch {
      setImportedFileName('');
      setError(`Could not read “${file.name}”. Choose a readable Markdown or plain-text file.`);
    }
  };

  const removeSkill = async () => {
    if (!selected || busy || deleting.current) return;
    deleting.current = true;
    const owner = deletionOwner.current;
    try {
      if (!await confirm({ title: 'Delete skill?', message: `Delete skill “${selected.name}”? Its shared copy and assignments will be removed.`, confirmLabel: 'Delete skill', tone: 'danger' }) || !owner || deletionOwner.current !== owner) return;
      await act(async () => { await request(`/api/settings/skills/${encodeURIComponent(selected.id)}`, { method: 'DELETE' }); setSelectedId(null); });
    } finally { deleting.current = false; }
  };

  const upstreamManaged = Boolean(selected && (selected.gitSource || (selected.contentOwner && selected.contentOwner !== 'operator')));
  const editor = <SettingSection title={selected ? `Edit ${selected.name}` : 'Create text skill'}>
    <p className="hint">{upstreamManaged ? 'Upstream-managed instructions are read-only. Lifecycle and assignments remain editable.' : 'Review the shared instruction text before saving.'}</p>
    {!selected && <div className="skill-import"><span className="skill-import-label">Import text skill</span><input ref={importInputRef} className="skill-import-input" type="file" aria-label="Import text skill" accept=".md,.markdown,.txt,text/markdown,text/plain" disabled={busy} onChange={event => { void importText(event.target.files?.[0]); event.target.value = ''; }} /><div className="skill-import-control"><button type="button" className="secondary skill-import-trigger" disabled={busy} onClick={() => importInputRef.current?.click()}>Choose text file</button><span className={importedFileName ? 'skill-import-name selected' : 'skill-import-name'} aria-live="polite">{importedFileName || 'No file selected'}</span></div><small>Markdown or plain text · .md, .markdown, .txt. Loads the complete file for review; nothing is saved until you create the skill.</small></div>}
    <div className="skill-fields">
      <Field label="ID"><input value={draft.id} disabled={busy || Boolean(selected)} onChange={event => setDraft({ ...draft, id: event.target.value })} placeholder="skill-id" /></Field>
      <Field label="Name"><input value={draft.name} disabled={busy || upstreamManaged} onChange={event => setDraft({ ...draft, name: event.target.value })} /></Field>
      <Field label="Description"><input value={draft.description} disabled={busy || upstreamManaged} onChange={event => setDraft({ ...draft, description: event.target.value })} /></Field>
      <Field label="Lifecycle"><select value={draft.lifecycle} disabled={busy} onChange={event => setDraft({ ...draft, lifecycle: event.target.value })}>{['available', 'experimental', 'deprecated', 'disabled'].map(value => <option key={value}>{value}</option>)}</select></Field>
      <Field label="Content"><textarea rows={12} value={draft.content} readOnly={upstreamManaged} disabled={busy} onChange={event => setDraft({ ...draft, content: event.target.value })} /></Field>
      <label className="skill-check"><input type="checkbox" checked={draft.global} disabled={busy} onChange={event => setDraft({ ...draft, global: event.target.checked })} /> Assign globally</label>
      <div className="skill-actions"><button type="button" disabled={busy || !draft.id.trim() || !draft.name.trim()} onClick={save}>{selected ? 'Save skill' : 'Create skill'}</button>{selected && <button type="button" className="danger" disabled={busy} onClick={() => void removeSkill()}>Delete skill</button>}</div>
    </div>
  </SettingSection>;

  const libraryAssignments = <SettingSection title="Assignments"><p className="hint">Assign the selected skill globally or to specific agents. These are assignments, not separate copies.</p>{!selected ? <p className="hint">Save a skill to manage agent assignments.</p> : selected.global ? <p><strong>Global</strong><br /><small>Available to every agent.</small></p> : agents.length ? agents.map(agent => <label className="skill-check" key={agent.id}><input type="checkbox" checked={assignments[agent.id]?.assignedSkillIds.includes(selected.id) ?? false} disabled={busy} onChange={() => toggleAssignment(agent, selected.id)} /> {agent.name}</label>) : <p className="hint">No agents configured.</p>}</SettingSection>;
  const agentAssignments = <SettingSection title={`${selectedAgent?.name ?? 'Agent'} skills`}><p className="hint">Direct assignments supplement global skills, including installed Git packages.</p>{!selectedGrants ? <p className="hint">Loading assignments…</p> : <><h3>Installed skills</h3>{skills.length ? skills.map(skill => <label className="skill-check" key={skill.id}><input type="checkbox" checked={selectedGrants.assignedSkillIds.includes(skill.id)} disabled={busy || selectedGrants.globalSkillIds.includes(skill.id)} onChange={() => selectedAgent && toggleAssignment(selectedAgent, skill.id)} /> {skill.name} {selectedGrants.globalSkillIds.includes(skill.id) && <small>(global)</small>}</label>) : <p className="hint">No installed skills.</p>}</>}</SettingSection>;

  const visibleSkills = skills.filter(skill => {
    const matchesSearch = `${skill.name} ${skill.id} ${skill.description}`.toLowerCase().includes(search.trim().toLowerCase());
    const assigned = skill.global || Object.values(assignments).some(grants => grants.assignedSkillIds.includes(skill.id));
    return matchesSearch && (lifecycleFilter === 'all' || skill.lifecycle === lifecycleFilter)
      && (assignmentFilter === 'all' || (assignmentFilter === 'assigned' ? assigned : !assigned));
  });
  if (workspace) return <>
    <section className="settings-blank-column settings-prototype-sections skills-library-pane" aria-label="Skill library">
      <header className="skills-pane-heading"><h2>Library</h2><span>{skills.length} skills</span></header>
      <button className="secondary" type="button" disabled={busy || !loaded} onClick={() => { setSelectedId(null); setWorkflow('repo'); setEditing(false); }}>Import from repository</button>
      <button className="secondary" type="button" disabled={busy || !loaded || Boolean(error)} onClick={() => { setSelectedId(null); setWorkflow('text'); setEditing(false); setDraft(empty); setImportedFileName(''); }}>New text skill</button>
      <Field label="Search skills"><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Name, ID, description" /></Field>
      <div className="skill-library-filters"><Field label="Lifecycle filter"><select value={lifecycleFilter} onChange={event => setLifecycleFilter(event.target.value)}><option value="all">All lifecycles</option>{['available', 'experimental', 'deprecated', 'disabled'].map(value => <option key={value}>{value}</option>)}</select></Field>
      <Field label="Assignment filter"><select value={assignmentFilter} onChange={event => setAssignmentFilter(event.target.value)}><option value="all">All assignments</option><option value="assigned">Assigned</option><option value="unassigned">Unassigned</option></select></Field></div>
      <p className="hint">Shared instruction library · text and installed packages.</p>
      {!loaded ? <p role="status" className="hint">Loading skills…</p> : <nav className="settings-prototype-section-items skills-library-list" aria-label="Skills library">{visibleSkills.map(skill => <button type="button" key={skill.id} disabled={busy} className={selectedId === skill.id ? 'active' : ''} aria-current={selectedId === skill.id ? 'true' : undefined} onClick={() => { setSelectedId(skill.id); setWorkflow('inspect'); setEditing(false); }}><strong>{skill.name}</strong><small>{skill.id} · {skill.lifecycle}{skill.storage === 'filesystem' ? ' · package' : ''}{skill.global ? ' · global' : ''}</small>{skill.description && <span>{skill.description}</span>}</button>)}</nav>}
      {loaded && !error && !visibleSkills.length && <p className="hint" role="status">{skills.length ? 'No skills match these filters.' : 'No installed skills. Import from a repository or create a text skill.'}</p>}
    </section>
    <section className="settings-blank-column settings-prototype-configuration skills-detail-pane" aria-label="Skill details and assignments">
      <header className="skills-pane-heading"><h2>{selected?.name ?? (workflow === 'text' ? 'New text skill' : workflow === 'repo' ? 'Import from repository' : 'Skills')}</h2><span>{selected ? selected.lifecycle : workflow === 'inspect' ? 'Library' : 'Not installed'}</span></header>
      {error && <div className="settings-error" role="alert">{error}<button type="button" className="secondary" disabled={busy} onClick={() => setRevision(value => value + 1)}>Reload skills</button></div>}
      {loaded && <>{selected ? <>
        <p className="hint">{selected.description || 'Shared agent instructions.'}</p>
        <div className="skill-actions">{!upstreamManaged && <button type="button" className="secondary" onClick={() => setEditing(value => !value)}>{editing ? 'Close editor' : 'Edit text'}</button>}<button type="button" className="danger" disabled={busy} onClick={() => void removeSkill()}>Delete skill</button></div>
        {editing && !upstreamManaged ? editor : <SettingSection title="Instructions"><pre className="skill-instructions">{selected.content}</pre></SettingSection>}
      </> : workflow === 'text' ? editor : workflow === 'repo' ? <SkillRepositoryImport onInstalled={skill => { setSkills(current => [...current.filter(item => item.id !== skill.id), skill]); setSelectedId(skill.id); setWorkflow('inspect'); refreshSkills(); }} /> : <SettingSection title="Inspect a skill"><p className="hint">Select an installed skill to read its instructions and manage updates. Import directly from a repository, or create a separate text skill.</p></SettingSection>}</>}
    </section>
    <aside className="settings-blank-column settings-prototype-overflow skills-source-pane" aria-label="Skill source and updates">
      <header className="skills-pane-heading"><h2>Source &amp; updates</h2><span>Core</span></header>
      {selected ? <><SkillSourceSettings key={selected.id} skill={selected} onRefresh={refreshSkills} compact /><details className="skill-disclosure"><summary>Assignments &amp; lifecycle</summary><SettingSection title="Availability"><Field label="Lifecycle"><select value={draft.lifecycle} disabled={busy} onChange={event => setDraft({ ...draft, lifecycle: event.target.value })}>{['available', 'experimental', 'deprecated', 'disabled'].map(value => <option key={value}>{value}</option>)}</select></Field><label className="skill-check"><input type="checkbox" checked={draft.global} disabled={busy} onChange={event => setDraft({ ...draft, global: event.target.checked })} /> Assign globally</label><button type="button" disabled={busy} onClick={() => void act(async () => { await request(`/api/settings/skills/${encodeURIComponent(selected.id)}`, body({ lifecycle: draft.lifecycle, global: draft.global }, 'PATCH')); })}>Save availability</button></SettingSection>{libraryAssignments}</details></> : <SettingSection title="Manage installed skills"><p className="hint">Source status, updates and assignments appear here when you select an installed skill.</p></SettingSection>}
    </aside>
  </>;

  return <>
    {!agentView && <nav className="settings-prototype-section-items skill-library" aria-label="Skills library"><button type="button" className={!selectedId ? 'active' : ''} onClick={() => setSelectedId(null)}>New text skill</button>{skills.map(skill => <button type="button" key={skill.id} className={selectedId === skill.id ? 'active' : ''} onClick={() => setSelectedId(skill.id)}>{skill.name}<small>{skill.id}{skill.global ? ' · global' : ''}</small></button>)}</nav>}
    {error && <p className="settings-error" role="alert">{error}</p>}{!loaded && <p className="hint">Loading skills…</p>}
    {loaded && (agentView ? agentAssignments : <>{configurationTarget && createPortal(editor, configurationTarget)}{overflowTarget && createPortal(libraryAssignments, overflowTarget)}</>)}
  </>;
}
