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
  expect((screen.getByRole('checkbox') as HTMLInputElement).disabled).toBe(true);
  await screen.findByText('Environment override');
  expect(screen.getByText('Enabled · SDK started')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Save telemetry setting' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Save telemetry setting' }));
  await screen.findByText('OpenTelemetry setting saved.');
  expect(api).toHaveBeenLastCalledWith('/api/settings/opentelemetry', expect.objectContaining({ method: 'PUT', body: '{"enabled":true}' }));
});
it('shows restart guidance and unavailable runtime without inventing runtime state', async () => {
  vi.mocked(api).mockResolvedValue({ ...state, runtime: undefined, effective: { enabled: false, source: 'database', restartRequired: true } });
  render(<OpenTelemetrySettings />);
  await screen.findByText('Unavailable');
  expect(screen.getByText('Yes')).toBeTruthy();
  expect(screen.getByText(/Restart Core to finish/)).toBeTruthy();
});
it('retries load errors and retains saved state after a failed save', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(state).mockRejectedValueOnce(new Error('offline'));
  render(<OpenTelemetrySettings />);
  fireEvent.click(await screen.findByRole('button', { name: 'Retry OpenTelemetry settings' }));
  await screen.findByText('Environment override');
  fireEvent.click(screen.getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Save telemetry setting' }));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not save'));
  expect(screen.queryByText('OpenTelemetry setting saved.')).toBeNull();
});
