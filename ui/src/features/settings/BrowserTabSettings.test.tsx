import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { UnsavedChangesProvider, useUnsavedNavigation } from '../../app/UnsavedChanges';
import { browserTabChanged, useBrowserTabTitle } from '../../app/browserTab';
import { BrowserTabSettings } from './BrowserTabSettings';

vi.mock('../../app/api', () => ({ api: vi.fn(), jsonMutation: (method: string, body: unknown) => ({ method, body: JSON.stringify(body) }) }));
afterEach(() => { cleanup(); vi.resetAllMocks(); document.title = 'Burrow'; });

it('loads persisted suffix and autosaves a trimmed suffix on validated blur, including clearing it', async () => {
  vi.mocked(api).mockResolvedValueOnce({ suffix: 'Dev' }).mockResolvedValueOnce({ suffix: 'Prod' }).mockResolvedValueOnce({ suffix: '' });
  render(<BrowserTabSettings />);
  const input = await screen.findByLabelText('Browser tab suffix');
  await waitFor(() => expect((input as HTMLInputElement).value).toBe('Dev'));
  fireEvent.change(input, { target: { value: ' Prod ' } });
  expect(screen.getByText('Burrow — Prod')).toBeTruthy();
  fireEvent.blur(input);
  await screen.findByText('Browser tab suffix saved.');
  expect(api).toHaveBeenLastCalledWith('/api/settings/browser-tab', expect.objectContaining({ method: 'PUT', body: '{"suffix":"Prod"}' }));
  fireEvent.change(input, { target: { value: '' } });
  fireEvent.blur(input);
  await waitFor(() => expect(api).toHaveBeenLastCalledWith('/api/settings/browser-tab', expect.objectContaining({ body: '{"suffix":""}' })));
});

it('validates before blur autosave and preserves a failed draft for explicit retry', async () => {
  vi.mocked(api).mockResolvedValueOnce({ suffix: 'Dev' }).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ suffix: 'Prod' });
  render(<BrowserTabSettings />);
  const input = await screen.findByLabelText('Browser tab suffix');
  await waitFor(() => expect((input as HTMLInputElement).value).toBe('Dev'));
  fireEvent.change(input, { target: { value: 'x'.repeat(81) } });
  fireEvent.blur(input);
  expect(await screen.findByText('Use 80 characters or fewer.')).toBeTruthy();
  expect(api).toHaveBeenCalledTimes(1);
  fireEvent.change(input, { target: { value: 'Prod' } });
  fireEvent.blur(input);
  await screen.findByText('Could not save browser tab suffix.');
  expect((input as HTMLInputElement).value).toBe('Prod');
  fireEvent.click(screen.getByRole('button', { name: 'Retry saving browser tab suffix' }));
  await screen.findByText('Browser tab suffix saved.');
  expect(api).toHaveBeenCalledTimes(3);
});

it('fails closed and retries load', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ suffix: 'Test' });
  render(<BrowserTabSettings />);
  await screen.findByRole('alert');
  expect((screen.getByLabelText('Browser tab suffix') as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByText('Retry browser tab settings'));
  await waitFor(() => expect((screen.getByLabelText('Browser tab suffix') as HTMLInputElement).value).toBe('Test'));
});

it('applies title on startup and saves immediately, rejecting stale startup reads', async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(api).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  renderHook(useBrowserTabTitle);
  act(() => window.dispatchEvent(new CustomEvent(browserTabChanged, { detail: 'Prod' })));
  await act(async () => resolve({ suffix: 'Dev' }));
  expect(document.title).toBe('Burrow — Prod');
  act(() => window.dispatchEvent(new CustomEvent(browserTabChanged, { detail: '' })));
  expect(document.title).toBe('Burrow');
});

it('loads environment suffix on startup', async () => {
  vi.mocked(api).mockResolvedValue({ suffix: 'Dev' });
  renderHook(useBrowserTabTitle);
  await waitFor(() => expect(document.title).toBe('Burrow — Dev'));
});

it('does not publish an old save completion after unmount over a newer mounted save', async () => {
  let resolveOld!: (value: unknown) => void;
  const pending = new Promise(resolve => { resolveOld = resolve; });
  vi.mocked(api)
    .mockResolvedValueOnce({ suffix: 'Dev' }) // title startup
    .mockResolvedValueOnce({ suffix: 'Dev' }) // first settings mount
    .mockReturnValueOnce(pending)
    .mockResolvedValueOnce({ suffix: 'Dev' }) // second settings mount
    .mockResolvedValueOnce({ suffix: 'Prod' });
  renderHook(useBrowserTabTitle);
  await waitFor(() => expect(document.title).toBe('Burrow — Dev'));
  const first = render(<BrowserTabSettings />);
  const firstInput = screen.getByLabelText('Browser tab suffix');
  await waitFor(() => expect((firstInput as HTMLInputElement).value).toBe('Dev'));
  fireEvent.change(firstInput, { target: { value: 'Stale' } });
  fireEvent.blur(firstInput);
  await screen.findByText('Saving browser tab suffix…');
  first.unmount();

  render(<BrowserTabSettings />);
  const currentInput = screen.getByLabelText('Browser tab suffix');
  await waitFor(() => expect((currentInput as HTMLInputElement).value).toBe('Dev'));
  fireEvent.change(currentInput, { target: { value: 'Prod' } });
  fireEvent.blur(currentInput);
  await screen.findByText('Browser tab suffix saved.');
  expect(document.title).toBe('Burrow — Prod');

  await act(async () => resolveOld({ suffix: 'Stale' }));
  expect(document.title).toBe('Burrow — Prod');
  expect((currentInput as HTMLInputElement).value).toBe('Prod');
  expect(screen.queryByRole('alert')).toBeNull();
});

it.each([
  ['null', null], ['missing value', {}], ['wrong type', { suffix: 42 }],
  ['untrimmed string', { suffix: ' Prod ' }], ['overlong string', { suffix: 'x'.repeat(81) }],
])('fails closed on malformed tab read: %s', async (_label, response) => {
  vi.mocked(api).mockResolvedValueOnce(response).mockResolvedValueOnce({ suffix: 'Dev' });
  render(<BrowserTabSettings />);
  await screen.findByText('Could not load browser tab settings.');
  expect((screen.getByLabelText('Browser tab suffix') as HTMLInputElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry browser tab settings' }));
  await waitFor(() => expect((screen.getByLabelText('Browser tab suffix') as HTMLInputElement).value).toBe('Dev'));
});

it.each([
  ['null', null], ['empty ACK', {}], ['wrong type', { suffix: 42 }],
  ['untrimmed string', { suffix: ' Prod ' }], ['overlong string', { suffix: 'x'.repeat(81) }],
])('rejects malformed tab ACK, preserves guard/baseline and does not publish a title: %s', async (_label, response) => {
  vi.mocked(api).mockResolvedValueOnce({ suffix: 'Dev' }).mockResolvedValueOnce(response).mockResolvedValueOnce(response);
  const published = vi.fn();
  window.addEventListener(browserTabChanged, published);
  const leave = vi.fn();
  try {
    render(<UnsavedChangesProvider><BrowserTabSettings /><Leave onLeave={leave} /></UnsavedChangesProvider>);
    const input = screen.getByLabelText('Browser tab suffix') as HTMLInputElement;
    await waitFor(() => expect(input.value).toBe('Dev'));
    fireEvent.change(input, { target: { value: 'Prod' } });
    fireEvent.blur(input);
    await screen.findByText('Could not save browser tab suffix.');
    expect(input.value).toBe('Prod');
    expect(screen.queryByText('Browser tab suffix saved.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry saving browser tab suffix' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Save$/ }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(leave).not.toHaveBeenCalled();
    expect(published).not.toHaveBeenCalled();
    expect(document.title).toBe('Burrow');
    fireEvent.click(screen.getByRole('button', { name: 'Leave' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }));
    expect(input.value).toBe('Dev');
  } finally { window.removeEventListener(browserTabChanged, published); }
});

it('counts Unicode code points rather than UTF-16 units when validating accepted suffixes', async () => {
  const suffix = '😀'.repeat(80);
  vi.mocked(api).mockResolvedValueOnce({ suffix: 'Dev' }).mockResolvedValueOnce({ suffix });
  render(<BrowserTabSettings />);
  const input = screen.getByLabelText('Browser tab suffix') as HTMLInputElement;
  await waitFor(() => expect(input.value).toBe('Dev'));
  fireEvent.change(input, { target: { value: suffix } });
  fireEvent.blur(input);
  await screen.findByText('Browser tab suffix saved.');
  expect(input.value).toBe(suffix);
  expect(screen.queryByRole('alert')).toBeNull();
});

function Leave({ onLeave }: { onLeave: () => void }) {
  const navigate = useUnsavedNavigation();
  return <button onClick={() => navigate(onLeave)}>Leave</button>;
}
