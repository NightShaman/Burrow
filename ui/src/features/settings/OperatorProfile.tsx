import { useEffect, useRef, useState, type ClipboardEvent, type ReactNode } from 'react';
import { api } from '../../app/api';

const MAX_AVATAR_FILE_SIZE = 50_000_000;
const MAX_AVATAR_DATA_URL_SIZE = 512_000;
const AVATAR_MAX_DIMENSION = 512;

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

export function OperatorProfile({ onSaved }: { onSaved: (profile: { name: string; avatar: string }) => void }) {
  const [name, setName] = useState('');
  const [avatar, setAvatar] = useState('');
  const [avatarFileName, setAvatarFileName] = useState('');
  const [status, setStatus] = useState<'loading' | 'idle' | 'saving' | 'error'>('loading');
  const [error, setError] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const [retry, setRetry] = useState(0);
  const owner = useRef<object | null>(null);
  useEffect(() => {
    const ticket = {}; owner.current = ticket;
    const controller = new AbortController();
    setStatus('loading'); setError('');
    api<{ operator: { name: string; avatar: string } }>('/api/settings/identities', { signal: controller.signal }).then(result => {
      if (owner.current !== ticket) return;
      setName(result.operator.name); setAvatar(result.operator.avatar); setAvatarFileName(''); setStatus('idle');
    }).catch(cause => {
      if (owner.current !== ticket) return;
      setError(cause instanceof Error ? `Could not load operator profile: ${cause.message}` : 'Could not load operator profile.');
      setStatus('error');
    });
    return () => { owner.current = null; controller.abort(); };
  }, [retry]);
  const chooseAvatar = async (file?: File) => {
    if (!file || status !== 'idle') return;
    const ticket = owner.current;
    try { const next = await optimizeAvatar(file); if (ticket !== owner.current) return; setAvatar(next); setAvatarFileName(file.name || 'Pasted image'); setError(''); }
    catch (cause) { if (ticket === owner.current) setError(cause instanceof Error ? cause.message : 'Could not process the avatar image.'); }
  };
  const pasteAvatar = (event: ClipboardEvent<HTMLDivElement>) => {
    if (status !== 'idle') return;
    const item = Array.from(event.clipboardData.items).find((clipboardItem) => clipboardItem.type.startsWith('image/'));
    const file = item?.getAsFile();
    if (!file) return;
    event.preventDefault();
    void chooseAvatar(file);
  };
  const removeAvatar = () => { if (status !== 'idle') return; setAvatar(''); setAvatarFileName(''); setError(''); if (fileInput.current) fileInput.current.value = ''; };
  const save = async () => {
    if (status !== 'idle' || !owner.current) return;
    const ticket = owner.current;
    const nextName = name.trim();
    if (!nextName) { setError('Your displayed name cannot be empty.'); return; }
    setStatus('saving'); setError('');
    try { await api('/api/settings/identities', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'operator', id: 'default', name: nextName, avatar }) }); if (owner.current === ticket) onSaved({ name: nextName, avatar }); }
    catch (cause) { if (owner.current === ticket) setError(cause instanceof Error ? `Could not save operator profile: ${cause.message}` : 'Could not save operator profile.'); }
    finally { if (owner.current === ticket) setStatus('idle'); }
  };
  return <SettingSection title="Operator profile"><div className="operator-profile"><div className="agent-avatar-preview">{avatar ? <img src={avatar} alt="" /> : (name.trim()[0] || '?').toUpperCase()}</div><div className="operator-profile-details"><div className="avatar-file-control" onPaste={pasteAvatar}><label className="avatar-file-name">Paste or choose image<input value={avatarFileName} placeholder="Paste an image or choose a file" disabled={status !== 'idle'} readOnly aria-label="Avatar image" /></label><button className="secondary" type="button" onClick={() => fileInput.current?.click()} disabled={status !== 'idle'}>Change</button><input ref={fileInput} className="avatar-file-input" type="file" accept="image/*" disabled={status !== 'idle'} onChange={(event) => { void chooseAvatar(event.target.files?.[0]); event.currentTarget.value = ''; }} /></div>{avatar && <button className="avatar-remove" type="button" onClick={removeAvatar} disabled={status !== 'idle'}>Remove image</button>}</div></div><div className="operator-profile-actions"><Field label="Displayed name"><input value={name} onChange={(event) => setName(event.target.value)} placeholder="Your name" disabled={status !== 'idle'} /></Field><button className="primary" type="button" onClick={() => { void save(); }} disabled={status !== 'idle'}>{status === 'saving' ? 'Saving…' : 'Save profile'}</button></div>{status === 'error' && <button type="button" onClick={() => setRetry(value => value + 1)}>Retry operator profile</button>}{error && <p className="settings-request-error" role="alert">{error}</p>}</SettingSection>;
}
