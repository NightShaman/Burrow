import { useLayoutEffect, useRef, useState } from 'react';
import type { Agent } from '../../app/types';
import { api } from '../../app/api';
import { isAgentEnabled } from '../../app/agentCatalog';
import { useConfirm } from '../../app/ConfirmDialog';
import { isUnsavedChangesModalTarget, useUnsavedChanges } from '../../app/UnsavedChanges';
import { optimizeAvatar } from './OperatorProfile';
import { Field, SettingSection } from './SettingsPrimitives';

type Details = { name: string; avatar: string; enabled: boolean };
type DetailField = keyof Details;
type Scope = DetailField | 'all' | 'failed';
type Accepted = { agent: Pick<Details, 'name' | 'enabled'>; identity: Pick<Details, 'name' | 'avatar'> };
type Failures = Partial<Record<DetailField, string>>;

// Transport success alone is not acceptance. Both endpoints return complete
// records; require the addressed resource and the fields this form consumes.
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
function acknowledgement(endpoint: keyof Accepted, value: unknown, resourceId: string): Accepted[keyof Accepted] {
  const response = record(value);
  const item = endpoint === 'agent' ? record(response?.agent)
    : Array.isArray(response?.agents) ? response.agents.map(record).find(agent => agent?.id === resourceId) : undefined;
  if (response?.ok !== true || item?.id !== resourceId || typeof item.name !== 'string' || !item.name.trim()
    || (endpoint === 'agent' ? typeof item.enabled !== 'boolean'
      : typeof item.avatar !== 'string' || (item.avatar !== '' && !item.avatar.startsWith('data:image/')))) {
    throw new Error(`Invalid ${endpoint === 'agent' ? 'agent registry' : 'agent identity'} acknowledgement.`);
  }
  return endpoint === 'agent' ? { name: item.name, enabled: item.enabled as boolean }
    : { name: item.name, avatar: item.avatar as string };
}

// AgentSettings keys this form by both UI and API identity. Async work must also
// check its lifetime before publishing a result or refreshing the agent catalog.
export function AgentDetails({ selected, onAgentsChanged }: { selected: Agent; onAgentsChanged: () => Promise<void> }) {
  const resourceId = selected.resourceId ?? selected.id;
  const initial = { name: selected.name, avatar: selected.avatar.startsWith('data:image/') ? selected.avatar : '', enabled: isAgentEnabled(selected) };
  const [draft, setDraft] = useState<Details>(initial);
  const [baseline, setBaseline] = useState<Details>(initial);
  const [avatarFileName, setAvatarFileName] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'processing' | 'deleting' | 'refreshing'>('idle');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [failed, setFailed] = useState<Failures>({});
  const [refreshError, setRefreshError] = useState('');
  const accepted = useRef<Accepted>({ agent: { name: initial.name, enabled: initial.enabled }, identity: { name: initial.name, avatar: initial.avatar } });
  const identityExists = useRef(Boolean(initial.avatar));
  const avatarInput = useRef<HTMLInputElement>(null);
  const owner = useRef<object | null>(null);
  const working = useRef(false);
  const latest = useRef({ draft, baseline, failed, onAgentsChanged });
  useLayoutEffect(() => { latest.current = { draft, baseline, failed, onAgentsChanged }; });
  useLayoutEffect(() => {
    const ticket = {};
    owner.current = ticket;
    return () => { owner.current = null; };
  }, []);
  const confirm = useConfirm();
  const busy = state !== 'idle';

  // Catalog reads are not mutations: a failed refresh must never turn an
  // accepted write into a retryable write or restore its old discard baseline.
  const refresh = async (ticket: object) => {
    try {
      await latest.current.onAgentsChanged();
      if (owner.current === ticket) setRefreshError('');
    } catch (cause) {
      if (owner.current === ticket) setRefreshError(cause instanceof Error ? `Could not refresh agents: ${cause.message}` : 'Could not refresh agents.');
    }
  };
  const retryRefresh = async () => {
    const ticket = owner.current;
    if (!ticket || working.current) return;
    working.current = true; setState('refreshing');
    try { await refresh(ticket); }
    finally { if (owner.current === ticket) { working.current = false; setState('idle'); } }
  };
  const save = async (scope: Scope, values = latest.current.draft) => {
    if (!owner.current || working.current) return false;
    const fields: DetailField[] = scope === 'all' ? (['name', 'avatar', 'enabled'] as DetailField[]).filter(field => values[field] !== latest.current.baseline[field] || latest.current.failed[field])
      : scope === 'failed' ? Object.keys(latest.current.failed) as DetailField[] : [scope];
    const includes = (field: DetailField) => fields.includes(field);
    const next = { ...values, name: includes('name') ? values.name.trim() : values.name };
    if (includes('name') && !next.name) {
      setError('An agent needs a display name.'); setNotice(''); return false;
    }
    const saved = accepted.current;
    const agentNext = { ...saved.agent,
      ...(includes('name') ? { name: next.name } : {}),
      ...(includes('enabled') ? { enabled: next.enabled } : {}),
    };
    const identityNext = { ...saved.identity,
      ...(includes('name') ? { name: next.name } : {}),
      ...(includes('avatar') ? { avatar: next.avatar } : {}),
    };
    const agentChanged = agentNext.name !== saved.agent.name || agentNext.enabled !== saved.agent.enabled;
    const identityChanged = identityNext.name !== saved.identity.name || identityNext.avatar !== saved.identity.avatar;
    // A registry-only agent has no identity row yet. Its fallback avatar is not
    // an accepted identity value, so the first identity write must be complete.
    // Existing identities remain PATCH-like: unrelated accepted fields stay out.
    const createsIdentity = identityChanged && !identityExists.current;
    const ticket = owner.current;
    working.current = true;
    setState('saving'); setError(''); setNotice('');
    try {
      const requests: { endpoint: keyof Accepted; fields: DetailField[]; promise: Promise<unknown> }[] = [];
      if (agentChanged) requests.push({ endpoint: 'agent', fields: fields.filter(field => field === 'name' ? agentNext.name !== saved.agent.name : field === 'enabled' && agentNext.enabled !== saved.agent.enabled), promise: api(`/api/agents/${encodeURIComponent(resourceId)}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(agentNext.name !== saved.agent.name ? { name: agentNext.name } : {}), ...(agentNext.enabled !== saved.agent.enabled ? { enabled: agentNext.enabled } : {}) }),
      }) });
      if (identityChanged) requests.push({ endpoint: 'identity', fields: fields.filter(field => field === 'name' ? identityNext.name !== saved.identity.name : field === 'avatar' && identityNext.avatar !== saved.identity.avatar), promise: api('/api/settings/identities', {
        method: 'PUT', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'agent', id: resourceId, ...(createsIdentity || identityNext.name !== saved.identity.name ? { name: identityNext.name } : {}), ...(createsIdentity || identityNext.avatar !== saved.identity.avatar ? { avatar: identityNext.avatar } : {}) }),
      }) });
      // Keep the lock until all endpoints settle, but record acceptance separately.
      const results = await Promise.allSettled(requests.map(request => request.promise.then(value => acknowledgement(request.endpoint, value, resourceId))));
      if (owner.current !== ticket) return false;
      const failures = { ...latest.current.failed };
      fields.forEach(field => { delete failures[field]; });
      const baselineNext = { ...latest.current.baseline };
      let anyAccepted = false;
      results.forEach((result, index) => {
        const request = requests[index];
        if (result.status === 'rejected') {
          const message = result.reason instanceof Error ? result.reason.message : 'Request failed.';
          request.fields.forEach(field => { failures[field] = message; });
        } else {
          anyAccepted = true;
          if (request.endpoint === 'agent') {
            const value = result.value as Accepted['agent'];
            accepted.current.agent = value;
            if (request.fields.includes('name')) baselineNext.name = value.name;
            if (request.fields.includes('enabled')) baselineNext.enabled = value.enabled;
          } else {
            const value = result.value as Accepted['identity'];
            accepted.current.identity = value;
            identityExists.current = true;
            if (request.fields.includes('name')) baselineNext.name = value.name;
            if (request.fields.includes('avatar')) baselineNext.avatar = value.avatar;
          }
        }
      });
      // No-op normalization uses accepted values, never the submitted payload.
      // A partial name write keeps its draft and endpoint-specific retry target.
      fields.forEach(field => {
        if (!failures[field] && !requests.some(request => request.fields.includes(field))) {
          if (field === 'name') baselineNext.name = saved.identity.name;
          else if (field === 'avatar') baselineNext.avatar = saved.identity.avatar;
          else baselineNext.enabled = saved.agent.enabled;
        }
      });
      latest.current.baseline = baselineNext;
      latest.current.failed = failures;
      setBaseline(baselineNext); setFailed(failures);
      setDraft(current => {
        const updated = { ...current };
        fields.forEach(field => { if (!failures[field]) Object.assign(updated, { [field]: baselineNext[field] }); });
        latest.current.draft = updated;
        return updated;
      });
      const messages = [...new Set(Object.values(failures))];
      setError(messages.length ? `Could not save agent: ${messages.join('; ')}` : '');
      const succeeded = !fields.some(field => failures[field]);
      if (succeeded && requests.length) setNotice('Agent details saved.');
      // Publish acceptance before awaiting a read, including partial success.
      if (anyAccepted) await refresh(ticket);
      return owner.current === ticket && succeeded;
    } finally {
      if (owner.current === ticket) { working.current = false; setState('idle'); }
    }
  };
  const saveRef = useRef(save);
  useLayoutEffect(() => { saveRef.current = save; });
  const chooseAvatar = async (file?: File) => {
    if (!file || working.current || !owner.current) return;
    const ticket = owner.current;
    working.current = true; setState('processing'); setError(''); setNotice('');
    try {
      const avatar = await optimizeAvatar(file);
      if (owner.current !== ticket) return;
      const next = { ...latest.current.draft, avatar };
      setDraft(next); setAvatarFileName(file.name || 'Pasted image');
      working.current = false;
      await saveRef.current('avatar', next);
    } catch (cause) {
      if (owner.current === ticket) setError(cause instanceof Error ? cause.message : 'Could not process the avatar image.');
    } finally {
      if (owner.current === ticket) { working.current = false; setState('idle'); }
    }
  };
  const removeAvatar = () => {
    if (working.current) return;
    const next = { ...draft, avatar: '' };
    setDraft(next); setAvatarFileName('');
    if (avatarInput.current) avatarInput.current.value = '';
    void save('avatar', next);
  };
  const remove = async () => {
    const ticket = owner.current;
    if (!ticket || working.current) return;
    if (!await confirm({ title: 'Delete agent?', message: `Delete ${selected.name}? This removes the agent registration, not its workspace files.`, confirmLabel: 'Delete agent', tone: 'danger' })) return;
    if (owner.current !== ticket || working.current) return;
    working.current = true; setState('deleting'); setError(''); setNotice('');
    try {
      await api(`/api/agents/${encodeURIComponent(resourceId)}`, { method: 'DELETE' });
      if (owner.current === ticket) await refresh(ticket);
    } catch (cause) {
      if (owner.current === ticket) setError(cause instanceof Error ? `Could not delete agent: ${cause.message}` : 'Could not delete agent.');
    } finally {
      if (owner.current === ticket) { working.current = false; setState('idle'); }
    }
  };
  useUnsavedChanges({
    dirty: draft.name !== baseline.name || draft.avatar !== baseline.avatar || draft.enabled !== baseline.enabled || Object.keys(failed).length > 0,
    busy,
    resumeAfterAutosave: true,
    save: () => save('all'),
    // Discard abandons unaccepted work; it cannot undo an accepted endpoint.
    // Keep endpoint baselines separate. Future Save-all scopes only dirty fields,
    // so an abandoned partial rename is not replayed by an unrelated edit.
    discard: () => { setDraft(latest.current.baseline); setAvatarFileName(''); setError(''); setNotice(''); latest.current.failed = {}; setFailed({}); },
  });
  return <SettingSection title="Agent details">
    <div className="operator-profile agent-profile">
      <div className="agent-avatar-preview" aria-label={`${draft.name || selected.name} avatar`}>{draft.avatar ? <img src={draft.avatar} alt="" /> : (draft.name || selected.name).slice(0, 1).toUpperCase()}</div>
      <div className="operator-profile-details">
        <div className="avatar-file-control" onPaste={event => {
          const file = Array.from(event.clipboardData.items).find(item => item.type.startsWith('image/'))?.getAsFile();
          if (file) { event.preventDefault(); void chooseAvatar(file); }
        }}>
          <label className="avatar-file-name">Paste or choose image<input value={avatarFileName} placeholder="Paste an image or choose a file" readOnly aria-label="Agent avatar image" disabled={busy} data-agent-immediate /></label>
          <button className="secondary" type="button" data-agent-immediate onMouseDown={event => event.preventDefault()} onClick={() => avatarInput.current?.click()} disabled={busy}>Change</button>
          <input ref={avatarInput} className="avatar-file-input" type="file" accept="image/*" disabled={busy} data-agent-immediate onChange={event => { void chooseAvatar(event.target.files?.[0]); event.currentTarget.value = ''; }} />
        </div>
        {draft.avatar && <button className="avatar-remove" type="button" data-agent-immediate onMouseDown={event => event.preventDefault()} onClick={removeAvatar} disabled={busy}>Remove image</button>}
      </div>
    </div>
    <div className="operator-profile-actions agent-profile-actions">
      <Field label="Displayed name"><input value={draft.name} maxLength={64} disabled={busy} onChange={event => { setDraft({ ...draft, name: event.target.value }); setError(''); setNotice(''); }} onBlur={event => {
        // Immediate actions and the unsaved guard modal must not commit the
        // unrelated, unfinished name merely because they receive focus.
        if (isUnsavedChangesModalTarget(event.relatedTarget)
          || event.relatedTarget instanceof Element && event.relatedTarget.closest('[data-agent-immediate]')) return;
        if (event.currentTarget.value !== latest.current.baseline.name) void save('name', { ...latest.current.draft, name: event.currentTarget.value });
      }} /></Field>
      <label className="agent-enabled" data-agent-immediate onMouseDown={event => event.preventDefault()}><input type="checkbox" checked={draft.enabled} disabled={busy} data-agent-immediate onMouseDown={event => event.preventDefault()} onChange={event => {
        const next = { ...draft, enabled: event.target.checked }; setDraft(next); void save('enabled', next);
      }} /><span>Enabled</span></label>
    </div>
    {Object.keys(failed).length > 0 && !busy && <button className="secondary" data-agent-immediate onMouseDown={event => event.preventDefault()} onClick={() => void save('failed')}>Retry saving agent</button>}
    {busy && <p role="status">{state === 'processing' ? 'Processing agent avatar…' : state === 'deleting' ? 'Deleting agent…' : state === 'refreshing' ? 'Refreshing agents…' : 'Saving agent details…'}</p>}
    {notice && <p role="status">{notice}</p>}
    {refreshError && <><p className="settings-request-error" role="alert">{refreshError}</p><button className="secondary" data-agent-immediate onMouseDown={event => event.preventDefault()} onClick={() => void retryRefresh()} disabled={busy}>Retry refreshing agents</button></>}
    {error && <p className="settings-request-error" role="alert">{error}</p>}
    <div className="agent-detail-footer"><span>{selected.id}</span><button className="danger" data-agent-immediate onMouseDown={event => event.preventDefault()} onClick={() => void remove()} disabled={busy}>Delete agent</button></div>
  </SettingSection>;
}
