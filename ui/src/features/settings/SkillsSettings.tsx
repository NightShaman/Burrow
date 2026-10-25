import { createPortal } from 'react-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useConfirm } from '../../app/ConfirmDialog';
import { useUnsavedChanges, useUnsavedNavigation } from '../../app/UnsavedChanges';
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

export function SkillsSettings({ agents, agentId, configurationTarget, overflowTarget, agentView = false, section = 'text', onSectionChange }: { agents: Agent[]; agentId: string; configurationTarget?: HTMLElement | null; overflowTarget?: HTMLElement | null; agentView?: boolean; section?: 'installed' | 'repo' | 'text'; onSectionChange?: (section: 'installed' | 'repo' | 'text') => void }) {
  const confirm = useConfirm();
  const navigate = useUnsavedNavigation();
  const deleting = useRef(false);
  const deletionOwner = useRef<object | null>(null);
  useEffect(() => { const owner = {}; deletionOwner.current = owner; return () => { deletionOwner.current = null; }; }, [agentId]);
  const resourceId = agentId.includes('::') ? agentId.slice(agentId.indexOf('::') + 2) : agentId;
  const request = <T,>(path: string, init?: RequestInit) => api<T>(path, init);
  useEffect(() => { if (section !== 'installed') { setSelectedId(null); setDraft(empty); draftBaseline.current = null; setImportedFileName(''); } }, [section]);
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
      setSelectedId(current => current && (catalog.skills.some(skill => skill.id === current) || pendingCreatedId.current === current) ? current : null);
      if (pendingCreatedId.current && catalog.skills.some(skill => skill.id === pendingCreatedId.current)) pendingCreatedId.current = null;
    }).catch(cause => { if (!controller.signal.aborted) { setError(cause instanceof Error ? cause.message : 'Could not load skills.'); setLoaded(true); } });
    return () => controller.abort();
  }, [agentId, resourceId, registryKey, revision]);

  const selected = skills.find(skill => skill.id === selectedId);
  const draftBaseline = useRef<{ owner: string; value: Draft } | null>(null);
  const draftOwner = JSON.stringify(['local', resourceId]);
  useEffect(() => {
    // A newly created item is selected before the refreshed inventory arrives.
    // Keep its editor draft until that inventory resolves.
    if (selectedId && !selected) return;
    const next: Draft = selected ? { id: selected.id, name: selected.name, description: selected.description, content: selected.content, lifecycle: selected.lifecycle, global: selected.global } : empty;
    const previous = draftBaseline.current;
    setDraft(current => previous?.owner === draftOwner && previous.value.id === next.id
      ? Object.fromEntries(Object.entries(next).map(([key, value]) => [key, current[key as keyof Draft] !== previous.value[key as keyof Draft] ? current[key as keyof Draft] : value])) as Draft
      : next);
    draftBaseline.current = { owner: draftOwner, value: next };
    if (previous?.value.id !== next.id) savedDraft.current = null;
  }, [selected, selectedId, draftOwner]);
  const savedDraft = useRef<string | null>(null);
  const saving = useRef(false);
  const pendingCreatedId = useRef<string | null>(null);
  const act = async (operation: () => Promise<unknown>) => { setBusy(true); setError(''); try { await operation(); setRevision(value => value + 1); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save skills.'); } finally { setBusy(false); } };
  const save = async (): Promise<boolean> => {
    if (saving.current || busy) return false;
    const snapshot = { ...draft };
    if (!snapshot.id.trim() || !snapshot.name.trim()) { setError('Skill ID and name are required.'); return false; }
    const fingerprint = JSON.stringify(snapshot);
    if (savedDraft.current === fingerprint) { setError('Skill already saved. Reload skills before editing it again.'); return false; }
    saving.current = true; setBusy(true); setError('');
    try {
      const targetId = selected?.id ?? pendingCreatedId.current;
      const url = targetId ? `/api/settings/skills/${encodeURIComponent(targetId)}` : '/api/settings/skills';
      const { id, ...updates } = snapshot;
      await request(url, body(selected ? (selected.gitSource || (selected.contentOwner && selected.contentOwner !== 'operator') ? { lifecycle: snapshot.lifecycle, global: snapshot.global } : updates) : snapshot, targetId ? 'PATCH' : 'POST'));
      savedDraft.current = fingerprint;
      draftBaseline.current = { owner: draftOwner, value: snapshot };
      if (!selected) { pendingCreatedId.current = id; setSelectedId(id); onSectionChange?.('installed'); }
      refreshSkills();
      return true;
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save skills.'); return false; }
    finally { saving.current = false; setBusy(false); }
  };
  const dirty = (section === 'text' || section === 'installed' && Boolean(selected) || agentView && Boolean(selected)) && JSON.stringify(draft) !== JSON.stringify(draftBaseline.current?.value ?? empty) && savedDraft.current !== JSON.stringify(draft);
  useUnsavedChanges({ dirty, busy, save, discard: () => { setDraft(draftBaseline.current?.value ?? empty); setImportedFileName(''); setError(''); } });
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
      pendingCreatedId.current = null;
      setSelectedId(null);
      draftBaseline.current = { owner: draftOwner, value: empty };
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
  const editor = <SettingSection title={selected ? selected.name : 'Create text skill'}>
    <p className="hint">{upstreamManaged ? 'Upstream-managed instructions are read-only. Lifecycle and assignments remain editable.' : 'Review the shared instruction text before saving.'}</p>
    {!selected && <div className="skill-import"><span className="skill-import-label">Import text skill</span><input ref={importInputRef} className="skill-import-input" type="file" aria-label="Import text skill" accept=".md,.markdown,.txt,text/markdown,text/plain" disabled={busy} onChange={event => { void importText(event.target.files?.[0]); event.target.value = ''; }} /><div className="skill-import-control"><button type="button" className="secondary skill-import-trigger" disabled={busy} onClick={() => importInputRef.current?.click()}>Choose text file</button><span className={importedFileName ? 'skill-import-name selected' : 'skill-import-name'} aria-live="polite">{importedFileName || 'No file selected'}</span></div><small>Markdown or plain text · .md, .markdown, .txt. Loads the complete file for review; nothing is saved until you create the skill.</small></div>}
    <div className="skill-source-fields">
      {!upstreamManaged && <><div className="field-pair skill-field-pair"><Field label="ID"><input value={draft.id} disabled={busy || Boolean(selected)} onChange={event => setDraft({ ...draft, id: event.target.value })} placeholder="skill-id" /></Field>
      <Field label="Name"><input value={draft.name} disabled={busy || upstreamManaged} onChange={event => setDraft({ ...draft, name: event.target.value })} /></Field>
      </div><Field label="Description"><input value={draft.description} disabled={busy || upstreamManaged} onChange={event => setDraft({ ...draft, description: event.target.value })} /></Field>
      </>}<Field label="Lifecycle"><select value={draft.lifecycle} disabled={busy} onChange={event => setDraft({ ...draft, lifecycle: event.target.value })}>{['available', 'experimental', 'deprecated', 'disabled'].map(value => <option key={value}>{value}</option>)}</select></Field>
      {!upstreamManaged && <Field label="Content"><textarea className="mcp-arguments" rows={12} value={draft.content} readOnly={upstreamManaged} disabled={busy} onChange={event => setDraft({ ...draft, content: event.target.value })} /></Field>}
      <label className="skill-check"><input type="checkbox" checked={draft.global} disabled={busy} onChange={event => setDraft({ ...draft, global: event.target.checked })} /> Assign globally</label>
      <div className="model-actions"><button type="button" disabled={busy || !draft.id.trim() || !draft.name.trim()} onClick={() => void save()}>{selected ? 'Save skill' : 'Create skill'}</button>{selected && <button type="button" className="danger" disabled={busy} onClick={() => void removeSkill()}>Delete skill</button>}</div>
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
  const inventory = <div className="settings-overflow-content memory-saved">
    <Field label="Search skills"><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Name, ID, description" /></Field>
    <div className="field-pair"><Field label="Lifecycle filter"><select value={lifecycleFilter} onChange={event => setLifecycleFilter(event.target.value)}><option value="all">All lifecycles</option>{['available', 'experimental', 'deprecated', 'disabled'].map(value => <option key={value}>{value}</option>)}</select></Field><Field label="Assignment filter"><select value={assignmentFilter} onChange={event => setAssignmentFilter(event.target.value)}><option value="all">All assignments</option><option value="assigned">Assigned</option><option value="unassigned">Unassigned</option></select></Field></div>
    {!loaded ? <p className="settings-empty" role="status">Loading skills…</p> : <div className="memory-connection-list">{visibleSkills.map(skill => <article className="memory-connection" key={skill.id}><button type="button" className="memory-connection-select" disabled={busy} aria-pressed={selectedId === skill.id} onClick={() => { if (selectedId !== skill.id) navigate(() => { setSelectedId(skill.id); onSectionChange?.('installed'); }); }}><strong>{skill.name}</strong><small>{skill.id} · {skill.lifecycle}{skill.global ? ' · global' : ''}</small></button></article>)}</div>}
    {loaded && !error && !visibleSkills.length && <p className="settings-empty">{skills.length ? 'No skills match these filters.' : 'No installed skills.'}</p>}
  </div>;
  const primary = <>
    {error && <p className="settings-request-error" role="alert">{error}<button type="button" className="secondary" disabled={busy} onClick={refreshSkills}>Reload skills</button></p>}
    {!loaded && <p className="settings-empty" role="status">Loading skills…</p>}
    {loaded && (agentView ? agentAssignments : selected ? <>{editor}<SkillSourceSettings key={selected.id} skill={selected} onRefresh={refreshSkills} />{libraryAssignments}</> : section === 'repo' ? <SkillRepositoryImport onInstalled={skill => { setSkills(current => [...current.filter(item => item.id !== skill.id), skill]); setSelectedId(skill.id); onSectionChange?.('installed'); refreshSkills(); }} /> : section === 'text' ? editor : <SettingSection title="Installed skills"><p className="settings-description">Select a skill to configure its instructions, source, availability and assignments. Import a repository or create a text skill using the sections on the left.</p></SettingSection>)}
  </>;
  return <>
    {configurationTarget ? createPortal(primary, configurationTarget) : primary}
    {!agentView && section === 'installed' && (overflowTarget ? createPortal(inventory, overflowTarget) : inventory)}
  </>;
}
