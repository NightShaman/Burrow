import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { OpenTelemetrySettings } from './OpenTelemetrySettings';

vi.mock('../../app/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../app/api')>(),
  api: vi.fn(),
}));

afterEach(() => { cleanup(); vi.resetAllMocks(); });

type Fixture = {
  ok: boolean;
  settings: { enabled: boolean; endpoint: string; headersConfigured: boolean; streamName?: string };
  effective: {
    enabled: boolean;
    endpoint: string;
    headersConfigured: boolean;
    source: 'environment' | 'database' | 'default';
    endpointSource: 'environment' | 'database' | 'default';
    headersSource: 'environment' | 'database' | 'default';
    restartRequired: false;
  };
  runtime?: { enabled: boolean; sdkStarted: boolean };
};

const state: Fixture = {
  ok: true,
  settings: { enabled: false, endpoint: 'https://collector.example.com:4318', headersConfigured: true },
  effective: {
    enabled: false,
    endpoint: 'https://collector.example.com:4318',
    headersConfigured: true,
    source: 'database' as const,
    endpointSource: 'database' as const,
    headersSource: 'database' as const,
    restartRequired: false as const,
  },
  runtime: { enabled: false, sdkStarted: false },
};

async function mount(response: Fixture = state) {
  vi.mocked(api).mockResolvedValue(response);
  render(<OpenTelemetrySettings />);
  await screen.findByText(/Telemetry runtime (?:is off|status is unavailable)/);
}

function save() { fireEvent.click(screen.getByRole('button', { name: 'Save changes' })); }
function lastRequestBody() { return JSON.parse(vi.mocked(api).mock.calls.at(-1)![1]!.body as string); }

it('keeps generic collectors in the custom path and preserves protected headers when omitted', async () => {
  await mount();
  expect((screen.getByRole('radio', { name: /Custom OTLP/ }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('OTLP endpoint') as HTMLInputElement).value).toBe(state.settings.endpoint);
  expect((screen.getByLabelText('Authentication headers') as HTMLInputElement).value).toBe('');
  fireEvent.click(screen.getByRole('switch'));
  save();
  await screen.findByText('OpenTelemetry settings saved and applied live.');
  expect(lastRequestBody()).toEqual({ enabled: true, endpoint: state.settings.endpoint });
});

it('presents OpenObserve as normal fields and converts them to the existing secure API contract', async () => {
  const openObserve = {
    ...state,
    settings: { enabled: false, endpoint: '', headersConfigured: false },
    effective: { ...state.effective, endpoint: '', headersConfigured: false },
  };
  await mount(openObserve);
  fireEvent.click(screen.getByRole('radio', { name: /OpenObserve/ }));
  fireEvent.change(screen.getByLabelText('OpenObserve server URL'), { target: { value: 'https://observe.example.com/' } });
  fireEvent.change(screen.getByLabelText('Organization'), { target: { value: 'goblin kingdom' } });
  fireEvent.change(screen.getByLabelText('Stream'), { target: { value: 'goblin logs' } });
  fireEvent.change(screen.getByLabelText('OpenObserve username or email'), { target: { value: 'rob@example.com' } });
  fireEvent.change(screen.getByLabelText('OpenObserve password'), { target: { value: 'swordfish' } });
  fireEvent.click(screen.getByRole('switch'));
  save();
  await screen.findByText('OpenTelemetry settings saved and applied live.');
  const body = lastRequestBody();
  expect(body.enabled).toBe(true);
  expect(body.endpoint).toBe('https://observe.example.com/api/goblin%20kingdom');
  expect(body.headers).toBe(`Authorization=${encodeURIComponent(`Basic ${btoa('rob@example.com:swordfish')}`)},stream-name=goblin%20logs`);
  expect(screen.queryByLabelText('OpenObserve username or email')).toBeNull();
  expect(screen.queryByLabelText('OpenObserve password')).toBeNull();
  expect(document.body.textContent).not.toContain('swordfish');
});

it('reloads a saved non-default OpenObserve stream without attempting to reveal credentials', async () => {
  await mount({
    ...state,
    settings: { ...state.settings, endpoint: 'https://observe.example.com/api/default', streamName: 'burrow-traces' },
    effective: { ...state.effective, endpoint: 'https://observe.example.com/api/default' },
  });
  expect((screen.getByRole('radio', { name: /OpenObserve/ }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByLabelText('OpenObserve server URL') as HTMLInputElement).value).toBe('https://observe.example.com');
  expect((screen.getByLabelText('Organization') as HTMLInputElement).value).toBe('default');
  expect((screen.getByLabelText('Stream') as HTMLInputElement).value).toBe('burrow-traces');
  expect((screen.getByLabelText('OpenObserve password') as HTMLInputElement).value).toBe('');
  expect(screen.getByText(/saved sign-in is configured/i)).toBeTruthy();
});

it('requires complete OpenObserve credentials and validates the friendly fields before PUT', async () => {
  await mount({
    ...state,
    settings: { enabled: false, endpoint: '', headersConfigured: false },
    effective: { ...state.effective, endpoint: '', headersConfigured: false },
  });
  fireEvent.click(screen.getByRole('radio', { name: /OpenObserve/ }));
  fireEvent.change(screen.getByLabelText('OpenObserve server URL'), { target: { value: 'https://observe.example.com' } });
  fireEvent.change(screen.getByLabelText('Organization'), { target: { value: 'bad/org' } });
  save();
  expect((await screen.findByRole('alert')).textContent).toContain('Organization cannot contain');
  expect(api).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByLabelText('Organization'), { target: { value: 'default' } });
  fireEvent.change(screen.getByLabelText('OpenObserve username or email'), { target: { value: 'rob@example.com' } });
  save();
  expect((await screen.findByRole('alert')).textContent).toContain('both the OpenObserve username and password');
  expect(api).toHaveBeenCalledTimes(1);
});

it('validates advanced endpoint and header syntax before PUT', async () => {
  await mount();
  fireEvent.change(screen.getByLabelText('OTLP endpoint'), { target: { value: 'ftp://user:pass@example.test?bad=yes' } });
  save();
  expect((await screen.findByRole('alert')).textContent).toContain('HTTP or HTTPS collector URL');
  fireEvent.change(screen.getByLabelText('OTLP endpoint'), { target: { value: 'https://collector.example' } });
  fireEvent.change(screen.getByLabelText('Authentication headers'), { target: { value: 'not-a-pair' } });
  save();
  expect((await screen.findByRole('alert')).textContent).toContain('comma-separated key=value');
  expect(api).toHaveBeenCalledTimes(1);
});

it('clears saved credentials explicitly without sending a replacement', async () => {
  await mount();
  fireEvent.change(screen.getByLabelText('Authentication headers'), { target: { value: 'x-api-key=secret' } });
  fireEvent.click(screen.getByLabelText('Remove saved credentials on save'));
  save();
  await screen.findByText('OpenTelemetry settings saved and applied live.');
  expect(lastRequestBody()).toEqual({ enabled: false, endpoint: state.settings.endpoint, clearHeaders: true });
});

it('summarizes environment overrides without restart or manual-edit guidance', async () => {
  await mount({
    ...state,
    runtime: undefined,
    effective: { ...state.effective, enabled: true, endpoint: 'https://environment-collector.example.com', source: 'environment', endpointSource: 'environment', headersSource: 'environment' },
  });
  expect(screen.getByText(/telemetry preference, collector endpoint, and collector credentials/)).toBeTruthy();
  expect(screen.queryByText(/Restart Core/)).toBeNull();
  fireEvent.change(screen.getByLabelText('OTLP endpoint'), { target: { value: 'https://saved-change.example' } });
  save();
  await screen.findByText('OpenTelemetry settings saved. Active environment overrides remain in effect.');
});

it('retries load errors and keeps drafts after sanitized save errors', async () => {
  vi.mocked(api).mockRejectedValueOnce(Error('offline')).mockResolvedValueOnce(state).mockRejectedValueOnce(Error('Authorization=do-not-render'));
  render(<OpenTelemetrySettings />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry OpenTelemetry settings' }));
  await screen.findByText(/Telemetry runtime is off/);
  fireEvent.click(screen.getByRole('switch'));
  save();
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Could not save');
  expect(alert.textContent).not.toContain('do-not-render');
  expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(true);
});

it('allows enablement with an environment destination and an otherwise blank custom draft', async () => {
  await mount({
    ...state,
    settings: { enabled: false, endpoint: '', headersConfigured: false },
    effective: { ...state.effective, endpoint: 'https://environment-collector.example.com', endpointSource: 'environment', headersConfigured: false },
  });
  fireEvent.click(screen.getByRole('switch'));
  save();
  await screen.findByText('OpenTelemetry settings saved. Active environment overrides remain in effect.');
  expect(lastRequestBody()).toEqual({ enabled: true, endpoint: '' });
});
