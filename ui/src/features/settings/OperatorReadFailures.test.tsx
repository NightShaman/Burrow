import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { OperatorProfile } from './OperatorProfile';
import { OperatorTimezone } from './OperatorTimezone';
import { CuratorSettings } from './CuratorSettings';

vi.mock('../../app/api', () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('profile fails closed including avatar actions, then retries loaded values', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ operator: { name: 'Loaded operator', avatar: 'data:image/png;base64,YQ==' } });
  render(<OperatorProfile onSaved={vi.fn()} />);
  await screen.findByRole('alert');
  expect((screen.getByLabelText('Displayed name') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Change' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Save profile' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save profile' }));
  expect(api).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry operator profile' }));
  await waitFor(() => expect((screen.getByLabelText('Displayed name') as HTMLInputElement).value).toBe('Loaded operator'));
  expect((screen.getByRole('button', { name: 'Remove image' }) as HTMLButtonElement).disabled).toBe(false);
  expect((screen.getByRole('button', { name: 'Save profile' }) as HTMLButtonElement).disabled).toBe(false);
});

it('timezone fails closed, then retries loaded timezone', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ timezone: 'Europe/London' });
  render(<OperatorTimezone />);
  await screen.findByRole('alert');
  expect((screen.getByLabelText('Operator timezone') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Use browser timezone' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save timezone' }));
  expect(api).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry operator timezone' }));
  await waitFor(() => expect((screen.getByLabelText('Operator timezone') as HTMLInputElement).value).toBe('Europe/London'));
  expect((screen.getByRole('button', { name: 'Save timezone' }) as HTMLButtonElement).disabled).toBe(false);
});

it('curator fails closed including radios, then retries loaded local selection', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true, configured: true, selection: { kind: 'local', modelPath: 'models/loaded.gguf', contextSize: 8192, gpuLayers: 3, temperature: 0.25 } });
  render(<CuratorSettings savedProviders={[]} />);
  await screen.findByText(/Could not load curator settings/);
  expect((screen.getByRole('radio', { name: 'Local GGUF' }) as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Save Tiddle Settings' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save Tiddle Settings' }));
  expect(api).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Retry Tiddle Settings' }));
  await waitFor(() => expect((screen.getByLabelText('Model path') as HTMLInputElement).value).toBe('models/loaded.gguf'));
  expect((screen.getByLabelText('Context size') as HTMLInputElement).value).toBe('8192');
  expect((screen.getByRole('radio', { name: 'Local GGUF' }) as HTMLInputElement).disabled).toBe(false);
});
