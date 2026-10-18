import { useEffect, useState } from 'react';
import { api, jsonMutation } from '../../app/api';
import { SettingSection } from './SettingsPrimitives';

type TelemetryState = {
  settings: { enabled: boolean };
  effective: { enabled: boolean; source: string; restartRequired: boolean };
  runtime?: { enabled: boolean; sdkStarted: boolean };
};
const endpoint = '/api/settings/opentelemetry';

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
    <div className="telemetry-control">
      <div className="telemetry-copy"><label id="telemetry-label" htmlFor="telemetry-enabled">Collect telemetry</label><p id="telemetry-help">Collect Core traces and metrics for diagnostics.</p></div>
      <input id="telemetry-enabled" className="telemetry-switch" type="checkbox" role="switch" aria-labelledby="telemetry-label" aria-describedby="telemetry-help" checked={enabled} disabled={!saved || busy} onChange={event => { setEnabled(event.target.checked); setNotice(''); }} />
    </div>
    {saved && <>
      <p className="settings-help" role="status">{saved.runtime ? `Telemetry is ${saved.runtime.enabled ? 'on' : 'off'}.` : 'Telemetry runtime status is unavailable.'}{enabled !== saved.settings.enabled ? ' Unsaved changes.' : ''}</p>
      {saved.effective.source === 'environment' && <p className="telemetry-guidance">Server override: telemetry is {saved.effective.enabled ? 'enabled' : 'disabled'} by <code>BURROW_OTEL_ENABLED</code>. Saving changes your preference, but the override takes priority. Change or remove that variable and restart Core to use the saved setting.</p>}
      {saved.effective.restartRequired && <p className="telemetry-guidance" role="status">Restart Core to finish applying this setting. Saving does not restart Core.</p>}
    </>}
    <div className="telemetry-actions"><button type="button" className="primary" disabled={!saved || busy || enabled === saved.settings.enabled} onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</button></div>
    {!saved && !error && <p role="status">Loading OpenTelemetry settings…</p>}
    {error && <p role="alert">{error}</p>}
    {!saved && error && <button type="button" className="secondary" onClick={() => setRetry(value => value + 1)}>Retry OpenTelemetry settings</button>}
    {notice && <p role="status">{notice}</p>}
  </SettingSection>;
}
