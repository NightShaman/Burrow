import { useEffect, useState } from 'react';
import { api, jsonMutation } from '../../app/api';
import { SettingSection } from './SettingsPrimitives';

type TelemetryState = {
  settings: { enabled: boolean };
  effective: { enabled: boolean; source: string; restartRequired: boolean };
  runtime?: { enabled: boolean; sdkStarted: boolean };
};
const endpoint = '/api/settings/opentelemetry';
const enabledText = (enabled: boolean) => enabled ? 'Enabled' : 'Disabled';

export function OpenTelemetrySettings() {
  const [saved, setSaved] = useState<TelemetryState | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void api<TelemetryState>(endpoint, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) { setSaved(result); setEnabled(result.settings.enabled); }
    }).catch(() => { if (!controller.signal.aborted) setError('Could not load OpenTelemetry settings.'); });
    return () => controller.abort();
  }, [retry]);
  async function save() {
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api<TelemetryState>(endpoint, jsonMutation('PUT', { enabled }));
      setSaved(result); setEnabled(result.settings.enabled); setNotice('OpenTelemetry setting saved.');
    } catch { setError('Could not save OpenTelemetry settings. Your saved setting has not been confirmed.'); }
    finally { setBusy(false); }
  }
  return <SettingSection title="OpenTelemetry">
    <p className="settings-description">Control Core telemetry collection. Export destinations are configured on the server.</p>
    <label className="field"><span>Enable OpenTelemetry</span><input type="checkbox" checked={enabled} disabled={!saved || busy} onChange={event => { setEnabled(event.target.checked); setNotice(''); }} /></label>
    {saved && <>
      <dl className="settings-help">
        <dt>Saved setting</dt><dd>{enabledText(saved.settings.enabled)}</dd>
        <dt>Effective setting</dt><dd>{enabledText(saved.effective.enabled)}</dd>
        <dt>Source</dt><dd>{({ environment: 'Environment override', database: 'Saved setting', default: 'Default' } as Record<string, string>)[saved.effective.source] ?? saved.effective.source}</dd>
        <dt>Runtime</dt><dd>{saved.runtime ? `${enabledText(saved.runtime.enabled)} · SDK ${saved.runtime.sdkStarted ? 'started' : 'not started'}` : 'Unavailable'}</dd>
        <dt>Restart required</dt><dd>{saved.effective.restartRequired ? 'Yes' : 'No'}</dd>
      </dl>
      {saved.effective.restartRequired && <p role="status">Restart Core to finish applying this setting. Saving does not restart Core.</p>}
    </>}
    <p className="settings-help"><code>BURROW_OTEL_ENABLED</code> overrides the saved setting when set to true or false. Change or remove that server environment variable and restart Core to change the override. Follow the reported restart requirement after saving.</p>
    <button type="button" className="primary" disabled={!saved || busy || enabled === saved.settings.enabled} onClick={() => void save()}>{busy ? 'Saving…' : 'Save telemetry setting'}</button>
    {!saved && !error && <p role="status">Loading OpenTelemetry settings…</p>}
    {error && <p role="alert">{error}</p>}
    {!saved && error && <button type="button" className="secondary" onClick={() => setRetry(value => value + 1)}>Retry OpenTelemetry settings</button>}
    {notice && <p role="status">{notice}</p>}
  </SettingSection>;
}
