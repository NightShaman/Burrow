import { useEffect, useState } from 'react';
import { api, jsonMutation } from '../../app/api';
import { browserTabChanged, browserTabTitle } from '../../app/browserTab';
import { Field, SettingSection } from './SettingsPrimitives';

export function BrowserTabSettings() {
  const [suffix, setSuffix] = useState('');
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false); setError('');
    void api<{suffix:string}>('/api/settings/browser-tab', {signal: controller.signal}).then(result => {
      if (!controller.signal.aborted) { setSuffix(result.suffix); setLoaded(true); }
    }).catch(() => { if (!controller.signal.aborted) setError('Could not load browser tab settings.'); });
    return () => controller.abort();
  }, [retry]);
  const save = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api<{suffix:string}>('/api/settings/browser-tab', jsonMutation('PUT', {suffix: suffix.trim()}));
      setSuffix(result.suffix);
      window.dispatchEvent(new CustomEvent(browserTabChanged, {detail: result.suffix}));
      setNotice('Browser tab suffix saved.');
    } catch { setError('Could not save browser tab suffix.'); }
    finally { setBusy(false); }
  };
  return <SettingSection title="Browser tab"><p className="settings-description">Identify this environment in your browser tabs. Applies to everyone using this Burrow environment; leave empty to keep the default name.</p><Field label="Browser tab suffix"><input value={suffix} placeholder="Dev, Test, or Prod" disabled={!loaded || busy} onChange={event => { setSuffix(event.target.value); setNotice(''); }} /></Field><p className="settings-help">Preview: <strong>{browserTabTitle(suffix)}</strong></p>{Array.from(suffix.trim()).length > 80 && <p role="alert">Use 80 characters or fewer.</p>}<button type="button" className="primary" disabled={!loaded || busy || Array.from(suffix.trim()).length > 80} onClick={() => void save()}>{busy ? 'Saving…' : 'Save tab suffix'}</button>{!loaded && error && <button type="button" className="secondary" onClick={() => setRetry(value => value + 1)}>Retry browser tab settings</button>}{!loaded && !error && <p role="status">Loading browser tab settings…</p>}{error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}</SettingSection>;
}
