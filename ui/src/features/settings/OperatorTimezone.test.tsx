import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { OperatorTimezone } from './OperatorTimezone';

vi.mock('../../app/api', () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });

it('loads and autosaves a valid operator timezone on blur independently of browser display', async () => {
  vi.mocked(api).mockResolvedValueOnce({ timezone: 'America/Chicago' }).mockResolvedValueOnce({ ok: true, timezone: 'Europe/London' });
  render(<OperatorTimezone />);
  const input = await screen.findByLabelText('Operator timezone');
  await waitFor(() => expect((input as HTMLInputElement).value).toBe('America/Chicago'));
  fireEvent.change(input, { target: { value: ' Europe/London ' } });
  fireEvent.blur(input);
  await screen.findByText('Operator timezone saved.');
  expect(api).toHaveBeenLastCalledWith('/api/settings/timezone', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ timezone: 'Europe/London' }) }));
});

it('rejects invalid zones on blur without a PUT', async () => {
  vi.mocked(api).mockResolvedValue({ timezone: 'UTC' });
  render(<OperatorTimezone />);
  const input = await screen.findByLabelText('Operator timezone');
  await waitFor(() => expect((input as HTMLInputElement).value).toBe('UTC'));
  fireEvent.change(input, { target: { value: 'Not/AZone' } });
  fireEvent.blur(input);
  expect((await screen.findByRole('alert')).textContent).toContain('Enter a valid IANA timezone');
  expect(api).toHaveBeenCalledTimes(1);
});

it('uses the browser timezone and saves it immediately without first saving a competing field draft', async () => {
  vi.mocked(api).mockResolvedValueOnce({ timezone: 'UTC' }).mockResolvedValueOnce({ ok: true, timezone: 'America/New_York' });
  const resolvedOptions = vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: 'America/New_York' } as Intl.ResolvedDateTimeFormatOptions);
  render(<OperatorTimezone />);
  const input = await screen.findByLabelText('Operator timezone');
  await waitFor(() => expect((input as HTMLInputElement).value).toBe('UTC'));
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: 'Europe/London' } });
  const action = screen.getByRole('button', { name: 'Use browser timezone' });
  fireEvent.mouseDown(action);
  fireEvent.click(action);
  await screen.findByText('Operator timezone saved.');
  expect(api).toHaveBeenCalledTimes(2);
  expect(api).toHaveBeenLastCalledWith('/api/settings/timezone', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ timezone: 'America/New_York' }) }));
  resolvedOptions.mockRestore();
});

it('preserves a failed timezone draft and retries the write', async () => {
  vi.mocked(api).mockResolvedValueOnce({ timezone: 'UTC' }).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ ok: true, timezone: 'Europe/London' });
  render(<OperatorTimezone />);
  const input = await screen.findByLabelText('Operator timezone');
  await waitFor(() => expect((input as HTMLInputElement).value).toBe('UTC'));
  fireEvent.change(input, { target: { value: 'Europe/London' } });
  fireEvent.blur(input);
  await screen.findByText('Could not save operator timezone.');
  expect((input as HTMLInputElement).value).toBe('Europe/London');
  fireEvent.click(screen.getByRole('button', { name: 'Retry saving operator timezone' }));
  await screen.findByText('Operator timezone saved.');
  expect(api).toHaveBeenCalledTimes(3);
});

it.each<[string, unknown]>([
  ['null', null], ['missing value', {}], ['wrong type', { timezone: 42 }],
  ['empty string', { timezone: '' }], ['whitespace', { timezone: '   ' }],
  ['invalid zone string', { timezone: 'Not/AZone' }], ['untrimmed zone', { timezone: ' UTC ' }],
  ['offset string', { timezone: '+01:00' }],
])('fails closed on a malformed timezone read: %s', async (_label, response) => {
  vi.mocked(api).mockResolvedValueOnce(response).mockResolvedValueOnce({ timezone: 'UTC' });
  render(<OperatorTimezone />);
  await screen.findByText('Could not load operator timezone.');
  expect((screen.getByLabelText('Operator timezone') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Use browser timezone' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry operator timezone' }));
  await waitFor(() => expect((screen.getByLabelText('Operator timezone') as HTMLInputElement).value).toBe('UTC'));
});

it.each<[string, unknown]>([
  ['null', null], ['empty ACK', {}], ['missing ok', { timezone: 'Europe/London' }],
  ['negative ACK', { ok: false, timezone: 'Europe/London' }],
  ['missing timezone', { ok: true }], ['wrong type', { ok: true, timezone: 42 }],
  ...['', '   ', 'Not/AZone', ' UTC ', '+01:00'].map(timezone => [JSON.stringify(timezone), { ok: true, timezone }] as [string, unknown]),
])('rejects malformed timezone save ACK without accepting the draft: %s', async (_label, response) => {
  vi.mocked(api).mockResolvedValueOnce({ timezone: 'UTC' }).mockResolvedValueOnce(response).mockResolvedValueOnce(response);
  const leave = vi.fn();
  render(<UnsavedChangesProvider><OperatorTimezone /><Leave onLeave={leave} /></UnsavedChangesProvider>);
  const input = screen.getByLabelText('Operator timezone') as HTMLInputElement;
  await waitFor(() => expect(input.value).toBe('UTC'));
  fireEvent.change(input, { target: { value: 'Europe/London' } });
  fireEvent.blur(input);
  await screen.findByText('Could not save operator timezone.');
  expect(input.value).toBe('Europe/London');
  expect(screen.queryByText('Operator timezone saved.')).toBeNull();
  expect(screen.getByRole('button', { name: 'Retry saving operator timezone' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
  fireEvent.click(await screen.findByRole('button', { name: /^Save$/ }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(leave).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
  expect(input.value).toBe('UTC');
});

it.each(['Europe/London', 'Not/AZone'])('focus transfer to browser action does not autosave competing draft %s', async draft => {
  vi.mocked(api).mockResolvedValueOnce({ timezone: 'UTC' }).mockResolvedValueOnce({ ok: true, timezone: 'America/New_York' });
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({ timeZone: 'America/New_York' } as Intl.ResolvedDateTimeFormatOptions);
  render(<OperatorTimezone />);
  const input = screen.getByLabelText('Operator timezone') as HTMLInputElement;
  await waitFor(() => expect(input.value).toBe('UTC'));
  fireEvent.change(input, { target: { value: draft } });
  const action = screen.getByRole('button', { name: 'Use browser timezone' });
  // Native focus() fires focusout with relatedTarget (keyboard/touch path, no mouseDown).
  act(() => { input.focus(); action.focus(); });
  expect(document.activeElement).toBe(action);
  expect(api).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('alert')).toBeNull();
  fireEvent.click(action);
  await screen.findByText('Operator timezone saved.');
  expect(input.value).toBe('America/New_York');
  expect(api).toHaveBeenCalledTimes(2);
  expect(api).toHaveBeenLastCalledWith('/api/settings/timezone', expect.objectContaining({ body: '{"timezone":"America/New_York"}' }));
});

it('accepts a valid canonical timezone from the server instead of echoing the request', async () => {
  vi.mocked(api).mockResolvedValueOnce({ timezone: 'UTC' }).mockResolvedValueOnce({ ok: true, timezone: 'America/New_York' });
  render(<OperatorTimezone />);
  const input = screen.getByLabelText('Operator timezone') as HTMLInputElement;
  await waitFor(() => expect(input.value).toBe('UTC'));
  fireEvent.change(input, { target: { value: 'US/Eastern' } });
  fireEvent.blur(input);
  await screen.findByText('Operator timezone saved.');
  expect(input.value).toBe('America/New_York');
  fireEvent.blur(input);
  expect(api).toHaveBeenCalledTimes(2);
});

function Leave({ onLeave }: { onLeave: () => void }) {
  const navigate = useUnsavedNavigation();
  return <button onClick={() => navigate(onLeave)}>Leave</button>;
}
