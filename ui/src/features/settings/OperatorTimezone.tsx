import { useEffect, useState } from 'react';
import { api } from '../../app/api';
import { Field, SettingSection } from './SettingsPrimitives';

export function OperatorTimezone() {
  const [timezone, setTimezone] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'saving'>('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  useEffect(() => {
    let active = true;
    void api<{ timezone: string }>('/api/settings/timezone').then(result => {
      if (active) { setTimezone(result.timezone); setState('ready'); }
    }).catch(() => { if (active) { setError('Could not load operator timezone.'); setState('ready'); } });
    return () => { active = false; };
  }, []);
  const save = async () => {
    setError(''); setNotice('');
    try {
      new Intl.DateTimeFormat(undefined, { timeZone: timezone.trim() });
      setState('saving');
      const result = await api<{ timezone: string }>('/api/settings/timezone', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timezone: timezone.trim() }) });
      setTimezone(result.timezone); setNotice('Operator timezone saved.');
    } catch { setError('Could not save timezone. Enter a valid IANA timezone such as America/Chicago.'); }
    finally { setState('ready'); }
  };
  return <SettingSection title="Operator timezone"><p className="settings-description">Used for agent time context and new schedule defaults. Displayed dates and times always follow your browser, including when you travel. Existing schedules keep their configured timezone.</p><Field label="Operator timezone"><input value={timezone} disabled={state === 'loading'} onChange={event => setTimezone(event.target.value)} placeholder="America/Chicago" /></Field><button type="button" className="secondary" disabled={state !== 'ready'} onClick={() => setTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone)}>Use browser timezone</button><button type="button" className="primary" disabled={state !== 'ready' || !timezone.trim()} onClick={() => void save()}>{state === 'saving' ? 'Saving…' : 'Save timezone'}</button>{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}</SettingSection>;
}
