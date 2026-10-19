import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { OpenTelemetrySettings } from './OpenTelemetrySettings';

vi.mock('../../app/api', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../app/api')>(),
  api: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

const state = {
  ok: true,
  settings: {
    enabled: false,
    endpoint: 'https://collector.example.com:4318',
    headersConfigured: true,
  },
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

async function mount() {
  render(<OpenTelemetrySettings />);
  await screen.findByText(/Telemetry runtime is off/);
}

function save() {
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
}

function lastRequestBody() {
  return JSON.parse(vi.mocked(api).mock.calls.at(-1)![1]!.body as string);
}

it('shows saved and effective values and preserves protected headers when omitted', async () => {
  vi.mocked(api)
    .mockResolvedValueOnce(state)
    .mockResolvedValueOnce({
      ...state,
      settings: { ...state.settings, enabled: true },
      effective: { ...state.effective, enabled: true },
      runtime: { enabled: true, sdkStarted: true },
    });

  await mount();
  expect((screen.getByLabelText('Collector endpoint') as HTMLInputElement).value).toBe(state.settings.endpoint);
  expect(screen.getByText(/Headers are configured/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);

  fireEvent.click(screen.getByRole('switch'));
  save();

  await screen.findByText('OpenTelemetry settings saved and applied live.');
  expect(api).toHaveBeenLastCalledWith('/api/settings/opentelemetry', expect.objectContaining({ method: 'PUT' }));
  expect(lastRequestBody()).toEqual({ enabled: true, endpoint: state.settings.endpoint });
  expect(screen.getByText(/Telemetry runtime is on/)).toBeTruthy();
});

it('replaces protected headers without retaining or displaying the secret after success', async () => {
  vi.mocked(api).mockResolvedValue(state);
  await mount();

  const headerInput = screen.getByLabelText('Collector headers') as HTMLInputElement;
  expect(headerInput.type).toBe('password');
  expect(headerInput.value).toBe('');
  fireEvent.change(headerInput, { target: { value: 'Authorization=Bearer test-token' } });
  save();

  await screen.findByText('OpenTelemetry settings saved and applied live.');
  expect(lastRequestBody()).toEqual({
    enabled: false,
    endpoint: state.settings.endpoint,
    headers: 'Authorization=Bearer test-token',
  });
  expect(headerInput.value).toBe('');
  expect(screen.queryByText(/test-token/)).toBeNull();
});

it('preserves an intentional header replacement exactly, including surrounding whitespace', async () => {
  vi.mocked(api).mockResolvedValue(state);
  await mount();

  fireEvent.change(screen.getByLabelText('Collector headers'), { target: { value: '  x-api-key=secret  ' } });
  save();

  await screen.findByText('OpenTelemetry settings saved and applied live.');
  expect(lastRequestBody().headers).toBe('  x-api-key=secret  ');
});

it('clears saved headers explicitly and never combines clearHeaders with headers', async () => {
  vi.mocked(api).mockResolvedValue(state);
  await mount();

  fireEvent.change(screen.getByLabelText('Collector headers'), { target: { value: 'x-api-key=secret' } });
  fireEvent.click(screen.getByLabelText('Remove saved headers on save'));
  expect((screen.getByLabelText('Collector headers') as HTMLInputElement).value).toBe('');
  save();

  await screen.findByText('OpenTelemetry settings saved and applied live.');
  expect(lastRequestBody()).toEqual({
    enabled: false,
    endpoint: state.settings.endpoint,
    clearHeaders: true,
  });
});

it('summarizes independent environment overrides without restart or manual-edit guidance', async () => {
  vi.mocked(api).mockResolvedValue({
    ...state,
    runtime: undefined,
    effective: {
      ...state.effective,
      enabled: true,
      endpoint: 'https://environment-collector.example.com',
      source: 'environment',
      endpointSource: 'environment',
      headersSource: 'environment',
    },
  });

  render(<OpenTelemetrySettings />);
  await screen.findByText(/Telemetry runtime status is unavailable/);
  expect(screen.getByText(/Environment overrides currently control the telemetry preference, collector endpoint, and collector headers/)).toBeTruthy();
  expect(screen.getByText(/environment-collector/)).toBeTruthy();
  expect(screen.queryByText(/Restart Core/)).toBeNull();
  expect(screen.queryByText(/change.*variable/i)).toBeNull();
  fireEvent.change(screen.getByRole('textbox', { name: 'Collector endpoint' }), { target: { value: 'https://saved-change.example' } });
  save();
  await screen.findByText('OpenTelemetry settings saved. Active environment overrides remain in effect.');
});

it('blocks contract-invalid endpoint and header values before PUT', async () => {
  vi.mocked(api).mockResolvedValueOnce(state);
  await mount();
  fireEvent.change(screen.getByRole('textbox', { name: 'Collector endpoint' }), { target: { value: 'ftp://user:pass@example.test?bad=yes' } });
  save();
  await screen.findByText(/Use an HTTP or HTTPS collector URL/);
  expect(api).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole('textbox', { name: 'Collector endpoint' }), { target: { value: 'https://collector.example' } });
  fireEvent.change(screen.getByLabelText('Collector headers'), { target: { value: 'not-a-pair' } });
  save();
  await screen.findByText(/comma-separated key=value list/);
  expect(api).toHaveBeenCalledTimes(1);
});

it('retries load errors and keeps the draft after save errors without exposing server details', async () => {
  vi.mocked(api)
    .mockRejectedValueOnce(Error('offline'))
    .mockResolvedValueOnce(state)
    .mockRejectedValueOnce(Error('Authorization=do-not-render'));

  render(<OpenTelemetrySettings />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry OpenTelemetry settings' }));
  await screen.findByText(/Telemetry runtime is off/);

  fireEvent.click(screen.getByRole('switch'));
  save();

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('Could not save');
  expect(alert.textContent).not.toContain('do-not-render');
  expect((screen.getByRole('switch') as HTMLInputElement).checked).toBe(true);
  expect(screen.queryByText('OpenTelemetry settings saved and applied live.')).toBeNull();
});

it('requires a destination to enable telemetry before sending a PUT', async () => {
  vi.mocked(api).mockResolvedValue({
    ...state,
    settings: { ...state.settings, endpoint: '' },
    effective: { ...state.effective, endpoint: '' },
  });
  await mount();

  fireEvent.click(screen.getByRole('switch'));
  save();

  expect((await screen.findByRole('alert')).textContent).toContain('before enabling');
  expect(api).toHaveBeenCalledTimes(1);
});

it('allows enablement with a blank saved endpoint when an effective environment endpoint exists', async () => {
  vi.mocked(api).mockResolvedValue({
    ...state,
    settings: { ...state.settings, endpoint: '' },
    effective: {
      ...state.effective,
      endpoint: 'https://environment-collector.example.com',
      endpointSource: 'environment',
    },
  });
  await mount();

  fireEvent.click(screen.getByRole('switch'));
  save();

  await screen.findByText('OpenTelemetry settings saved. Active environment overrides remain in effect.');
  expect(lastRequestBody()).toEqual({ enabled: true, endpoint: '' });
});

it('sends blank endpoint and headers as omission so the server applies exact contract semantics', async () => {
  vi.mocked(api).mockResolvedValue({
    ...state,
    settings: { ...state.settings, enabled: false, endpoint: '', headersConfigured: false },
    effective: { ...state.effective, endpoint: '', headersConfigured: false },
  });
  await mount();

  fireEvent.change(screen.getByLabelText('Collector headers'), { target: { value: '   ' } });
  fireEvent.change(screen.getByLabelText('Collector endpoint'), { target: { value: ' https://collector.example.com/v1 ' } });
  save();

  await screen.findByText('OpenTelemetry settings saved and applied live.');
  expect(lastRequestBody()).toEqual({ enabled: false, endpoint: 'https://collector.example.com/v1' });
});
