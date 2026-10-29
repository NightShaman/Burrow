import { isUnsavedChangesModalTarget, useUnsavedChanges } from '../../app/UnsavedChanges';
import { useEffect, useRef, useState, type ClipboardEvent, type ReactNode } from 'react';
import { api } from '../../app/api';

const MAX_AVATAR_FILE_SIZE = 50_000_000;
const MAX_AVATAR_DATA_URL_SIZE = 512_000;
const AVATAR_MAX_DIMENSION = 512;

type Profile = { name: string; avatar: string };
type ProfileField = keyof Profile;
type SaveScope = ProfileField | 'profile' | 'failed';
type SaveFailures = Partial<Record<ProfileField, string>>;
type Status = 'loading' | 'idle' | 'processing' | 'saving' | 'error';

export async function optimizeAvatar(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Choose or paste an image file for the avatar.');
  if (file.size > MAX_AVATAR_FILE_SIZE) throw new Error('Avatar image is too large to process. Maximum original file size is 50 MB.');

  const source = await new Promise<HTMLImageElement>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve(image); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read the avatar image.')); };
    image.src = url;
  });
  const scale = Math.min(1, AVATAR_MAX_DIMENSION / Math.max(source.naturalWidth, source.naturalHeight));
  let width = Math.max(1, Math.round(source.naturalWidth * scale));
  let height = Math.max(1, Math.round(source.naturalHeight * scale));
  const canvas = document.createElement('canvas');

  for (let attempt = 0; attempt < 6; attempt += 1) {
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Could not process the avatar image.');
    context.drawImage(source, 0, 0, width, height);
    for (const quality of [0.86, 0.72, 0.58]) {
      const avatar = canvas.toDataURL('image/webp', quality);
      if (avatar.length <= MAX_AVATAR_DATA_URL_SIZE) return avatar;
    }
    width = Math.max(1, Math.round(width * 0.75));
    height = Math.max(1, Math.round(height * 0.75));
  }
  throw new Error('Could not optimize the avatar image enough to save it.');
}

function SettingSection({ title, children }: { title: string; children: ReactNode }) {
  return <section className="setting-section"><h2>{title}</h2>{children}</section>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className="field"><span>{label}</span>{children}</label>;
}

export function OperatorProfile({ onSaved }: { onSaved: (profile: Profile) => void }) {
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState('');
  const [baseline, setBaseline] = useState<Profile>({ name: '', avatar: '' });
  const [avatarFileName, setAvatarFileName] = useState('');
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [failedSaves, setFailedSaves] = useState<SaveFailures>({});
  const [retry, setRetry] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const owner = useRef<object | null>(null);
  const avatarOwner = useRef<object | null>(null);
  const working = useRef(false);
  const statusRef = useRef<Status>('loading');
  const setCurrentStatus = (next: Status) => { statusRef.current = next; setStatus(next); };

  useEffect(() => {
    const ticket = {};
    owner.current = ticket;
    avatarOwner.current = null;
    working.current = false;
    const controller = new AbortController();
    setCurrentStatus('loading'); setError(''); setNotice(''); setFailedSaves({});
    api<{ operator: Profile }>('/api/settings/identities', { signal: controller.signal }).then(result => {
      if (owner.current !== ticket) return;
      if (!result || !result.operator || typeof result.operator.name !== 'string' || typeof result.operator.avatar !== 'string') throw new Error('Invalid operator profile response.');
      setBaseline(result.operator); setName(result.operator.name); setAvatar(result.operator.avatar); setAvatarFileName(''); setCurrentStatus('idle');
    }).catch(cause => {
      if (owner.current !== ticket) return;
      setError(cause instanceof Error ? `Could not load operator profile: ${cause.message}` : 'Could not load operator profile.');
      setCurrentStatus('error');
    });
    return () => {
      if (owner.current === ticket) owner.current = null;
      avatarOwner.current = null;
      working.current = false;
      controller.abort();
    };
  }, [retry]);

  const save = async (scope: SaveScope, draft: Profile = { name, avatar }) => {
    if (statusRef.current !== 'idle' || !owner.current || working.current) return false;
    const fields: ProfileField[] = scope === 'profile' ? ['name', 'avatar']
      : scope === 'failed' ? Object.keys(failedSaves) as ProfileField[] : [scope];
    const includes = (field: ProfileField) => fields.includes(field);
    const clearFailures = () => setFailedSaves(current => {
      const remaining = { ...current };
      fields.forEach(field => { delete remaining[field]; });
      return remaining;
    });
    const normalizedName = draft.name.trim();
    if (includes('name') && !normalizedName) {
      setError('Your displayed name cannot be empty.'); setNotice('');
      return false;
    }

    // A field autosave carries the last accepted value of the other field. This
    // keeps an unrelated in-memory draft out of the mutation and its callback.
    const next = {
      name: includes('name') ? normalizedName : baseline.name,
      avatar: includes('avatar') ? draft.avatar : baseline.avatar,
    };
    const changedFields = fields.filter(field => next[field] !== baseline[field]);
    if (!changedFields.length) {
      if (includes('name')) setName(baseline.name);
      if (includes('avatar')) setAvatar(baseline.avatar);
      setError(''); setNotice(''); clearFailures();
      return true;
    }

    const ticket = owner.current;
    working.current = true;
    setCurrentStatus('saving'); setError(''); setNotice('');
    try {
      const result = await api<{ ok: boolean; operator: Profile }>('/api/settings/identities', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ kind: 'operator', id: 'default', ...next }),
      });
      if (owner.current !== ticket) return false;
      // PUT returns an acknowledged identities snapshot, not an empty ACK or
      // an echo of our request. Only accepted server values advance the baseline.
      if (!result || result.ok !== true || !result.operator || typeof result.operator.name !== 'string' || typeof result.operator.avatar !== 'string') {
        throw new Error('Invalid operator profile save response.');
      }
      const accepted = { name: result.operator.name, avatar: result.operator.avatar };
      setBaseline(accepted);
      setName(current => includes('name') || current === baseline.name ? accepted.name : current);
      setAvatar(current => includes('avatar') || current === baseline.avatar ? accepted.avatar : current);
      clearFailures();
      setNotice(fields.length > 1 ? 'Operator profile saved.' : includes('name') ? 'Operator name saved.' : 'Operator avatar saved.');
      onSaved(accepted);
      return true;
    } catch (cause) {
      if (owner.current === ticket) {
        const message = cause instanceof Error ? cause.message : 'Request failed.';
        setFailedSaves(current => ({ ...current, ...Object.fromEntries(changedFields.map(field => [field, message])) }));
      }
    } finally {
      if (owner.current === ticket) { working.current = false; setCurrentStatus('idle'); }
    }
    return false;
  };

  const saveRef = useRef(save);
  saveRef.current = save;

  const chooseAvatar = async (file?: File) => {
    if (!file || statusRef.current !== 'idle' || working.current || !owner.current) return;
    const ticket = owner.current;
    const processTicket = {};
    avatarOwner.current = processTicket;
    working.current = true;
    setCurrentStatus('processing'); setError(''); setNotice('');
    try {
      const nextAvatar = await optimizeAvatar(file);
      if (ticket !== owner.current || avatarOwner.current !== processTicket) return;
      setAvatar(nextAvatar); setAvatarFileName(file.name || 'Pasted image');
      working.current = false;
      setCurrentStatus('idle');
      await saveRef.current('avatar', { name, avatar: nextAvatar });
    } catch (cause) {
      if (ticket === owner.current && avatarOwner.current === processTicket) {
        setError(cause instanceof Error ? cause.message : 'Could not process the avatar image.');
        setCurrentStatus('idle');
      }
    } finally {
      if (avatarOwner.current === processTicket) avatarOwner.current = null;
      if (ticket === owner.current && statusRef.current === 'idle') working.current = false;
    }
  };
  const pasteAvatar = (event: ClipboardEvent<HTMLDivElement>) => {
    if (status !== 'idle') return;
    const item = Array.from(event.clipboardData.items).find(clipboardItem => clipboardItem.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (!file) return;
    event.preventDefault();
    void chooseAvatar(file);
  };
  const removeAvatar = () => {
    if (status !== 'idle' || working.current) return;
    setAvatar(''); setAvatarFileName(''); setError(''); setNotice('');
    if (fileInput.current) fileInput.current.value = '';
    void save('avatar', { name, avatar: '' });
  };
  const discard = () => {
    setName(baseline.name); setAvatar(baseline.avatar); setAvatarFileName(''); setError(''); setNotice(''); setFailedSaves({});
    if (fileInput.current) fileInput.current.value = '';
  };
  const invalidName = status === 'idle' && name !== baseline.name && !name.trim();
  useUnsavedChanges({
    dirty: status !== 'loading' && status !== 'error' && (name !== baseline.name || avatar !== baseline.avatar || Object.keys(failedSaves).length > 0),
    busy: status === 'saving' || status === 'processing',
    resumeAfterAutosave: true,
    save: () => save('profile'),
    discard,
  });

  return <SettingSection title="Operator profile">
    <div className="operator-profile">
      <div className="agent-avatar-preview">{avatar ? <img src={avatar} alt="" /> : (name.trim()[0] || '?').toUpperCase()}</div>
      <div className="operator-profile-details">
        <div className="avatar-file-control" onPaste={pasteAvatar}>
          <label className="avatar-file-name">Paste or choose image<input data-operator-immediate value={avatarFileName} placeholder="Paste an image or choose a file" disabled={status !== 'idle'} readOnly aria-label="Avatar image" /></label>
          <button data-operator-immediate className="secondary" type="button" onMouseDown={event => event.preventDefault()} onClick={() => fileInput.current?.click()} disabled={status !== 'idle'}>Change</button>
          <input data-operator-immediate ref={fileInput} className="avatar-file-input" type="file" accept="image/*" disabled={status !== 'idle'} onChange={event => { void chooseAvatar(event.target.files?.[0]); event.currentTarget.value = ''; }} />
        </div>
        {avatar && <button data-operator-immediate className="avatar-remove" type="button" onMouseDown={event => event.preventDefault()} onClick={removeAvatar} disabled={status !== 'idle'}>Remove image</button>}
      </div>
    </div>
    <div className="operator-profile-actions">
      <Field label="Displayed name"><input value={name} onChange={event => {
        setName(event.target.value); setError(''); setNotice('');
        setFailedSaves(current => { const remaining = { ...current }; delete remaining.name; return remaining; });
      }} onBlur={event => {
        // Keyboard and touch focus changes do not necessarily fire mouseDown.
        // Avatar actions must not submit or disable an unrelated name draft.
        if (isUnsavedChangesModalTarget(event.relatedTarget)
          || event.relatedTarget instanceof Element && event.relatedTarget.closest('[data-operator-immediate]')) return;
        if (event.currentTarget.value !== baseline.name) void save('name', { name: event.currentTarget.value, avatar });
      }} placeholder="Your name" disabled={status !== 'idle'} /></Field>
    </div>
    {status === 'error' && <button type="button" onClick={() => setRetry(value => value + 1)}>Retry operator profile</button>}
    {status === 'idle' && Object.keys(failedSaves).length > 0 && (failedSaves.avatar || !invalidName) && <button data-operator-immediate type="button" className="secondary" onMouseDown={event => event.preventDefault()} onClick={() => void save('failed')}>Retry saving operator profile</button>}
    {status === 'loading' && <p role="status">Loading operator profile…</p>}
    {status === 'processing' && <p role="status">Processing operator avatar…</p>}
    {status === 'saving' && <p role="status">Saving operator profile…</p>}
    {(error || Object.keys(failedSaves).length > 0) && <p className="settings-request-error" role="alert">{[error, ...Object.entries(failedSaves).map(([field, message]) => `Could not save operator profile (${field}): ${message}`)].filter(Boolean).join(' ')}</p>}
    {notice && <p role="status">{notice}</p>}
  </SettingSection>;
}
