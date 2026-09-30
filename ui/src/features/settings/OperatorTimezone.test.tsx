import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { OperatorTimezone } from './OperatorTimezone';
vi.mock('../../app/api', () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
it('loads and saves operator timezone independently of browser display', async () => {
  vi.mocked(api).mockResolvedValue({ timezone: 'America/Chicago' });
  render(<OperatorTimezone />);
  await waitFor(() => expect((screen.getByLabelText('Operator timezone') as HTMLInputElement).value).toBe('America/Chicago'));
  fireEvent.change(screen.getByLabelText('Operator timezone'), { target: { value: 'Europe/London' } });
  fireEvent.click(screen.getByText('Save timezone'));
  await screen.findByText('Operator timezone saved.');
  expect(api).toHaveBeenCalledWith('/api/settings/timezone', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ timezone: 'Europe/London' }) }));
});
it('rejects invalid zones without a PUT', async () => {
  vi.mocked(api).mockResolvedValue({ timezone: 'UTC' });
  render(<OperatorTimezone />);
  await waitFor(() => expect((screen.getByLabelText('Operator timezone') as HTMLInputElement).value).toBe('UTC'));
  fireEvent.change(screen.getByLabelText('Operator timezone'), { target: { value: 'Not/AZone' } });
  fireEvent.click(screen.getByText('Save timezone'));
  await screen.findByRole('alert');
  expect(api).toHaveBeenCalledTimes(1);
});
