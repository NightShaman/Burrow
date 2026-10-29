import { useEffect, useRef, useState } from 'react';
import { api, jsonMutation } from '../../app/api';
import { browserTabChanged, browserTabTitle } from '../../app/browserTab';
import { isUnsavedChangesModalTarget, useUnsavedChanges } from '../../app/UnsavedChanges';
import { Field, SettingSection } from './SettingsPrimitives';

const suffixLimit = 80;
const validSuffix = (value: unknown): value is string => typeof value === 'string'
  && value === value.trim() && Array.from(value).length <= suffixLimit;

export function BrowserTabSettings() {
  const [suffix, setSuffix] = useState('');
  const [baseline, setBaseline] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [saveFailed, setSaveFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const saving = useRef(false);
  const owner = useRef<object | null>(null);

  useEffect(() => {
    const ticket = {};
    owner.current = ticket;
    const controller = new AbortController();
    saving.current = false;
    setBusy(false); setLoaded(false); setError(''); setNotice(''); setSaveFailed(false);
    void api<{ suffix: string }>('/api/settings/browser-tab', { signal: controller.signal }).then(result => {
      if (owner.current !== ticket) return;
      if (!result || !validSuffix(result.suffix)) throw new Error('Invalid browser tab response.');
      if (owner.current === ticket) { setSuffix(result.suffix); setBaseline(result.suffix); setLoaded(true); }
    }).catch(() => { if (owner.current === ticket) setError('Could not load browser tab settings.'); });
    return () => {
      if (owner.current === ticket) owner.current = null;
      controller.abort();
    };
  }, [retry]);

  const save = async (draft = suffix) => {
    if (!loaded || !owner.current || saving.current) return false;
    const ticket = owner.current;
    const normalized = draft.trim();
    if (Array.from(normalized).length > suffixLimit) return false;
    if (normalized === baseline) {
      setSuffix(baseline); setError(''); setSaveFailed(false);
      return true;
    }
    saving.current = true;
    setBusy(true); setError(''); setNotice(''); setSaveFailed(false);
    try {
      const result = await api<{ suffix: string }>('/api/settings/browser-tab', jsonMutation('PUT', { suffix: normalized }));
      if (owner.current !== ticket) return false;
      // Do not publish a title event or accept malformed response values.
      if (!result || !validSuffix(result.suffix)) throw new Error('Invalid browser tab save response.');
      setSuffix(result.suffix); setBaseline(result.suffix);
      window.dispatchEvent(new CustomEvent(browserTabChanged, { detail: result.suffix }));
      setNotice('Browser tab suffix saved.');
      return true;
    } catch {
      if (owner.current !== ticket) return false;
      setError('Could not save browser tab suffix.'); setSaveFailed(true);
      return false;
    } finally {
      if (owner.current === ticket) { saving.current = false; setBusy(false); }
    }
  };

  const invalid = Array.from(suffix.trim()).length > suffixLimit;
  useUnsavedChanges({
    dirty: loaded && suffix !== baseline,
    busy,
    resumeAfterAutosave: true,
    save,
    discard: () => { setSuffix(baseline); setError(''); setNotice(''); setSaveFailed(false); },
  });

  return <SettingSection title="Browser tab">
    <p className="settings-description">Identify this environment in your browser tabs. Applies to everyone using this Burrow environment; leave empty to keep the default name.</p>
    <Field label="Browser tab suffix"><input value={suffix} placeholder="Dev, Test, or Prod" disabled={!loaded || busy}
      onChange={event => { setSuffix(event.target.value); setError(''); setNotice(''); setSaveFailed(false); }}
      onBlur={event => { if (!isUnsavedChangesModalTarget(event.relatedTarget) && event.currentTarget.value !== baseline) void save(event.currentTarget.value); }} /></Field>
    <p className="settings-help">Preview: <strong>{browserTabTitle(suffix)}</strong></p>
    {invalid && <p role="alert">Use 80 characters or fewer.</p>}
    {!loaded && error && <button type="button" className="secondary" onClick={() => setRetry(value => value + 1)}>Retry browser tab settings</button>}
    {loaded && saveFailed && !invalid && <button type="button" className="secondary" disabled={busy} onClick={() => void save()}>Retry saving browser tab suffix</button>}
    {!loaded && !error && <p role="status">Loading browser tab settings…</p>}
    {busy && <p role="status">Saving browser tab suffix…</p>}
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
  </SettingSection>;
}
