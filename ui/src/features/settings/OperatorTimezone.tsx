import { useEffect, useRef, useState } from 'react';
import { api } from '../../app/api';
import { Field, SettingSection } from './SettingsPrimitives';

export function OperatorTimezone() {
  const [timezone, setTimezone] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'error'>('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);
  const owner = useRef<object | null>(null);
  useEffect(() => {
    const ticket = {}; owner.current = ticket;
    const controller = new AbortController();
    setState('loading'); setError(''); setNotice('');
    api<{ timezone: string }>('/api/settings/timezone', { signal: controller.signal }).then(result => {
      if (owner.current !== ticket) return;
      setTimezone(result.timezone); setState('ready');
    }).catch(() => { if (owner.current === ticket) { setError('Could not load operator timezone.'); setState('error'); } });
    return () => { owner.current = null; controller.abort(); };
  }, [retry]);
  const save = async () => {
    if (state !== 'ready' || !owner.current) return;
    const ticket = owner.current;
    setError(''); setNotice('');
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: timezone.trim() });
      setState('saving');
      const result = await api<{ timezone: string }>('/api/settings/timezone', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timezone: timezone.trim() }) });
      if (owner.current === ticket) { setTimezone(result.timezone); setNotice('Operator timezone saved.'); }
    } catch { if (owner.current === ticket) setError('Could not save timezone. Enter a valid IANA timezone such as America/Chicago.'); }
    finally { if (owner.current === ticket) setState('ready'); }
  };
  return <SettingSection title="Operator timezone"><p className="settings-description">Used for agent time context and new schedule defaults. Displayed dates and times always follow your browser, including when you travel. Existing schedules keep their configured timezone.</p><Field label="Operator timezone"><input value={timezone} disabled={state !== 'ready'} onChange={event => setTimezone(event.target.value)} placeholder="America/Chicago" /></Field><button type="button" className="secondary" disabled={state !== 'ready'} onClick={() => setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone)}>Use browser timezone</button><button type="button" className="primary" disabled={state !== 'ready' || !timezone.trim()} onClick={() => void save()}>{state === 'saving' ? 'Saving…' : 'Save timezone'}</button>{state === 'error' && <button type="button" onClick={() => setRetry(value => value + 1)}>Retry operator timezone</button>}{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}</SettingSection>;
}
