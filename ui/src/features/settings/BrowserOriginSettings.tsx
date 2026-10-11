import { useEffect, useRef, useState } from 'react';
import { SettingSection } from './SettingsPrimitives';
import { api } from '../../app/api';

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
  const save = async () => {
    if (state !== 'idle' || !result) return;
    const ticket = owner.current;
    setState('saving'); setError(''); setNotice('');
    try {
      const next = await api<OriginSettings>(path, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checkOrigin }) });
      if (ticket === null || owner.current !== ticket) return;
      setResult(next); setCheckOrigin(next.settings.checkOrigin);
      setNotice(next.effective.source === 'environment' ? 'Preference saved. Environment override remains active.' : 'Browser origin setting saved and applied.');
    } catch {
      if (ticket !== null && owner.current === ticket) setError('Could not save browser origin settings. Try saving again.');
    } finally {
      if (ticket !== null && owner.current === ticket) setState('idle');
    }
  };
  return <SettingSection title="Browser origin">
    <label className="agent-enabled"><input type="checkbox" checked={checkOrigin} disabled={state !== 'idle' || !result} onChange={event => { setCheckOrigin(event.target.checked); setNotice(''); setError(''); }} /><span>Check browser origin</span></label>
    <p className="settings-description">Reject requests from unapproved browser origins. This check is independent of authentication and is saved separately.</p>
    {result && <p className={result.effective.source === 'environment' ? 'settings-auth-warning' : 'settings-description'} role="status">Effective: {result.effective.checkOrigin ? 'On' : 'Off'}{result.effective.source === 'environment' ? ' · Environment override controls this runtime.' : ''}</p>}
    <div className="auth-actions"><button type="button" className="primary" disabled={state !== 'idle' || !result} onClick={() => void save()}>{state === 'saving' ? 'Saving…' : 'Save browser origin'}</button></div>
    {state === 'loading' && <p role="status">Loading browser origin settings…</p>}
    {state === 'error' && <button type="button" onClick={() => setRetry(value => value + 1)}>Retry browser origin</button>}
    {error && <p className="settings-request-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </SettingSection>;
}
