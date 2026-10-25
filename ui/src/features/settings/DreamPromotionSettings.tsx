import { useUnsavedChanges } from '../../app/UnsavedChanges';
import { useEffect, useRef, useState } from 'react';
import { api } from '../../app/api';

type PromotionSettings = { promoteDreamsToMemory?: boolean };
const path = '/api/settings/brain-memory';

export function DreamPromotionSettings() {
  const [value, setValue] = useState(true);
  const [saved, setSaved] = useState(true);
  const [state, setState] = useState<'loading' | 'idle' | 'saving' | 'error'>('loading');
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState('loading'); setError('');
    api<PromotionSettings>(path, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setValue(result.promoteDreamsToMemory ?? true); setSaved(result.promoteDreamsToMemory ?? true); setState('idle');
    }).catch(() => {
      if (controller.signal.aborted) return;
      setError('Could not load Dream promotion settings.'); setState('error');
    });
    return () => controller.abort();
  }, [retry]);
  // Capture the mount owner so a late save cannot update a replacement section.
  const mounted = useRef<() => boolean>(() => false);
  useEffect(() => { let active = true; mounted.current = () => active; return () => { active = false; }; }, []);
  const save = async () => {
    if (state !== 'idle') return false;
    const active = mounted.current;
    setState('saving'); setError('');
    try {
      const result = await api<PromotionSettings>(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ promoteDreamsToMemory: value }) });
      if (!active()) return false;
      const accepted = result.promoteDreamsToMemory ?? true;
      setValue(accepted); setSaved(accepted); return true;
    } catch {
      if (active()) setError('Could not save Dream promotion settings. Your change is still here; retry saving.');
    } finally { if (active()) setState('idle'); }
    return false;
  };
  useUnsavedChanges({ dirty: state !== 'loading' && state !== 'error' && value !== saved, busy: state === 'saving', save, discard: () => { setValue(saved); setError(''); } });
  return <div className="curator-card dream-promotion-settings">
    <label className="agent-enabled"><input type="checkbox" checked={value} disabled={state !== 'idle'} aria-describedby="global-dream-promotion-help" onChange={event => { setValue(event.target.checked); setError(''); }} /><span>Promote Dreams to memory</span></label>
    <p id="global-dream-promotion-help" className="settings-description">Requires promotion in the agent’s Dreams settings too. Off keeps Dreams and their archive; existing memories and explicit saves are unchanged. Re-enabling does not catch up skipped promotions.</p>
    {state === 'loading' && <p role="status">Loading Dream promotion settings…</p>}
    {error && <p className="settings-request-error" role="alert">{error}</p>}
    {state === 'error' ? <button type="button" onClick={() => setRetry(current => current + 1)}>Retry loading promotion settings</button> : <button type="button" className="primary" disabled={state !== 'idle' || value === saved} onClick={() => void save()}>{state === 'saving' ? 'Saving…' : 'Save promotion settings'}</button>}
  </div>;
}
