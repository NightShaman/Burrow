import { useEffect, useRef, useState } from 'react';
import type { Agent, SavedProvider } from '../../app/types';
import { apiForTarget } from '../../app/api';
import { targetForResource, type ApiTarget } from '../../app/apiTargets';
import { useConfirm } from '../../app/ConfirmDialog';
import { optimizeAvatar } from './OperatorProfile';
import { Field, SettingSection } from './SettingsPrimitives';
import { AgentMcpTools } from './AgentMcpTools';
import { AgentProfileDocuments } from './AgentProfileDocuments';
import { AgentDreams } from './AgentDreams';
import { AgentSchedules } from './AgentSchedules';


export type AgentSettingsProps = { selected: Agent; targets: ApiTarget[]; savedProviders: SavedProvider[]; onAgentsChanged: () => Promise<void>; section?: 'details' | 'profile-documents' | 'mcp-tools' | 'cron-jobs' | 'dreams'; overflowTarget?: HTMLElement | null };

export function AgentSettings({ selected, targets, savedProviders, onAgentsChanged, section, overflowTarget }: AgentSettingsProps) {
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
  const details = <SettingSection title="Agent details"><div className="operator-profile agent-profile"><div className="agent-avatar-preview" aria-label={`${name || selected.name} avatar`}>{avatar ? <img src={avatar} alt="" /> : (name || selected.name).slice(0, 1).toUpperCase()}</div><div className="operator-profile-details"><div className="avatar-file-control" onPaste={pasteAvatar}><label className="avatar-file-name">Paste or choose image<input value={avatarFileName} placeholder="Paste an image or choose a file" readOnly aria-label="Agent avatar image" /></label><button className="secondary" type="button" onClick={() => avatarInput.current?.click()}>Change</button><input ref={avatarInput} className="avatar-file-input" type="file" accept="image/*" onChange={(event) => { chooseAvatar(event.target.files?.[0]); event.currentTarget.value = ''; }} /></div>{avatar && <button className="avatar-remove" type="button" onClick={removeAvatar}>Remove image</button>}</div></div><div className="operator-profile-actions agent-profile-actions"><Field label="Displayed name"><input value={name} onChange={(event) => setName(event.target.value)} maxLength={64} /></Field><label className="agent-enabled"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} /><span>Enabled</span></label><button className="primary" onClick={() => void save()} disabled={state !== 'idle'}>{state === 'saving' ? 'Saving…' : 'Save changes'}</button></div>{error && <p className="settings-request-error" role="alert">{error}</p>}<div className="agent-detail-footer"><span>{selected.id}</span><button className="danger" onClick={() => void remove()} disabled={state !== 'idle'}>Delete agent</button></div></SettingSection>;
  if (section === 'details') return details;
  if (section === 'profile-documents') return <AgentProfileDocuments agentId={selected.id} targets={targets} overflowTarget={overflowTarget} />;
  if (section === 'mcp-tools') return <AgentMcpTools agentId={selected.id} targets={targets} />;
  if (section === 'cron-jobs') return <AgentSchedules agentId={selected.id} targets={targets} overflowTarget={overflowTarget} />;
  if (section === 'dreams') return <AgentDreams agentId={selected.id} targets={targets} savedProviders={savedProviders} />;
  return <div className="agent-settings-grid">
    <div className="agent-settings-left">{details}<div className="agent-profile-documents"><AgentProfileDocuments agentId={selected.id} targets={targets} /></div></div>
    <div className="agent-settings-middle"><AgentMcpTools agentId={selected.id} targets={targets} /><AgentSchedules agentId={selected.id} targets={targets} /></div>
    <div className="agent-settings-right agent-settings-dreams"><AgentDreams agentId={selected.id} targets={targets} savedProviders={savedProviders} /></div>
  </div>;
}
