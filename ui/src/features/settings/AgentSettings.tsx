import { useEffect, useRef, useState } from 'react';
import type { Agent, SavedProvider } from '../../app/types';
import { api, apiForTarget } from '../../app/api';
import { targetForResource, type ApiTarget } from '../../app/apiTargets';
import { useConfirm } from '../../app/ConfirmDialog';
import { optimizeAvatar } from './OperatorProfile';
import { Field, SettingSection } from './SettingsPrimitives';

type McpTool = { name: string; description?: string | null; inputSchema?: Record<string, unknown> };
type McpConnection = { id: string; name: string; transport: 'http' | 'stdio'; baseUrl: string | null; command: string | null; args: string[]; enabled: boolean; apiKeyConfigured: boolean; tools: McpTool[] };

function AgentMcpTools({ agentId, targets }: { agentId: string; targets: ApiTarget[] }) {
  const owner = targetForResource(targets, agentId);
  const request = <T,>(path: string, init?: RequestInit) => apiForTarget<T>(owner.target, path, init);
  const [connections, setConnections] = useState<McpConnection[]>([]); const [enabled, setEnabled] = useState<Set<string>>(new Set()); const [state, setState] = useState<'loading' | 'idle' | 'saving'>('loading'); const [error, setError] = useState('');
  useEffect(() => { let live = true; Promise.all([request<{ connections: McpConnection[] }>('/api/settings/mcp-connections'), request<{ tools: { connectionId: string; toolName: string; enabled: boolean }[] }>(`/api/agents/${encodeURIComponent(owner.resourceId)}/mcp-tools`)]).then(([catalog, grants]) => { if (!live) return; setConnections(catalog.connections ?? []); setEnabled(new Set((grants.tools ?? []).filter(tool => tool.enabled).map(tool => `${tool.connectionId}:${tool.toolName}`))); setState('idle'); }).catch(cause => { if (live) { setError(cause instanceof Error ? `Could not load MCP tools: ${cause.message}` : 'Could not load MCP tools.'); setState('idle'); } }); return () => { live = false; }; }, [agentId]);
  const toggleConnection = (connection: McpConnection) => setEnabled(current => {
    const keys = connection.tools.map(tool => `${connection.id}:${tool.name}`);
    const selectAll = !keys.every(key => current.has(key));
    const next = new Set(current);
    keys.forEach(key => selectAll ? next.add(key) : next.delete(key));
    return next;
  });
  const save = async () => { setState('saving'); setError(''); try { const tools = connections.flatMap(connection => connection.tools.filter(tool => enabled.has(`${connection.id}:${tool.name}`)).map(tool => ({ connectionId: connection.id, toolName: tool.name, enabled: true }))); await request(`/api/agents/${encodeURIComponent(owner.resourceId)}/mcp-tools`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tools }) }); } catch (cause) { setError(cause instanceof Error ? `Could not save MCP tools: ${cause.message}` : 'Could not save MCP tools.'); } finally { setState('idle'); } };
  return <SettingSection title="MCP tools"><p className="settings-description">Choose the discovered MCP tools this agent may use.</p>{state === 'loading' ? <p className="settings-empty">Loading MCP tools…</p> : connections.length === 0 ? <p className="settings-empty">No MCP servers available. Add and discover one under Connections.</p> : <div className="mcp-tool-list">{connections.map(connection => { const selectedCount = connection.tools.filter(tool => enabled.has(`${connection.id}:${tool.name}`)).length; const allSelected = connection.tools.length > 0 && selectedCount === connection.tools.length; return <details className="mcp-tool-group" key={connection.id}><summary><strong>{connection.name}</strong><small>{selectedCount}/{connection.tools.length} enabled</small></summary>{connection.tools.length ? <div className="mcp-tool-options"><label className="mcp-tool-select-all"><input type="checkbox" checked={allSelected} onChange={() => toggleConnection(connection)} /><span><b>{allSelected ? 'Clear all' : 'Select all'}</b><small>{connection.tools.length} {connection.tools.length === 1 ? 'tool' : 'tools'}</small></span></label>{connection.tools.map(tool => { const key = `${connection.id}:${tool.name}`; return <label key={key}><input type="checkbox" checked={enabled.has(key)} onChange={() => setEnabled(current => { const next = new Set(current); next.has(key) ? next.delete(key) : next.add(key); return next; })} /><span><b>{tool.name}</b>{tool.description && <small>{tool.description}</small>}</span></label>; })}</div> : <small>No tools discovered yet.</small>}</details>; })}</div>}{error && <p className="settings-request-error" role="alert">{error}</p>}<div className="card-actions"><button className="primary" onClick={() => void save()} disabled={state !== 'idle'}>{state === 'saving' ? 'Saving…' : 'Save MCP tools'}</button></div></SettingSection>;
}

export type AgentSettingsProps = { selected: Agent; targets: ApiTarget[]; savedProviders: SavedProvider[]; onAgentsChanged: () => Promise<void> };

type ProfileDocument = { kind: 'SOUL' | 'RULES' | 'ORIENTATION' | 'TOOLS' | 'DREAM_MEMORY'; markdown: string };
const profileDocumentKinds: ProfileDocument['kind'][] = ['SOUL', 'RULES', 'ORIENTATION', 'TOOLS', 'DREAM_MEMORY'];
const profileDocumentLabels: Record<ProfileDocument['kind'], string> = { SOUL: 'SOUL.md', RULES: 'RULES.md', ORIENTATION: 'ORIENTATION.md', TOOLS: 'TOOLS.md', DREAM_MEMORY: 'DreamMemory.md' };

function AgentProfileDocuments({ agentId, targets }: { agentId: string; targets: ApiTarget[] }) {
  const owner = targetForResource(targets, agentId);
  const request = <T,>(path: string, init?: RequestInit) => apiForTarget<T>(owner.target, path, init);
  const [documents, setDocuments] = useState<ProfileDocument[]>(profileDocumentKinds.map(kind => ({ kind, markdown: '' })));
  const [state, setState] = useState<'loading' | 'idle' | 'saving'>('loading');
  const [error, setError] = useState('');

  const load = async () => {
    setState('loading'); setError('');
    try {
      const result = await request<{ documents: ProfileDocument[] }>(`/api/agents/${encodeURIComponent(owner.resourceId)}/profile-documents`);
      const byKind = new Map((result.documents ?? []).map(document => [document.kind, document.markdown]));
      setDocuments(profileDocumentKinds.map(kind => ({ kind, markdown: byKind.get(kind) ?? '' })));
    } catch (cause) { setError(cause instanceof Error ? `Could not load profile documents: ${cause.message}` : 'Could not load profile documents.'); }
    finally { setState('idle'); }
  };
  useEffect(() => { void load(); }, [agentId]);
  const save = async () => {
    setState('saving'); setError('');
    try { await request(`/api/agents/${encodeURIComponent(owner.resourceId)}/profile-documents`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ documents }) }); }
    catch (cause) { setError(cause instanceof Error ? `Could not save profile documents: ${cause.message}` : 'Could not save profile documents.'); }
    finally { setState('idle'); }
  };
  return <SettingSection title="Profile documents"><p className="settings-description">These documents define this agent’s identity, operating rules, orientation, and verified environment facts.</p>{state === 'loading' ? <p className="settings-empty">Loading profile documents…</p> : <details className="profile-documents-accordion"><summary>Show profile documents</summary><div className="profile-documents-content">{documents.map((document, index) => <Field key={document.kind} label={profileDocumentLabels[document.kind]}><textarea value={document.markdown} onChange={event => setDocuments(current => current.map((item, itemIndex) => itemIndex === index ? { ...item, markdown: event.target.value } : item))} rows={8} spellCheck="false" /></Field>)}{error && <p className="settings-request-error" role="alert">{error}</p>}<div className="card-actions"><button className="primary" onClick={() => void save()} disabled={state !== 'idle'}>{state === 'saving' ? 'Saving…' : 'Save profile documents'}</button></div></div></details>}</SettingSection>;
}

type DreamSettings = { enabled: boolean; cron: string; timezone: string; prompt: string; modelConnectionId?: string | null; model?: string | null };
function dreamModelValue(connectionId: string, model: string) { return JSON.stringify([connectionId, model]); }
function settingsModelValue(settings: DreamSettings) { return settings.modelConnectionId && settings.model ? dreamModelValue(settings.modelConnectionId, settings.model) : ''; }
function dreamModelFromValue(value: string) {
  if (!value) return { modelConnectionId: null, model: null };
  try {
    const [modelConnectionId, model] = JSON.parse(value) as [string, string];
    return modelConnectionId && model ? { modelConnectionId, model } : { modelConnectionId: null, model: null };
  } catch { return { modelConnectionId: null, model: null }; }
}

function DreamModelSelect({ value, options, onChange }: { value: string; options: { value: string; label: string }[]; onChange: (value: string) => void }) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const selected = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return <div className="dream-model-select" ref={menuRef}>
    <button type="button" className="dream-model-trigger" aria-haspopup="listbox" aria-expanded={open} aria-label="Dream model" onClick={() => setOpen((current) => !current)}>
      <span>{selected?.label ?? 'Use agent chat model'}</span><span className="dream-phase-chevron" aria-hidden="true">⌄</span>
    </button>
    {open && <div className="dream-model-menu" role="listbox" aria-label="Dream model">
      {options.map((option) => <button type="button" role="option" aria-selected={option.value === value} className={option.value === value ? 'selected' : ''} key={option.value} onClick={() => { onChange(option.value); setOpen(false); }}>{option.label}</button>)}
    </div>}
  </div>;
}

function AgentDreams({ agentId, targets, savedProviders }: { agentId: string; targets: ApiTarget[]; savedProviders: SavedProvider[] }) {
  const owner = targetForResource(targets, agentId);
  const request = <T,>(path: string, init?: RequestInit) => apiForTarget<T>(owner.target, path, init);
  const dreamModels = savedProviders.flatMap((provider) => provider.models.map((model) => ({ connectionId: provider.id, model, label: `${provider.provider} · ${provider.modelLabels?.[model] ?? model}` })));
  const [settings, setSettings] = useState<DreamSettings>({ enabled: false, cron: '0 4 * * *', timezone: 'UTC', prompt: '', modelConnectionId: null, model: null });
  const selectedDreamModel = settingsModelValue(settings);
  const [state, setState] = useState<'loading' | 'idle' | 'saving'>('loading');
  const [error, setError] = useState('');

  const load = async () => {
    setState('loading'); setError('');
    try {
      const dreamSettings = await request<{ settings: DreamSettings }>(`/api/agents/${encodeURIComponent(owner.resourceId)}/dream-settings`);
      setSettings(dreamSettings.settings);
    } catch (cause) { setError(cause instanceof Error ? `Could not load dream settings: ${cause.message}` : 'Could not load dream settings.'); }
    finally { setState('idle'); }
  };
  useEffect(() => { void load(); }, [agentId]);
  const save = async () => {
    setState('saving'); setError('');
    try { const result = await request<{ settings: DreamSettings }>(`/api/agents/${encodeURIComponent(owner.resourceId)}/dream-settings`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) }); setSettings(result.settings); }
    catch (cause) { setError(cause instanceof Error ? `Could not save dream settings: ${cause.message}` : 'Could not save dream settings.'); }
    finally { setState('idle'); }
  };
  return <SettingSection title="Dreams">
    <p className="settings-description">Configure scheduled dreaming for this agent.</p>
    <div className="dream-settings-fields">
      <label className="agent-enabled"><input type="checkbox" checked={settings.enabled} onChange={(event) => setSettings({ ...settings, enabled: event.target.checked })} /><span>Enable scheduled dreaming</span></label>
      <div className="dream-schedule-fields"><Field label="Cron"><input value={settings.cron} onChange={(event) => setSettings({ ...settings, cron: event.target.value })} /></Field><Field label="Timezone"><input value={settings.timezone} onChange={(event) => setSettings({ ...settings, timezone: event.target.value })} /></Field><Field label="Model"><DreamModelSelect value={selectedDreamModel} options={[{ value: '', label: 'Use agent chat model' }, ...dreamModels.map((option) => ({ value: dreamModelValue(option.connectionId, option.model), label: option.label }))]} onChange={(value) => setSettings({ ...settings, ...dreamModelFromValue(value) })} /></Field></div>
      <Field label="Dream prompt"><textarea rows={6} value={settings.prompt} onChange={(event) => setSettings({ ...settings, prompt: event.target.value })} /></Field>
    </div>
    <div className="dream-actions">
      <button className="primary" onClick={() => void save()} disabled={state !== 'idle'}>{state === 'saving' ? 'Saving…' : 'Save dream settings'}</button>
    </div>
    {error && <p className="settings-request-error" role="alert">{error}</p>}
  </SettingSection>;
}

type ScheduledJob = { id: string; agentId: string; name: string; prompt: string; cron: string; timezone: string; sessionId?: string; enabled: boolean; nextRunAt?: string | null; lastRunAt?: string | null };

function AgentSchedules({ agentId, targets }: { agentId: string; targets: ApiTarget[] }) {
  const owner = targetForResource(targets, agentId);
  const request = <T,>(path: string, init?: RequestInit) => apiForTarget<T>(owner.target, path, init);
  const confirm = useConfirm();
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [name, setName] = useState(''); const [prompt, setPrompt] = useState(''); const [cron, setCron] = useState('0 9 * * *'); const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'); const [enabled, setEnabled] = useState(true);
  const [state, setState] = useState<'loading' | 'idle' | 'saving'>('loading'); const [error, setError] = useState('');
  const load = async () => { try { const result = await request<{ jobs: ScheduledJob[] }>(`/api/scheduled-jobs?agentId=${encodeURIComponent(owner.resourceId)}`); setJobs(result.jobs ?? []); } catch (cause) { setError(cause instanceof Error ? `Could not load schedules: ${cause.message}` : 'Could not load schedules.'); } finally { setState('idle'); } };
  useEffect(() => { setState('loading'); setEditingId(null); void load(); }, [agentId]);
  const reset = () => { setEditingId(null); setName(''); setPrompt(''); setCron('0 9 * * *'); setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'); setEnabled(true); setError(''); };
  const edit = (job: ScheduledJob) => { setEditingId(job.id); setName(job.name); setPrompt(job.prompt); setCron(job.cron); setTimezone(job.timezone); setEnabled(job.enabled); setError(''); };
  const save = async () => { if (!name.trim() || !prompt.trim() || !cron.trim() || !timezone.trim()) { setError('Name, prompt, cron, and timezone are required.'); return; } setState('saving'); setError(''); try { await request(editingId ? `/api/scheduled-jobs/${encodeURIComponent(editingId)}` : '/api/scheduled-jobs', { method: editingId ? 'PATCH' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(editingId ? {} : { agentId: owner.resourceId }), name: name.trim(), prompt: prompt.trim(), cron: cron.trim(), timezone: timezone.trim(), enabled }) }); await load(); reset(); } catch (cause) { setError(cause instanceof Error ? `Could not save schedule: ${cause.message}` : 'Could not save schedule.'); setState('idle'); } };
  const remove = async (job: ScheduledJob) => { if (!await confirm({ title: 'Delete scheduled job?', message: `Delete ${job.name}?`, confirmLabel: 'Delete job', tone: 'danger' })) return; try { await request(`/api/scheduled-jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' }); setJobs(items => items.filter(item => item.id !== job.id)); if (editingId === job.id) reset(); } catch (cause) { setError(cause instanceof Error ? `Could not delete schedule: ${cause.message}` : 'Could not delete schedule.'); } };
  return <SettingSection title="Cron jobs"><p className="settings-description">Run prompts for this agent on a five-field cron schedule.</p><div className="schedule-form"><Field label="Name"><input value={name} onChange={event => setName(event.target.value)} placeholder="Morning briefing" /></Field><Field label="Prompt"><textarea value={prompt} onChange={event => setPrompt(event.target.value)} rows={3} placeholder="Prepare the daily briefing…" /></Field><div className="schedule-field-pair"><Field label="Cron"><input value={cron} onChange={event => setCron(event.target.value)} placeholder="0 9 * * *" /><small className="field-hint">minute hour day month weekday</small></Field><Field label="Timezone"><input value={timezone} onChange={event => setTimezone(event.target.value)} placeholder="America/New_York" /></Field></div><div className="schedule-footer"><label className="schedule-enabled"><input type="checkbox" checked={enabled} onChange={event => setEnabled(event.target.checked)} /><span>Enabled</span></label><div className="setting-actions"><button className="secondary" type="button" onClick={reset} disabled={state === 'saving'}>{editingId ? 'Cancel' : 'Clear'}</button><button className="primary" type="button" onClick={() => void save()} disabled={state !== 'idle'}>{state === 'saving' ? 'Saving…' : editingId ? 'Save job' : 'Add job'}</button></div></div></div>{error && <p className="settings-request-error" role="alert">{error}</p>}{state === 'loading' ? <p className="settings-empty">Loading cron jobs…</p> : jobs.length === 0 ? <p className="settings-empty">No cron jobs configured for this agent.</p> : <div className="schedule-list">{jobs.map(job => <article className="schedule-card" key={job.id}><div><strong>{job.name}</strong><small>{job.cron} · {job.timezone}</small><p>{job.prompt}</p></div><div className="card-actions"><button className="secondary" type="button" onClick={() => edit(job)}>Edit</button><button className="danger" type="button" onClick={() => void remove(job)}>Delete</button></div></article>)}</div>}</SettingSection>;
}

export function AgentSettings({ selected, targets, savedProviders, onAgentsChanged }: AgentSettingsProps) {
  const owner = targetForResource(targets, selected.id);
  const confirm = useConfirm();
  const [name, setName] = useState(selected.name);
  const [avatar, setAvatar] = useState(selected.avatar.startsWith('data:image/') ? selected.avatar : '');
  const [avatarFileName, setAvatarFileName] = useState('');
  const [enabled, setEnabled] = useState(selected.activity !== 'Disabled');
  const avatarInput = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<'idle' | 'saving' | 'deleting'>('idle');
  const [error, setError] = useState('');

  useEffect(() => { setName(selected.name); setAvatar(selected.avatar.startsWith('data:image/') ? selected.avatar : ''); setAvatarFileName(''); setEnabled(selected.activity !== 'Disabled'); setError(''); }, [selected]);
  const chooseAvatar = async (file?: File) => {
    if (!file) return;
    try { setAvatar(await optimizeAvatar(file)); setAvatarFileName(file.name || 'Pasted image'); setError(''); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not process the avatar image.'); }
  };
  const pasteAvatar = (event: React.ClipboardEvent<HTMLDivElement>) => {
    const item = Array.from(event.clipboardData.items).find((clipboardItem) => clipboardItem.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (!file) return;
    event.preventDefault();
    chooseAvatar(file);
  };
  const removeAvatar = () => { setAvatar(''); setAvatarFileName(''); setError(''); if (avatarInput.current) avatarInput.current.value = ''; };
  const save = async () => {
    const nextName = name.trim();
    if (!nextName) { setError('An agent needs a display name.'); return; }
    setState('saving'); setError('');
    try {
      await Promise.all([
        apiForTarget(owner.target, `/api/agents/${encodeURIComponent(owner.resourceId)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: nextName, enabled }) }),
        apiForTarget(owner.target, '/api/settings/identities', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'agent', id: owner.resourceId, name: nextName, avatar }) }),
      ]);
      await onAgentsChanged();
    } catch (cause) { setError(cause instanceof Error ? `Could not save agent: ${cause.message}` : 'Could not save agent.'); } finally { setState('idle'); }
  };
  const remove = async () => {
    if (!await confirm({ title: 'Delete agent?', message: `Delete ${selected.name}? This removes the agent registration, not its workspace files.`, confirmLabel: 'Delete agent', tone: 'danger' })) return;
    setState('deleting'); setError('');
    try { await apiForTarget(owner.target, `/api/agents/${encodeURIComponent(owner.resourceId)}`, { method: 'DELETE' }); await onAgentsChanged(); }
    catch (cause) { setError(cause instanceof Error ? `Could not delete agent: ${cause.message}` : 'Could not delete agent.'); } finally { setState('idle'); }
  };
  return <div className="agent-settings-grid">
    <div className="agent-settings-left">
      <SettingSection title="Agent details"><div className="operator-profile agent-profile"><div className="agent-avatar-preview" aria-label={`${name || selected.name} avatar`}>{avatar ? <img src={avatar} alt="" /> : (name || selected.name).slice(0, 1).toUpperCase()}</div><div className="operator-profile-details"><div className="avatar-file-control" onPaste={pasteAvatar}><label className="avatar-file-name">Paste or choose image<input value={avatarFileName} placeholder="Paste an image or choose a file" readOnly aria-label="Agent avatar image" /></label><button className="secondary" type="button" onClick={() => avatarInput.current?.click()}>Change</button><input ref={avatarInput} className="avatar-file-input" type="file" accept="image/*" onChange={(event) => { chooseAvatar(event.target.files?.[0]); event.currentTarget.value = ''; }} /></div>{avatar && <button className="avatar-remove" type="button" onClick={removeAvatar}>Remove image</button>}</div></div><div className="operator-profile-actions agent-profile-actions"><Field label="Displayed name"><input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} /></Field><label className="agent-enabled"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>Enabled</span></label><button className="primary" onClick={() => void save()} disabled={state !== 'idle'}>{state === 'saving' ? 'Saving…' : 'Save changes'}</button></div>{error && <p className="settings-request-error" role="alert">{error}</p>}<div className="agent-detail-footer"><span>{selected.id}</span><button className="danger" onClick={() => void remove()} disabled={state !== 'idle'}>Delete agent</button></div><div className="agent-profile-documents"><AgentProfileDocuments agentId={selected.id} targets={targets} /></div></SettingSection>
    </div>
    <div className="agent-settings-middle"><AgentMcpTools agentId={selected.id} targets={targets} /><AgentSchedules agentId={selected.id} targets={targets} /></div>
    <div className="agent-settings-right agent-settings-dreams"><AgentDreams agentId={selected.id} targets={targets} savedProviders={savedProviders} /></div>
  </div>;
}
