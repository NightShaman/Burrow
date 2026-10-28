import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { OpenTelemetrySettings } from './OpenTelemetrySettings';

vi.mock('../../app/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../app/api')>(),
  api: vi.fn(),
}));

afterEach(() => { cleanup(); vi.resetAllMocks(); });

const route = '/api/settings/opentelemetry';
type Destination = {
  id: string;
  name: string;
  provider: string;
  enabled: boolean;
  endpoint: string;
  tracesEndpoint: string;
  metricsEndpoint: string;
  protocol: string;
  tracesEnabled: boolean;
  metricsEnabled: boolean;
  metricsTemporality: string;
  connection: Record<string, string>;
  tls: { verify: boolean };
  headersConfigured: boolean;
  credentialsConfigured: boolean;
  credentialFields: string[];
};
type DestinationInput = Omit<Destination, 'headersConfigured' | 'credentialsConfigured' | 'credentialFields'> & {
  headers?: string;
  clearHeaders?: boolean;
  credentials?: Record<string, string>;
  clearCredentials?: boolean;
};
type Update = { enabled: boolean; destinations: DestinationInput[] };
type Source = 'database' | 'environment' | 'default';

const providers = [
  { id: 'custom', label: 'Custom OTLP', traces: true, metrics: true },
  { id: 'openobserve', label: 'OpenObserve', traces: true, metrics: true },
  { id: 'grafana-tempo', label: 'Grafana Tempo', traces: true, metrics: false },
  { id: 'grafana-cloud', label: 'Grafana Cloud', traces: true, metrics: true },
  { id: 'jaeger', label: 'Jaeger', traces: true, metrics: false },
  { id: 'signoz', label: 'SigNoz', traces: true, metrics: true },
  { id: 'uptrace', label: 'Uptrace', traces: true, metrics: true },
  { id: 'elastic', label: 'Elastic', traces: true, metrics: true },
  { id: 'datadog', label: 'Datadog', traces: true, metrics: true },
  { id: 'new-relic', label: 'New Relic', traces: true, metrics: true },
  { id: 'honeycomb', label: 'Honeycomb', traces: true, metrics: true },
  { id: 'splunk', label: 'Splunk', traces: true, metrics: true },
].map(provider => ({
  ...provider,
  description: `${provider.label} OTLP/HTTP preset`,
  protocols: ['http/json', 'http/protobuf'],
  defaultProtocol: 'http/json',
  defaultTemporality: provider.id === 'datadog' ? 'delta' : 'cumulative',
  documentationUrl: 'https://docs.example.test/otlp',
}));

function destination(overrides: Partial<Destination> = {}): Destination {
  return {
    id: 'archive', name: 'Archive collector', provider: 'custom', enabled: true,
    endpoint: 'https://archive.example.test:4318', tracesEndpoint: '', metricsEndpoint: '',
    protocol: 'http/json', tracesEnabled: true, metricsEnabled: true,
    metricsTemporality: 'cumulative', connection: {}, tls: { verify: true },
    headersConfigured: true, credentialsConfigured: false, credentialFields: [],
    ...overrides,
  };
}
const archive = destination();
const tempo = destination({
  id: 'tempo', name: 'Production traces', provider: 'grafana-tempo',
  endpoint: 'https://tempo.example.test', metricsEnabled: false,
  connection: { tenantId: 'tenant-a' }, headersConfigured: false,
  credentialsConfigured: true, credentialFields: ['token'],
});

function response(destinations: Destination[] = [archive, tempo], enabled = false) {
  return {
    ok: true,
    providers,
    settings: { enabled, destinations, endpoint: destinations[0]?.endpoint ?? '', headersConfigured: destinations[0]?.headersConfigured ?? false },
    effective: {
      enabled, destinations, endpoint: destinations[0]?.endpoint ?? '',
      headersConfigured: destinations[0]?.headersConfigured ?? false,
      source: 'database' as Source, endpointSource: 'database' as Source,
      headersSource: 'database' as Source, destinationsSource: 'database' as Source,
      restartRequired: false as const,
    },
    runtime: { enabled, sdkStarted: enabled },
  };
}
type Fixture = ReturnType<typeof response>;

// Model only the public API round trip: write-only fields never come back from GET/PUT.
// Preserved values belong to the same ID AND provider, not merely the same list position.
function acceptUpdate(saved: Fixture, update: Update): Fixture {
  return response(update.destinations.map(input => {
    const previous = saved.settings.destinations.find(item => item.id === input.id && item.provider === input.provider);
    const { headers, clearHeaders, credentials, clearCredentials, ...publicFields } = input;
    const fields = Object.keys(credentials ?? {}).filter(key => Boolean(credentials?.[key]));
    const credentialFields = clearCredentials ? [] : [...new Set([...(previous?.credentialFields ?? []), ...fields])];
    return {
      ...publicFields,
      headersConfigured: clearHeaders ? false : Boolean(headers || previous?.headersConfigured),
      credentialsConfigured: credentialFields.length > 0,
      credentialFields,
    };
  }), update.enabled);
}

async function mount(initial = response()) {
  let saved = initial;
  vi.mocked(api).mockImplementation(async (_path, init) => {
    if (init?.method === 'PUT') {
      saved = acceptUpdate(saved, JSON.parse(init.body as string) as Update);
      // An active environment transport remains separate from the saved list.
      if (initial.effective.destinationsSource === 'environment') saved.effective = initial.effective;
    }
    return saved;
  });
  render(<OpenTelemetrySettings />);
  await screen.findByLabelText('Name');
}
function input(label: string) { return screen.getByLabelText(label) as HTMLInputElement; }
function change(label: string, value: string) { fireEvent.change(screen.getByLabelText(label), { target: { value } }); }
function selectDestination(name: string) { fireEvent.click(screen.getByRole('button', { name: new RegExp(name, 'i') })); }
function selectProvider(provider: string) { change('Provider', provider); }
function putCalls() { return vi.mocked(api).mock.calls.filter(([, init]) => init?.method === 'PUT'); }
function lastUpdate(): Update { return JSON.parse(putCalls().at(-1)![1]!.body as string) as Update; }
async function save() {
  const count = putCalls().length;
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(putCalls()).toHaveLength(count + 1));
  await screen.findByText(/OpenTelemetry settings saved/);
}
function expectNoSecretMutation(item: DestinationInput) {
  for (const key of ['headers', 'credentials', 'clearHeaders', 'clearCredentials']) {
    expect(Object.hasOwn(item, key), key).toBe(false);
  }
}

it('loads multiple saved destinations and edits one without dropping or re-keying its peer', async () => {
  await mount();
  expect(api).toHaveBeenCalledWith(route, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  expect(input('Name').value).toBe(archive.name);
  expect(input('Authentication headers').value).toBe('');
  selectDestination(tempo.name);
  expect(input('Provider').value).toBe('grafana-tempo');
  expect(input('OTLP endpoint').value).toBe(tempo.endpoint);
  expect(input('Bearer token').value).toBe('');
  change('Name', 'Renamed traces');
  await save();
  const update = lastUpdate();
  expect(update.enabled).toBe(false);
  expect(update.destinations).toHaveLength(2);
  expect(update.destinations.map(item => item.id)).toEqual(['archive', 'tempo']);
  expect(update.destinations[0]).toMatchObject({ name: archive.name, endpoint: archive.endpoint, provider: 'custom' });
  expect(update.destinations[1]).toMatchObject({ name: 'Renamed traces', provider: 'grafana-tempo', metricsEnabled: false, connection: { tenantId: 'tenant-a' } });
  update.destinations.forEach(expectNoSecretMutation);
  // New-format PUT must not accidentally trigger the legacy scalar replacement path.
  expect(Object.keys(update).sort()).toEqual(['destinations', 'enabled']);
});

it('adds, reloads, and removes a destination using a stable unique caller-created ID', async () => {
  await mount();
  fireEvent.click(screen.getByRole('button', { name: 'Add destination' }));
  change('Name', 'Local collector');
  selectProvider('custom');
  change('OTLP endpoint', 'http://localhost:4318');
  await save();
  const added = lastUpdate().destinations.find(item => item.name === 'Local collector')!;
  expect(added).toBeDefined();
  expect(added.id).toMatch(/^[A-Za-z0-9_-]{1,80}$/);
  expect(new Set(lastUpdate().destinations.map(item => item.id)).size).toBe(3);
  expect(added).toMatchObject({ provider: 'custom', endpoint: 'http://localhost:4318', tls: { verify: true } });

  cleanup();
  render(<OpenTelemetrySettings />);
  await screen.findByLabelText('Name');
  selectDestination('Local collector');
  expect(input('OTLP endpoint').value).toBe('http://localhost:4318');
  change('Name', 'Local renamed');
  await save();
  expect(lastUpdate().destinations.find(item => item.name === 'Local renamed')?.id).toBe(added.id);
  selectDestination('Local renamed');
  fireEvent.click(screen.getByRole('button', { name: /Remove destination/i }));
  await save();
  expect(lastUpdate().destinations.map(item => item.id)).toEqual(['archive', 'tempo']);
  expect(screen.queryByRole('button', { name: /Local renamed/i })).toBeNull();
});

it('can persist an empty destination list while the master switch is off', async () => {
  await mount(response([archive]));
  fireEvent.click(screen.getByRole('button', { name: /Remove destination/i }));
  await save();
  expect(lastUpdate()).toEqual({ enabled: false, destinations: [] });
});

it('preserves saved credentials and headers by omission on an ordinary edit', async () => {
  await mount(response([destination({ ...tempo, headersConfigured: true })]));
  expect(input('Bearer token').value).toBe('');
  expect(input('Authentication headers').value).toBe('');
  change('OTLP endpoint', 'https://replacement-tempo.example.test');
  await save();
  const item = lastUpdate().destinations[0];
  expect(item).toMatchObject({ id: 'tempo', provider: 'grafana-tempo', endpoint: 'https://replacement-tempo.example.test' });
  expectNoSecretMutation(item);
  expect(input('Bearer token').value).toBe('');
  expect(input('Authentication headers').value).toBe('');
});

it('replaces write-only token and headers only for their destination and blanks drafts after save', async () => {
  await mount();
  selectDestination(tempo.name);
  change('Bearer token', 'replacement-token-for-test');
  change('Authentication headers', 'x-test-key=replacement-header-for-test');
  await save();
  const update = lastUpdate();
  expectNoSecretMutation(update.destinations[0]);
  expect(update.destinations[1]).toMatchObject({
    id: 'tempo', credentials: { token: 'replacement-token-for-test' },
    headers: 'x-test-key=replacement-header-for-test',
  });
  expect(update.destinations[1].clearCredentials).toBeUndefined();
  expect(update.destinations[1].clearHeaders).toBeUndefined();
  expect(input('Bearer token').value).toBe('');
  expect(input('Authentication headers').value).toBe('');
  expect(document.body.textContent).not.toContain('replacement-token-for-test');
  expect(document.body.textContent).not.toContain('replacement-header-for-test');

  change('Name', 'After replacement');
  await save();
  lastUpdate().destinations.forEach(expectNoSecretMutation);
});

it.each([
  ['Remove saved credentials on save', 'clearCredentials', 'credentials'],
  ['Remove saved headers on save', 'clearHeaders', 'headers'],
] as const)('clears only the explicitly selected secret category: %s', async (label, clearKey, replacementKey) => {
  await mount(response([archive, destination({ ...tempo, headersConfigured: true })]));
  selectDestination(tempo.name);
  fireEvent.click(screen.getByLabelText(label));
  await save();
  const [untouched, cleared] = lastUpdate().destinations;
  expectNoSecretMutation(untouched);
  expect(cleared[clearKey]).toBe(true);
  expect(Object.hasOwn(cleared, replacementKey)).toBe(false);
  const otherClear = clearKey === 'clearCredentials' ? 'clearHeaders' : 'clearCredentials';
  const otherReplacement = replacementKey === 'credentials' ? 'headers' : 'credentials';
  expect(Object.hasOwn(cleared, otherClear)).toBe(false);
  expect(Object.hasOwn(cleared, otherReplacement)).toBe(false);
});

it('discards draft secrets on every provider switch, including switching back before save', async () => {
  await mount(response([destination({ ...tempo, headersConfigured: true })]));
  change('Bearer token', 'must-not-survive-provider-switch');
  change('Authentication headers', 'x-secret=must-not-survive-provider-switch');
  selectProvider('custom');
  expect(input('Authentication headers').value).toBe('');
  selectProvider('grafana-tempo');
  expect(input('Bearer token').value).toBe('');
  expect(input('Authentication headers').value).toBe('');
  change('Name', 'Switched back');
  await save();
  expectNoSecretMutation(lastUpdate().destinations[0]);
  expect(JSON.stringify(lastUpdate())).not.toContain('must-not-survive-provider-switch');

  // A different provider must not receive the old provider's saved credential flags or draft values.
  selectProvider('custom');
  await save();
  expect(lastUpdate().destinations[0]).toMatchObject({ id: 'tempo', provider: 'custom' });
  expect(lastUpdate().destinations[0].credentials).toBeUndefined();
  expect(lastUpdate().destinations[0].headers).toBeUndefined();
  selectProvider('grafana-tempo');
  expect(input('Bearer token').value).toBe('');
});

it('keeps destination-specific secret drafts isolated while navigating between destination buttons', async () => {
  await mount();
  change('Authentication headers', 'x-archive=archive-only-draft');
  selectDestination(tempo.name);
  expect(input('Bearer token').value).toBe('');
  expect(input('Authentication headers').value).toBe('');
  change('Bearer token', 'tempo-only-draft');
  selectDestination(archive.name);
  expect(input('Authentication headers').value).toBe('x-archive=archive-only-draft');
  await save();
  expect(lastUpdate().destinations[0].headers).toBe('x-archive=archive-only-draft');
  expect(lastUpdate().destinations[0].credentials).toBeUndefined();
  expect(lastUpdate().destinations[1].credentials).toEqual({ token: 'tempo-only-draft' });
  expect(lastUpdate().destinations[1].headers).toBeUndefined();
});

it('validates endpoint and header syntax before sending an atomic destination update', async () => {
  await mount();
  change('OTLP endpoint', 'ftp://user:password@collector.example.test?secret=yes');
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/HTTP|HTTPS/i);
  expect(putCalls()).toHaveLength(0);
  change('OTLP endpoint', 'https://collector.example.test');
  change('Authentication headers', 'not-a-header-pair');
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/key=value|header/i);
  expect(putCalls()).toHaveLength(0);
  change('Authentication headers', 'x-valid=value');
  await save();
  expect(lastUpdate().destinations).toHaveLength(2);
});

it('retries a failed read without displaying the backend error or inventing saved settings', async () => {
  vi.mocked(api).mockRejectedValueOnce(Error('Authorization=load-secret')).mockResolvedValueOnce(response());
  render(<OpenTelemetrySettings />);
  const retry = await screen.findByRole('button', { name: 'Retry OpenTelemetry settings' });
  expect((screen.getByRole('alert')).textContent).toMatch(/Could not load/);
  expect(document.body.textContent).not.toContain('load-secret');
  expect(putCalls()).toHaveLength(0);
  fireEvent.click(retry);
  await screen.findByLabelText('Name');
  expect(input('Name').value).toBe(archive.name);
  expect(screen.getByRole('button', { name: new RegExp(tempo.name) })).toBeTruthy();
});

it('retains all drafts after a sanitized save failure and retries the same update', async () => {
  await mount();
  change('Name', 'Unsaved archive');
  selectDestination(tempo.name);
  change('Bearer token', 'retry-token-for-test');
  vi.mocked(api).mockRejectedValueOnce(Error('Authorization=backend-secret-do-not-render'));
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(/Could not save/);
  expect(document.body.textContent).not.toContain('backend-secret-do-not-render');
  expect(input('Bearer token').value).toBe('retry-token-for-test');
  const failedUpdate = lastUpdate();
  selectDestination('Unsaved archive');
  expect(input('Name').value).toBe('Unsaved archive');
  await save();
  expect(lastUpdate()).toEqual(failedUpdate);
});

it('shows saved destinations under environment overrides and never saves the environment transport', async () => {
  const initial = response();
  const environment = destination({
    id: 'environment', name: 'Environment collector', endpoint: 'https://environment.example.test',
    headersConfigured: true,
  });
  initial.effective = {
    ...initial.effective, enabled: true, destinations: [environment], endpoint: environment.endpoint,
    source: 'environment', endpointSource: 'environment', headersSource: 'environment', destinationsSource: 'environment',
  };
  initial.runtime = { enabled: true, sdkStarted: true };
  await mount(initial);
  expect(input('OTLP endpoint').value).toBe(archive.endpoint);
  expect(screen.getByText(/Environment overrides currently control/i)).toBeTruthy();
  expect(screen.queryByText(/Restart Core/i)).toBeNull();
  change('Name', 'Saved under override');
  await save();
  expect(lastUpdate().destinations.map(item => item.id)).toEqual(['archive', 'tempo']);
  expect(JSON.stringify(lastUpdate())).not.toContain(environment.endpoint);
  expect(screen.getByText(/Active environment overrides remain in effect/)).toBeTruthy();
  expect(input('Name').value).toBe('Saved under override');
});

it('allows a metrics-only destination with an exact metrics URL and no base endpoint', async () => {
  await mount(response([archive]));
  fireEvent.click(screen.getByLabelText('Traces'));
  change('OTLP endpoint', '');
  change('Exact metrics URL', 'https://metrics.example.test/v1/metrics');
  await save();
  expect(lastUpdate().destinations[0]).toMatchObject({ endpoint: '', tracesEnabled: false, metricsEnabled: true, metricsEndpoint: 'https://metrics.example.test/v1/metrics' });
});

it('restores saved secret presence when switching back to the original provider without restoring draft secrets', async () => {
  await mount(response([destination({ ...tempo, headersConfigured: true })]));
  change('Bearer token', 'temporary-draft');
  selectProvider('custom');
  selectProvider('grafana-tempo');
  expect(input('Bearer token').value).toBe('');
  expect(screen.getByLabelText('Remove saved credentials on save')).toBeTruthy();
  expect(screen.getByLabelText('Remove saved headers on save')).toBeTruthy();
});


it('renders metadata guidance, accurate direct endpoint instructions and credential names', async () => {
  const initial = response([archive, destination({ ...tempo, enabled: false })]);
  initial.providers.find(p => p.id === 'datadog')!.description = 'Datadog preset';
  Object.assign(initial.providers.find(p => p.id === 'datadog')!, { guidance: 'Metadata guidance from API' });
  await mount(initial);
  expect(screen.getByText(/1 effective destination/)).toBeTruthy();
  selectProvider('datadog');
  expect(screen.getByText('Metadata guidance from API')).toBeTruthy();
  expect(screen.getByLabelText('API key')).toBeTruthy();
  expect(screen.getByText(/Site/)).toBeTruthy();
  expect(screen.getByText(/For reference only/)).toBeTruthy();
  expect(screen.getByText(/Required for direct traces/)).toBeTruthy();
  expect(screen.getByText(/Required for direct metrics/)).toBeTruthy();
  selectProvider('splunk');
  expect(screen.getByLabelText('Access token')).toBeTruthy();
  expect(screen.getByText(/v2\/trace\/otlp/)).toBeTruthy();
  selectProvider('uptrace');
  expect(screen.getByLabelText('DSN')).toBeTruthy();
  selectProvider('signoz');
  expect(screen.getByLabelText('Ingestion key')).toBeTruthy();
  selectProvider('new-relic');
  expect(screen.getByLabelText('License key')).toBeTruthy();
  selectProvider('openobserve');
  expect(screen.getByLabelText('Authorization')).toBeTruthy();
});

it.each(['datadog', 'splunk'])('requires exact enabled signal URLs for direct %s and selects the invalid destination', async provider => {
  const direct = destination({ id: 'direct', name: 'Direct destination', provider, connection: { mode: 'direct' }, metricsEnabled: provider === 'datadog' });
  await mount(response([archive, direct]));
  change('Name', 'Changed collector');
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  expect(putCalls()).toHaveLength(0);
  expect(input('Name').value).toBe('Direct destination');
  expect(screen.getByRole('alert').textContent).toMatch(/requires an exact traces/);
  change('Exact traces URL', 'https://traces.example.test/v2/trace/otlp');
  if (provider === 'datadog') {
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(putCalls()).toHaveLength(0);
    expect(screen.getByRole('alert').textContent).toMatch(/exact metrics URL/);
    change('Exact metrics URL', 'https://metrics.example.test/v1/metrics');
  }
  await save();
});

it.each(['datadog', 'splunk'])('allows %s collector base endpoints and disabled direct drafts', async provider => {
  const collector = destination({ id: 'collector', provider, connection: { mode: 'collector' } });
  const disabled = destination({ id: 'disabled', name: 'Disabled direct', provider, enabled: false, connection: { mode: 'direct' } });
  await mount(response([collector, disabled]));
  change('Name', 'Collector updated');
  await save();
  expect(lastUpdate().destinations).toHaveLength(2);
});
