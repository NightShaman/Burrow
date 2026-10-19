import { useEffect, useState } from 'react';
import { api, jsonMutation } from '../../app/api';
import { Field, SettingSection } from './SettingsPrimitives';

type SettingSource = 'environment' | 'database' | 'default';
type SetupMode = 'openobserve' | 'custom';
type OpenTelemetryResponse = {
  ok: boolean;
  settings: { enabled: boolean; endpoint: string; headersConfigured: boolean; streamName?: string };
  effective: {
    enabled: boolean;
    endpoint: string;
    headersConfigured: boolean;
    source: SettingSource;
    endpointSource: SettingSource;
    headersSource: SettingSource;
    restartRequired: false;
  };
  runtime?: { enabled?: boolean; sdkStarted?: boolean; [key: string]: unknown };
};

type OpenTelemetryUpdate = {
  enabled: boolean;
  endpoint: string;
  headers?: string;
  clearHeaders?: boolean;
};

type OpenObserveEndpoint = { serverUrl: string; organization: string };
type BusyAction = 'save' | null;

const route = '/api/settings/opentelemetry';
const openObservePath = /^(.*)\/api\/([^/]+)$/;

function joinLabels(labels: string[]) {
  if (labels.length < 2) return labels[0] ?? '';
  if (labels.length === 2) return labels.join(' and ');
  return `${labels.slice(0, -1).join(', ')}, and ${labels.at(-1)}`;
}

function endpointError(value: string, label = 'collector URL') {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      return `Use an HTTP or HTTPS ${label} without credentials, a query, or a fragment.`;
    }
    return '';
  } catch { return `Enter a valid HTTP or HTTPS ${label}.`; }
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

function parseOpenObserveEndpoint(endpoint: string): OpenObserveEndpoint | null {
  if (!endpoint) return null;
  try {
    const parsed = new URL(endpoint);
    const match = parsed.pathname.replace(/\/+$/, '').match(openObservePath);
    if (!match?.[2]) return null;
    parsed.pathname = match[1] || '/';
    const serverUrl = parsed.toString().replace(/\/$/, '');
    return { serverUrl, organization: decodeURIComponent(match[2]) };
  } catch { return null; }
}

function openObserveEndpoint(serverUrl: string, organization: string) {
  return `${serverUrl.replace(/\/+$/, '')}/api/${encodeURIComponent(organization)}`;
}

function openObserveHeaders(username: string, password: string, stream: string) {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let binary = '';
  bytes.forEach((byte) => { binary += String.fromCharCode(byte); });
  return `Authorization=${encodeURIComponent(`Basic ${btoa(binary)}`)},stream-name=${encodeURIComponent(stream)}`;
}

export function OpenTelemetrySettings() {
  const [saved, setSaved] = useState<OpenTelemetryResponse | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [mode, setMode] = useState<SetupMode>('openobserve');
  const [serverUrl, setServerUrl] = useState('');
  const [organization, setOrganization] = useState('default');
  const [stream, setStream] = useState('default');
  const [savedStream, setSavedStream] = useState('default');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [endpoint, setEndpoint] = useState('');
  const [headers, setHeaders] = useState('');
  const [clearHeaders, setClearHeaders] = useState(false);
  const [busy, setBusy] = useState<BusyAction>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);

  function accept(result: OpenTelemetryResponse) {
    const openObserve = parseOpenObserveEndpoint(result.settings.endpoint);
    const acceptedStream = result.settings.streamName || 'default';
    setSaved(result);
    setEnabled(result.settings.enabled);
    setMode(openObserve ? 'openobserve' : 'custom');
    setServerUrl(openObserve?.serverUrl ?? '');
    setOrganization(openObserve?.organization ?? 'default');
    setStream(acceptedStream);
    setSavedStream(acceptedStream);
    setUsername('');
    setPassword('');
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
      .then((result) => { if (!controller.signal.aborted) accept(result); })
      .catch(() => { if (!controller.signal.aborted) setError('Could not load OpenTelemetry settings.'); });
    return () => controller.abort();
  }, [retry]);

  const parsedSaved = parseOpenObserveEndpoint(saved?.settings.endpoint ?? '');
  const openObserveChanged = mode === 'openobserve' && (
    serverUrl.trim().replace(/\/+$/, '') !== (parsedSaved?.serverUrl ?? '')
    || organization.trim() !== (parsedSaved?.organization ?? 'default')
    || stream.trim() !== savedStream
    || Boolean(username || password)
  );
  const customChanged = mode === 'custom' && (endpoint !== saved?.settings.endpoint || Boolean(headers.trim()));
  const inferredSavedMode: SetupMode = parsedSaved ? 'openobserve' : 'custom';
  const dirty = Boolean(saved) && (
    enabled !== saved?.settings.enabled
    || mode !== inferredSavedMode
    || openObserveChanged
    || customChanged
    || clearHeaders
  );
  const controlsDisabled = !saved || busy !== null;

  function candidate(): OpenTelemetryUpdate | null {
    if (!saved) return null;
    let collectorEndpoint = endpoint.trim();
    let replacementHeaders = headers;
    if (mode === 'openobserve') {
      const cleanServerUrl = serverUrl.trim();
      const cleanOrganization = organization.trim();
      const cleanStream = stream.trim();
      if (enabled && !cleanServerUrl) { setError('Enter your OpenObserve server URL before enabling telemetry.'); return null; }
      const serverValidation = endpointError(cleanServerUrl, 'OpenObserve server URL');
      if (serverValidation) { setError(serverValidation); return null; }
      if (!cleanOrganization) { setError('Enter the OpenObserve organization.'); return null; }
      if (/[/?#]/.test(cleanOrganization)) { setError('Organization cannot contain slashes, a query, or a fragment.'); return null; }
      if (!cleanStream) { setError('Enter the OpenObserve stream.'); return null; }
      if ((username && !password) || (!username && password)) { setError('Enter both the OpenObserve username and password to replace the saved credentials.'); return null; }
      if (!saved.settings.headersConfigured && (!username || !password) && enabled) { setError('Enter your OpenObserve username and password before enabling telemetry.'); return null; }
      if (stream.trim() !== savedStream && saved.settings.headersConfigured && (!username || !password)) { setError('Enter your OpenObserve username and password to change the stream.'); return null; }
      collectorEndpoint = cleanServerUrl ? openObserveEndpoint(cleanServerUrl, cleanOrganization) : '';
      replacementHeaders = username && password ? openObserveHeaders(username, password, cleanStream) : '';
    }

    const environmentEndpointAvailable = saved.effective.endpointSource === 'environment' && Boolean(saved.effective.endpoint.trim());
    if (enabled && !collectorEndpoint && !environmentEndpointAvailable) {
      setError('Enter a collector endpoint before enabling telemetry.');
      return null;
    }
    const endpointValidation = endpointError(collectorEndpoint);
    if (endpointValidation) { setError(endpointValidation); return null; }
    const headerValidation = clearHeaders ? '' : headersError(replacementHeaders.trim());
    if (headerValidation) { setError(headerValidation); return null; }

    return {
      enabled,
      endpoint: collectorEndpoint,
      ...(clearHeaders
        ? { clearHeaders: true }
        : replacementHeaders.trim()
          ? { headers: replacementHeaders }
          : {}),
    };
  }

  async function save() {
    if (!saved) return;
    setError('');
    setNotice('');

    const update = candidate();
    if (!update) return;

    setBusy('save');
    try {
      const result = await api<OpenTelemetryResponse>(route, jsonMutation('PUT', update));
      accept(result);
      const overridden = result.effective.source === 'environment' || result.effective.endpointSource === 'environment' || result.effective.headersSource === 'environment';
      setNotice(overridden ? 'OpenTelemetry settings saved. Active environment overrides remain in effect.' : 'OpenTelemetry settings saved and applied live.');
    } catch {
      setError('Could not save OpenTelemetry settings. Your changes have not been confirmed. Try again.');
    } finally {
      setBusy(null);
    }
  }

  const overriddenSettings = saved ? [
    saved.effective.source === 'environment' ? 'telemetry preference' : '',
    saved.effective.endpointSource === 'environment' ? 'collector endpoint' : '',
    saved.effective.headersSource === 'environment' ? 'collector credentials' : '',
  ].filter(Boolean) : [];

  return <SettingSection title="OpenTelemetry">
    <p className="settings-description">Send diagnostic traces and metrics to OpenObserve or another OTLP/HTTP collector. Saved changes apply live.</p>

    <fieldset className="telemetry-fields" disabled={controlsDisabled}>
      <legend>Telemetry export</legend>
      <div className="telemetry-control">
        <div className="telemetry-copy">
          <label id="telemetry-label" htmlFor="telemetry-enabled">Send telemetry</label>
          <p id="telemetry-help">Export Burrow traces and metrics to your collector.</p>
        </div>
        <input id="telemetry-enabled" className="telemetry-switch" type="checkbox" role="switch" aria-labelledby="telemetry-label" aria-describedby="telemetry-help" checked={enabled} onChange={(event) => { setEnabled(event.target.checked); markEdited(); }} />
      </div>

      <fieldset className="telemetry-setup-picker">
        <legend>Setup type</legend>
        <label><input type="radio" name="telemetry-mode" value="openobserve" checked={mode === 'openobserve'} onChange={() => { setMode('openobserve'); setClearHeaders(false); markEdited(); }} /><span><strong>OpenObserve</strong><small>Recommended setup with separate sign-in fields</small></span></label>
        <label><input type="radio" name="telemetry-mode" value="custom" checked={mode === 'custom'} onChange={() => { setMode('custom'); setClearHeaders(false); markEdited(); }} /><span><strong>Custom OTLP</strong><small>Any OTLP/HTTP-compatible collector</small></span></label>
      </fieldset>

      {mode === 'openobserve' ? <div className="telemetry-mode-fields">
        <Field label="OpenObserve server URL">
          <input aria-label="OpenObserve server URL" type="url" value={serverUrl} maxLength={2048} placeholder="https://openobserve.example.com" onChange={(event) => { setServerUrl(event.target.value); markEdited(); }} />
          <small className="telemetry-field-help">The address you use to open OpenObserve. Burrow adds the OTLP path for you.</small>
        </Field>
        <Field label="Organization">
          <input aria-label="Organization" value={organization} maxLength={256} placeholder="default" autoCapitalize="none" spellCheck={false} onChange={(event) => { setOrganization(event.target.value); markEdited(); }} />
        </Field>
        <Field label="Stream">
          <input aria-label="Stream" value={stream} maxLength={256} placeholder="default" autoCapitalize="none" spellCheck={false} onChange={(event) => { setStream(event.target.value); markEdited(); }} />
        </Field>
        <div className="field-pair telemetry-credentials">
          <Field label="Username or email">
            <input aria-label="OpenObserve username or email" value={username} maxLength={512} autoComplete="username" spellCheck={false} placeholder={saved?.settings.headersConfigured ? 'Leave blank to keep saved sign-in' : 'you@example.com'} onChange={(event) => { setUsername(event.target.value); markEdited(); }} />
          </Field>
          <Field label="Password">
            <input aria-label="OpenObserve password" type="password" value={password} maxLength={4096} autoComplete="new-password" placeholder={saved?.settings.headersConfigured ? 'Leave blank to keep saved sign-in' : 'Enter password'} onChange={(event) => { setPassword(event.target.value); markEdited(); }} />
          </Field>
        </div>
        <small className="telemetry-secret-help">{saved?.settings.headersConfigured ? 'A saved sign-in is configured. Enter both fields only to replace it.' : 'Credentials are sent only when you save and are never shown again.'}</small>
      </div> : <div className="telemetry-mode-fields">
        <Field label="OTLP endpoint">
          <input aria-label="OTLP endpoint" type="url" value={endpoint} maxLength={2048} placeholder="https://collector.example.com:4318" onChange={(event) => { setEndpoint(event.target.value); markEdited(); }} />
          <small className="telemetry-field-help">Base OTLP/HTTP URL. Burrow sends to <code>/v1/traces</code> and <code>/v1/metrics</code>.</small>
        </Field>
        <Field label="Authentication headers">
          <input aria-label="Authentication headers" type="password" autoComplete="new-password" spellCheck={false} value={headers} disabled={controlsDisabled || clearHeaders} maxLength={8192} placeholder={saved?.settings.headersConfigured ? 'Leave blank to keep saved headers' : 'Optional encoded key=value pairs'} onChange={(event) => { setHeaders(event.target.value); markEdited(); }} />
          <small className="telemetry-field-help">Advanced: comma-separated, percent-encoded <code>key=value</code> pairs. Secret values are never displayed.</small>
        </Field>
      </div>}

      {saved?.settings.headersConfigured && <label className="telemetry-clear">
        <input type="checkbox" aria-label="Remove saved credentials on save" checked={clearHeaders} onChange={(event) => { setClearHeaders(event.target.checked); if (event.target.checked) { setHeaders(''); setUsername(''); setPassword(''); } markEdited(); }} />
        <span><strong>Remove saved credentials on save</strong><small>This does not reveal the current secret.</small></span>
      </label>}
    </fieldset>

    {saved && <>
      <div className="telemetry-effective" role="status">
        <strong>Effective now</strong>
        <p>Telemetry is {saved.effective.enabled ? 'on' : 'off'}.{' '}{saved.effective.endpoint ? <>Destination: <code>{saved.effective.endpoint}</code>.</> : 'No destination is active.'}{' '}Credentials are {saved.effective.headersConfigured ? 'configured' : 'not configured'}.</p>
        <small>{typeof saved.runtime?.enabled === 'boolean' ? `Telemetry runtime is ${saved.runtime.enabled ? 'on' : 'off'}.` : 'Telemetry runtime status is unavailable.'}{dirty ? ' Unsaved changes are not effective yet.' : ''}</small>
      </div>
      {overriddenSettings.length > 0 && <p className="telemetry-guidance">Environment overrides currently control the {joinLabels(overriddenSettings)}. The form shows saved values; saving does not replace active overrides.</p>}
    </>}

    <div className="telemetry-actions">
      <button type="button" className="primary" disabled={controlsDisabled || !dirty} onClick={() => void save()}>{busy === 'save' ? 'Saving…' : 'Save changes'}</button>
    </div>
    {!saved && !error && <p className="settings-help" role="status">Loading OpenTelemetry settings…</p>}
    {error && <p className="settings-request-error" role="alert">{error}</p>}
    {!saved && error && <button type="button" className="secondary" onClick={() => setRetry((value) => value + 1)}>Retry OpenTelemetry settings</button>}
    {notice && <p className="telemetry-notice" role="status">{notice}</p>}
  </SettingSection>;
}
