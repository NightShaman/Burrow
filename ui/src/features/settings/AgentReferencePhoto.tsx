import { useEffect, useRef, useState } from 'react';
import { api, fetchApi } from '../../app/api';
import { useUnsavedChanges } from '../../app/UnsavedChanges';

type ReferenceImage = { id: string; attachmentId: string; contentUrl: string; mimeType: string; fileName: string; sizeBytes: number; updatedAt: string };
const types = ['image/png', 'image/jpeg', 'image/webp'];
const maxBytes = 20 * 1024 * 1024;
function acknowledgement(value: unknown, agentId: string, operation: 'load' | 'upload' | 'remove'): ReferenceImage | null {
  const response = value as { ok?: unknown; agentId?: unknown; referenceImage?: ReferenceImage | null } | null;
  const image = response?.referenceImage;
  if (response?.ok !== true || response.agentId !== agentId || image === undefined
    || (operation === 'upload' && image === null) || (operation === 'remove' && image !== null)
    || (image !== null && (typeof image.id !== 'string' || !image.id || typeof image.attachmentId !== 'string'
      || typeof image.contentUrl !== 'string' || !image.contentUrl.startsWith(`/api/agents/${encodeURIComponent(agentId)}/reference-image/content?`)
      || !types.includes(image.mimeType) || typeof image.fileName !== 'string'
      || !Number.isSafeInteger(image.sizeBytes) || image.sizeBytes <= 0 || image.sizeBytes > maxBytes || typeof image.updatedAt !== 'string'))) {
    throw new Error('Invalid reference photo acknowledgement.');
  }
  return image;
}
function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not read the reference photo.'));
    reader.onerror = () => reject(new Error('Could not read the reference photo.'));
    reader.onabort = () => reject(new Error('Could not read the reference photo.'));
    reader.readAsDataURL(file);
  });
}

// AgentDetails keys this independent autosave scope to the selected API owner.
export function AgentReferencePhoto({ agentId, name, disabled, onBusyChange }: { agentId: string; name: string; disabled: boolean; onBusyChange: (busy: boolean) => void }) {
  const [image, setImage] = useState<ReferenceImage | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<File | null | undefined>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [preview, setPreview] = useState('');
  const [previewError, setPreviewError] = useState(false);
  const [previewAttempt, setPreviewAttempt] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const owner = useRef<object | null>(null);
  const working = useRef(false);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  useEffect(() => {
    const ticket = {}; owner.current = ticket; working.current = false;
    return () => { owner.current = null; };
  }, []);
  const load = async () => {
    const ticket = owner.current;
    if (!ticket || working.current) return;
    working.current = true; setLoading(true); setError('');
    try {
      const result = acknowledgement(await api(`/api/agents/${encodeURIComponent(agentId)}/reference-image`), agentId, 'load');
      if (owner.current === ticket) { setImage(result); setLoaded(true); }
    } catch (cause) {
      if (owner.current === ticket) setError(cause instanceof Error ? cause.message : 'Could not load the reference photo.');
    } finally {
      if (owner.current === ticket) { working.current = false; setLoading(false); }
    }
  };
  useEffect(() => { void load(); }, []);
  useEffect(() => {
    setPreview(''); setPreviewError(false);
    if (!image) return;
    const controller = new AbortController();
    let url = '';
    void fetchApi(image.contentUrl, { signal: controller.signal, headers: { accept: image.mimeType } })
      .then(async response => {
        if (!response.ok) throw new Error('Preview unavailable');
        const blob = await response.blob();
        if (!controller.signal.aborted) { url = URL.createObjectURL(blob); setPreview(url); }
      }).catch(() => { if (!controller.signal.aborted) setPreviewError(true); });
    return () => { controller.abort(); if (url) URL.revokeObjectURL(url); };
  }, [image, previewAttempt]);
  const save = async (file: File | null) => {
    const ticket = owner.current;
    if (!ticket || working.current || disabled || !loaded) return false;
    working.current = true; setBusy(true); busyCallback.current(true); setPending(file); setError(''); setNotice('');
    try {
      const content = file ? await readFile(file) : undefined;
      if (owner.current !== ticket) return false;
      const response = await api(`/api/agents/${encodeURIComponent(agentId)}/reference-image`, {
        method: file ? 'PUT' : 'DELETE', headers: { 'content-type': 'application/json' },
        ...(file ? { body: JSON.stringify({ fileName: file.name, content }) } : {}),
      });
      const result = acknowledgement(response, agentId, file ? 'upload' : 'remove');
      if (owner.current !== ticket) return false;
      setImage(result); setPending(undefined); setNotice(file ? 'Reference photo saved.' : 'Reference photo removed.');
      return true;
    } catch (cause) {
      if (owner.current === ticket) setError(cause instanceof Error ? cause.message : 'Could not save the reference photo.');
      return false;
    } finally {
      if (owner.current === ticket) { working.current = false; setBusy(false); busyCallback.current(false); }
    }
  };
  const choose = (file?: File) => {
    if (!file || working.current || disabled || !loaded) return;
    if (!types.includes(file.type) || file.size === 0 || file.size > maxBytes) {
      setError('Choose a PNG, JPEG or WebP image up to 20 MiB.'); setNotice(''); return;
    }
    void save(file);
  };
  useUnsavedChanges({
    dirty: pending !== undefined, busy, resumeAfterAutosave: true,
    save: () => pending === undefined ? Promise.resolve(true) : save(pending),
    discard: () => { setPending(undefined); setError(''); setNotice(''); },
  });
  const locked = disabled || busy || !loaded;
  return <div data-agent-immediate>
    <div className="operator-profile agent-profile">
      <div className="agent-avatar-preview agent-reference-preview" aria-label={`${name} reference photo`}>
        {preview && !previewError ? <img src={preview} alt={`${name} reference photo`} onError={() => setPreviewError(true)} /> : <span aria-hidden="true">—</span>}
      </div>
      <div className="operator-profile-details">
        <div className="avatar-file-control">
          <label className="avatar-file-name">Reference photo<input aria-label="Reference photo file" readOnly value={pending instanceof File ? pending.name : image?.fileName ?? ''} placeholder={loading ? 'Loading…' : 'No reference photo'} title={pending instanceof File ? pending.name : image?.fileName} disabled={disabled || busy} /></label>
          <button className="secondary" type="button" onMouseDown={event => event.preventDefault()} disabled={locked} onClick={() => input.current?.click()}>{image ? 'Replace' : 'Upload'}</button>
          <input ref={input} className="avatar-file-input" aria-label="Upload reference photo" type="file" accept="image/png,image/jpeg,image/webp" disabled={locked} onChange={event => { choose(event.target.files?.[0]); event.currentTarget.value = ''; }} />
        </div>
        {image && <button className="avatar-remove" type="button" disabled={locked} onMouseDown={event => event.preventDefault()} onClick={() => void save(null)}>Remove reference photo</button>}
      </div>
    </div>
    {busy && <p role="status">Saving reference photo…</p>}
    {notice && <p role="status">{notice}</p>}
    {error && <p className="settings-request-error" role="alert">{error}</p>}
    {!loaded && !loading && <button className="secondary" type="button" disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => void load()}>Retry loading reference photo</button>}
    {pending !== undefined && !busy && <button className="secondary" type="button" disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={() => void save(pending)}>Retry saving reference photo</button>}
    {previewError && <><p className="settings-request-error" role="alert">Reference photo preview unavailable.</p><button className="secondary" type="button" onMouseDown={event => event.preventDefault()} onClick={() => setPreviewAttempt(value => value + 1)}>Retry photo preview</button></>}
  </div>;
}
