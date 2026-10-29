import { useEffect, useRef, useState } from 'react';
import { SettingSection } from './SettingsPrimitives';
import { api } from '../../app/api';
import { useUnsavedChanges } from '../../app/UnsavedChanges';

type OriginSettings = {
  ok: true;
  settings: { checkOrigin: boolean };
  effective: { checkOrigin: boolean; source: 'environment' | 'database' | 'default'; allowedOrigins: string[] };
};
const path = '/api/settings/browser-origin';

export function BrowserOriginSettings() {
  const [result, setResult] = useState<OriginSettings | null>(null);
  const [checkOrigin, setCheckOrigin] = useState(true);
  const [state, setState] = useState<'loading' | 'idle' | 'saving' | 'error'>('loading');
  const [error, setError] = useState('');
  const busy = useRef(false);
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);
  // Settings uses the same-origin runtime only. Fence responses across unmounts/reloads.
  const owner = useRef<object | null>(null);
  useEffect(() => {
    const ticket = {}; owner.current = ticket;
    const controller = new AbortController();
    setState('loading'); setResult(null); setError(''); setNotice('');
    api<OriginSettings>(path, { signal: controller.signal }).then(next => {
      if (owner.current !== ticket) return;
      setResult(next); setCheckOrigin(next.settings.checkOrigin); setState('idle');
    }).catch(() => {
      if (owner.current !== ticket) return;
      setError('Could not load browser origin settings.'); setState('error');
    });
    return () => { owner.current = null; controller.abort(); };
  }, [retry]);
  const save = async (nextValue = checkOrigin) => {
    if (state !== 'idle' || !result || busy.current) return false;
    if (nextValue === result.settings.checkOrigin) return true;
    busy.current = true;
    const ticket = owner.current;
    setState('saving'); setError(''); setNotice('');
    try {
      const next = await api<OriginSettings>(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checkOrigin: nextValue }) });
      if (ticket === null || owner.current !== ticket) return false;
      if (next.ok !== true || typeof next.settings?.checkOrigin !== 'boolean' || typeof next.effective?.checkOrigin !== 'boolean' || !['environment', 'database', 'default'].includes(next.effective?.source)) throw new Error('Invalid browser origin response');
      setResult(next); setCheckOrigin(next.settings.checkOrigin);
      setNotice(next.effective.source === 'environment' ? 'Preference saved. Environment override remains active.' : 'Browser origin setting saved and applied.');
      return true;
    } catch {
      if (ticket !== null && owner.current === ticket) setError('Could not save browser origin settings. Try saving again.');
      return false;
    } finally {
      if (ticket !== null && owner.current === ticket) { busy.current = false; setState('idle'); }
    }
  };
  useUnsavedChanges({ dirty: !!result && checkOrigin !== result.settings.checkOrigin, busy: state === 'saving', resumeAfterAutosave: true, save: () => save(), discard: () => { if (result) setCheckOrigin(result.settings.checkOrigin); setError(''); setNotice(''); } });
  return <SettingSection title="Browser origin">
    <label className="agent-enabled"><input type="checkbox" checked={checkOrigin} disabled={state !== 'idle' || !result} onChange={event => { const next = event.target.checked; setCheckOrigin(next); setNotice(''); setError(''); void save(next); }} /><span>Check browser origin</span></label>
    <p className="settings-description">Reject requests from unapproved browser origins. This check is independent of authentication and is saved separately.</p>
    {result && <p className={result.effective.source === 'environment' ? 'settings-auth-warning' : 'settings-description'} role="status">Effective: {result.effective.checkOrigin ? 'On' : 'Off'}{result.effective.source === 'environment' ? ' · Environment override controls this runtime.' : ''}</p>}
    {state === 'saving' && <p role="status">Saving browser origin…</p>}
    {state === 'idle' && error && result && checkOrigin !== result.settings.checkOrigin && <button type="button" className="secondary" onClick={() => void save()}>Retry saving browser origin</button>}
    {state === 'loading' && <p role="status">Loading browser origin settings…</p>}
    {state === 'error' && <button type="button" onClick={() => setRetry(value => value + 1)}>Retry browser origin</button>}
    {error && <p className="settings-request-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </SettingSection>;
}
