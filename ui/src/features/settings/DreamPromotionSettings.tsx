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
  const busy = useRef(false);
  const [notice, setNotice] = useState('');
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
  const save = async (nextValue = value) => {
    if (state !== 'idle' || busy.current) return false;
    if (nextValue === saved) return true;
    busy.current = true;
    const active = mounted.current;
    setState('saving'); setError(''); setNotice('');
    try {
      const result = await api<PromotionSettings>(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ promoteDreamsToMemory: nextValue }) });
      if (!active()) return false;
      if (typeof result.promoteDreamsToMemory !== 'boolean') throw new Error('Invalid promotion settings response');
      const accepted = result.promoteDreamsToMemory;
      setValue(accepted); setSaved(accepted); setNotice('Dream promotion settings saved.'); return true;
    } catch {
      if (active()) setError('Could not save Dream promotion settings. Your change is still here; retry saving.');
    } finally { if (active()) { busy.current = false; setState('idle'); } }
    return false;
  };
  useUnsavedChanges({ dirty: state !== 'loading' && state !== 'error' && value !== saved, busy: state === 'saving', save: () => save(), discard: () => { setValue(saved); setError(''); setNotice(''); } });
  return <div className="curator-card dream-promotion-settings">
    <label className="agent-enabled"><input type="checkbox" checked={value} disabled={state !== 'idle'} aria-describedby="global-dream-promotion-help" onChange={event => { const next = event.target.checked; setValue(next); setError(''); setNotice(''); void save(next); }} /><span>Promote Dreams to memory</span></label>
    <p id="global-dream-promotion-help" className="settings-description">Requires promotion in the agent’s Dreams settings too. Off keeps Dreams and their archive; existing memories and explicit saves are unchanged. Re-enabling does not catch up skipped promotions.</p>
    {state === 'loading' && <p role="status">Loading Dream promotion settings…</p>}
    {error && <p className="settings-request-error" role="alert">{error}</p>}
    {state === 'error' && <button type="button" onClick={() => setRetry(current => current + 1)}>Retry loading promotion settings</button>}
    {state === 'saving' && <p role="status">Saving Dream promotion settings…</p>}
    {state === 'idle' && error && value !== saved && <button type="button" className="secondary" onClick={() => void save()}>Retry saving promotion settings</button>}
    {notice && <p role="status">{notice}</p>}
  </div>;
}
