import { useEffect, useRef, useState } from 'react';
import { api } from '../../app/api';
import { isUnsavedChangesModalTarget, useUnsavedChanges } from '../../app/UnsavedChanges';
import { Field, SettingSection } from './SettingsPrimitives';

function validTimezone(timezone: unknown): timezone is string {
  if (typeof timezone !== 'string' || !timezone || timezone !== timezone.trim() || /^[+-]/.test(timezone)) return false;
  try { new Intl.DateTimeFormat(undefined, { timeZone: timezone }); return true; }
  catch { return false; }
}

export function OperatorTimezone() {
  const [timezone, setTimezone] = useState('');
  const [baseline, setBaseline] = useState('');
  const [state, setState] = useState<'loading' | 'ready' | 'saving' | 'error'>('loading');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saveFailed, setSaveFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const owner = useRef<object | null>(null);
  const saving = useRef(false);
  const browserTimezoneButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const ticket = {}; owner.current = ticket;
    const controller = new AbortController();
    saving.current = false;
    setState('loading'); setError(''); setNotice(''); setSaveFailed(false);
    api<{ timezone: string }>('/api/settings/timezone', { signal: controller.signal }).then(result => {
      if (owner.current !== ticket) return;
      if (!result || !validTimezone(result.timezone)) throw new Error('Invalid timezone response.');
      setTimezone(result.timezone); setBaseline(result.timezone); setState('ready');
    }).catch(() => { if (owner.current === ticket) { setError('Could not load operator timezone.'); setState('error'); } });
    return () => { owner.current = null; controller.abort(); };
  }, [retry]);

  const save = async (draft = timezone) => {
    if (state !== 'ready' || !owner.current || saving.current) return false;
    const normalized = draft.trim();
    if (!normalized || !validTimezone(normalized)) {
      setError('Enter a valid IANA timezone such as America/Chicago.'); setNotice(''); setSaveFailed(false);
      return false;
    }
    if (normalized === baseline) {
      setTimezone(baseline); setError(''); setSaveFailed(false);
      return true;
    }
    const ticket = owner.current;
    saving.current = true;
    setState('saving'); setError(''); setNotice(''); setSaveFailed(false);
    try {
      const result = await api<{ ok: boolean; timezone: string }>('/api/settings/timezone', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ timezone: normalized }) });
      if (owner.current === ticket) {
        // Only a validated server acknowledgement may replace the draft/baseline.
        if (!result || result.ok !== true || !validTimezone(result.timezone)) throw new Error('Invalid timezone save response.');
        setTimezone(result.timezone); setBaseline(result.timezone); setNotice('Operator timezone saved.');
        return true;
      }
    } catch {
      if (owner.current === ticket) { setError('Could not save operator timezone.'); setSaveFailed(true); }
    } finally {
      if (owner.current === ticket) { saving.current = false; setState('ready'); }
    }
    return false;
  };

  const useBrowserTimezone = () => {
    const browserTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    setTimezone(browserTimezone); setError(''); setNotice(''); setSaveFailed(false);
    void save(browserTimezone);
  };
  const normalized = timezone.trim();
  const invalid = state === 'ready' && timezone !== baseline && (!normalized || !validTimezone(normalized));
  useUnsavedChanges({
    dirty: (state === 'ready' || state === 'saving') && timezone !== baseline,
    busy: state === 'saving',
    resumeAfterAutosave: true,
    save,
    discard: () => { setTimezone(baseline); setError(''); setNotice(''); setSaveFailed(false); },
  });

  return <SettingSection title="Operator timezone">
    <Field label="Operator timezone"><input value={timezone} disabled={state !== 'ready'} placeholder="America/Chicago"
      onChange={event => { setTimezone(event.target.value); setError(''); setNotice(''); setSaveFailed(false); }}
      onBlur={event => {
        // Keyboard/touch focus can reach this action without mouseDown. Its
        // activation owns the selected value, not the competing text draft.
        if (event.relatedTarget === browserTimezoneButton.current || isUnsavedChangesModalTarget(event.relatedTarget)) return;
        if (event.currentTarget.value !== baseline) void save(event.currentTarget.value);
      }} /></Field>
    <button ref={browserTimezoneButton} type="button" className="secondary" disabled={state !== 'ready'} onMouseDown={event => event.preventDefault()} onClick={useBrowserTimezone}>Use browser timezone</button>
    {state === 'error' && <button type="button" onClick={() => setRetry(value => value + 1)}>Retry operator timezone</button>}
    {state === 'ready' && saveFailed && !invalid && <button type="button" className="secondary" onClick={() => void save()}>Retry saving operator timezone</button>}
    {state === 'loading' && <p role="status">Loading operator timezone…</p>}
    {state === 'saving' && <p role="status">Saving operator timezone…</p>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </SettingSection>;
}
