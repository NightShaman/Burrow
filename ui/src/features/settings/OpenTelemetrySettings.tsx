import { useEffect, useState } from 'react';
import { api, jsonMutation } from '../../app/api';
import { Field, SettingSection } from './SettingsPrimitives';

type SettingSource = 'environment' | 'database' | 'default';
type OpenTelemetryResponse = {
  ok: boolean;
  settings: {
    enabled: boolean;
    endpoint: string;
    headersConfigured: boolean;
  };
  effective: {
    enabled: boolean;
    endpoint: string;
    headersConfigured: boolean;
    source: SettingSource;
    endpointSource: SettingSource;
    headersSource: SettingSource;
    restartRequired: false;
  };
  runtime?: {
    enabled?: boolean;
    sdkStarted?: boolean;
    [key: string]: unknown;
  };
};

type OpenTelemetryUpdate = {
  enabled: boolean;
  endpoint: string;
  headers?: string;
  clearHeaders?: boolean;
};

const route = '/api/settings/opentelemetry';

function joinLabels(labels: string[]) {
  if (labels.length < 2) return labels[0] ?? '';
  if (labels.length === 2) return labels.join(' and ');
  return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`;
}

function endpointError(value: string) {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return 'Use an HTTP or HTTPS collector URL without credentials, a query, or a fragment.';
    return '';
  } catch { return 'Enter a valid HTTP or HTTPS collector URL.'; }
}

function headersError(value: string) {
  if (!value) return '';
  if (/\r|\n/.test(value)) return 'Enter headers as a comma-separated key=value list on one line.';
  try {
    const valid = value.split(',').map(entry => entry.trim()).filter(Boolean).every((entry) => {
      const separator = entry.indexOf('=');
      if (separator < 1 || !entry.slice(separator + 1).trim()) return false;
      decodeURIComponent(entry.slice(0, separator).trim());
      decodeURIComponent(entry.slice(separator + 1).trim());
      return true;
    });
    return valid ? '' : 'Enter headers as a comma-separated key=value list.';
  } catch { return 'Header names and values must use valid percent encoding.'; }
}

export function OpenTelemetrySettings() {
  const [saved, setSaved] = useState<OpenTelemetryResponse | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [endpoint, setEndpoint] = useState('');
  const [headers, setHeaders] = useState('');
  const [clearHeaders, setClearHeaders] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);

  function accept(result: OpenTelemetryResponse) {
    setSaved(result);
    setEnabled(result.settings.enabled);
    setEndpoint(result.settings.endpoint);
    setHeaders('');
    setClearHeaders(false);
  }

  function markEdited() {
    setError('');
    setNotice('');
  }

  useEffect(() => {
    const controller = new AbortController();
    setError('');
    void api<OpenTelemetryResponse>(route, { signal: controller.signal })
      .then((result) => {
        if (!controller.signal.aborted) accept(result);
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('Could not load OpenTelemetry settings.');
      });
    return () => controller.abort();
  }, [retry]);

  const dirty = Boolean(saved) && (
    enabled !== saved?.settings.enabled
    || endpoint !== saved?.settings.endpoint
    || Boolean(headers.trim())
    || clearHeaders
  );
  const controlsDisabled = !saved || busy;

  async function save() {
    if (!saved) return;
    setError('');
    setNotice('');

    const collectorEndpoint = endpoint.trim();
    const environmentEndpointAvailable = saved.effective.endpointSource === 'environment' && Boolean(saved.effective.endpoint.trim());
    if (enabled && !collectorEndpoint && !environmentEndpointAvailable) {
      setError('Enter a collector endpoint before enabling telemetry.');
      return;
    }
    const endpointValidation = endpointError(collectorEndpoint);
    if (endpointValidation) { setError(endpointValidation); return; }
    const headerValidation = clearHeaders ? '' : headersError(headers.trim());
    if (headerValidation) { setError(headerValidation); return; }

    const update: OpenTelemetryUpdate = {
      enabled,
      endpoint: collectorEndpoint,
      ...(clearHeaders
        ? { clearHeaders: true }
        : headers.trim()
          ? { headers }
          : {}),
    };

    setBusy(true);
    try {
      const result = await api<OpenTelemetryResponse>(route, jsonMutation('PUT', update));
      accept(result);
      const overridden = result.effective.source === 'environment' || result.effective.endpointSource === 'environment' || result.effective.headersSource === 'environment';
      setNotice(overridden ? 'OpenTelemetry settings saved. Active environment overrides remain in effect.' : 'OpenTelemetry settings saved and applied live.');
    } catch {
      setError('Could not save OpenTelemetry settings. Your changes have not been confirmed. Try again.');
    } finally {
      setBusy(false);
    }
  }

  const overriddenSettings = saved ? [
    saved.effective.source === 'environment' ? 'telemetry preference' : '',
    saved.effective.endpointSource === 'environment' ? 'collector endpoint' : '',
    saved.effective.headersSource === 'environment' ? 'collector headers' : '',
  ].filter(Boolean) : [];

  return <SettingSection title="OpenTelemetry">
    <p className="settings-description">Send diagnostic traces and metrics to an OTLP collector. Saved changes apply live—Core does not need a restart.</p>

    <fieldset className="telemetry-fields" disabled={controlsDisabled}>
      <legend>Saved configuration</legend>
      <div className="telemetry-control">
        <div className="telemetry-copy">
          <label id="telemetry-label" htmlFor="telemetry-enabled">Collect telemetry</label>
          <p id="telemetry-help">Enable export of traces and metrics.</p>
        </div>
        <input
          id="telemetry-enabled"
          className="telemetry-switch"
          type="checkbox"
          role="switch"
          aria-labelledby="telemetry-label"
          aria-describedby="telemetry-help"
          checked={enabled}
          onChange={(event) => {
            setEnabled(event.target.checked);
            markEdited();
          }}
        />
      </div>

      <Field label="Collector endpoint">
        <input
          aria-label="Collector endpoint"
          type="url"
          value={endpoint}
          maxLength={2048}
          placeholder="https://collector.example.com:4318"
          onChange={(event) => {
            setEndpoint(event.target.value);
            markEdited();
          }}
        />
        <small className="telemetry-field-help">The OTLP collector base URL. A destination is required when telemetry is enabled.</small>
      </Field>

      <Field label="Collector headers">
        <input
          aria-label="Collector headers"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          value={headers}
          disabled={controlsDisabled || clearHeaders}
          maxLength={8192}
          placeholder={saved?.settings.headersConfigured ? 'Leave blank to keep saved headers' : 'Optional replacement headers'}
          onChange={(event) => {
            setHeaders(event.target.value);
            markEdited();
          }}
        />
        <small className="telemetry-field-help">{saved?.settings.headersConfigured ? 'Saved headers are configured. ' : 'No saved headers are configured. '}Enter comma-separated key=value pairs only to replace them. Percent-encode spaces and reserved characters. Secret values are never displayed.</small>
      </Field>

      {saved?.settings.headersConfigured && <label className="telemetry-clear">
        <input
          type="checkbox"
          aria-label="Remove saved headers on save"
          checked={clearHeaders}
          onChange={(event) => {
            setClearHeaders(event.target.checked);
            if (event.target.checked) setHeaders('');
            markEdited();
          }}
        />
        <span><strong>Remove saved headers on save</strong><small>This does not reveal the current secret.</small></span>
      </label>}
    </fieldset>

    {saved && <>
      <div className="telemetry-effective" role="status">
        <strong>Effective now</strong>
        <p>
          Telemetry is {saved.effective.enabled ? 'on' : 'off'}.
          {' '}{saved.effective.endpoint ? <>Collector: <code>{saved.effective.endpoint}</code>.</> : 'No collector endpoint is active.'}
          {' '}Headers are {saved.effective.headersConfigured ? 'configured' : 'not configured'}.
        </p>
        <small>{typeof saved.runtime?.enabled === 'boolean' ? `Telemetry runtime is ${saved.runtime.enabled ? 'on' : 'off'}.` : 'Telemetry runtime status is unavailable.'}{dirty ? ' Unsaved changes are not effective yet.' : ''}</small>
      </div>
      {overriddenSettings.length > 0 && <p className="telemetry-guidance">Environment overrides currently control the {joinLabels(overriddenSettings)}. The fields above show saved values; saving updates those values without replacing the active overrides.</p>}
    </>}

    <div className="telemetry-actions">
      <button type="button" className="primary" disabled={controlsDisabled || !dirty} onClick={() => void save()}>{busy ? 'Saving…' : 'Save changes'}</button>
    </div>
    {!saved && !error && <p className="settings-help" role="status">Loading OpenTelemetry settings…</p>}
    {error && <p className="settings-request-error" role="alert">{error}</p>}
    {!saved && error && <button type="button" className="secondary" onClick={() => setRetry((value) => value + 1)}>Retry OpenTelemetry settings</button>}
    {notice && <p className="telemetry-notice" role="status">{notice}</p>}
  </SettingSection>;
}
