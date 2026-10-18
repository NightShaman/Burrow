import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { OpenTelemetrySettings } from './OpenTelemetrySettings';
vi.mock('../../app/api', async importOriginal => ({ ...await importOriginal<typeof import('../../app/api')>(), api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const state = { settings: { enabled: false }, effective: { enabled: true, source: 'environment', restartRequired: false }, runtime: { enabled: true, sdkStarted: true } };
it('displays authoritative saved/effective/override/runtime state and saves only the boolean', async () => {
  vi.mocked(api).mockResolvedValueOnce(state).mockResolvedValueOnce({ ...state, settings: { enabled: true } });
  render(<OpenTelemetrySettings />);
  expect((screen.getByRole('switch') as HTMLInputElement).disabled).toBe(true);
  await screen.findByText(/Server override:/);
  expect(screen.getByText('Telemetry is on.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Save changes' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('switch'));
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await screen.findByText('OpenTelemetry setting saved.');
  expect(api).toHaveBeenLastCalledWith('/api/settings/opentelemetry', expect.objectContaining({ method: 'PUT', body: '{"enabled":true}' }));
});
it('shows restart guidance and unavailable runtime without inventing runtime state', async () => {
  vi.mocked(api).mockResolvedValue({ ...state, runtime: undefined, effective: { enabled: false, source: 'database', restartRequired: true } });
  render(<OpenTelemetrySettings />);
  await screen.findByText('Telemetry runtime status is unavailable.');
  expect(screen.getByText(/Restart Core to finish/)).toBeTruthy();
});
it('retries load errors and retains saved state after a failed save', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(state).mockRejectedValueOnce(new Error('offline'));
  render(<OpenTelemetrySettings />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry OpenTelemetry settings' }));
  await screen.findByText(/Server override:/);
  fireEvent.click(screen.getByRole('switch'));
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not save'));
  expect(screen.queryByText('OpenTelemetry setting saved.')).toBeNull();
});

it('keeps normal disabled state compact and hides irrelevant operational guidance', async () => {
  vi.mocked(api).mockResolvedValue({settings:{enabled:false},effective:{enabled:false,source:'database',restartRequired:false},runtime:{enabled:false,sdkStarted:false}});
  render(<OpenTelemetrySettings />);
  await screen.findByText('Telemetry is off.');
  expect(screen.queryByText(/BURROW_OTEL_ENABLED/)).toBeNull();
  expect(screen.queryByText(/Restart Core/)).toBeNull();
  expect(document.querySelector('dl')).toBeNull();
});
