import { cleanup, fireEvent, render, screen, waitFor, renderHook, act } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { BrowserTabSettings } from './BrowserTabSettings';
import { browserTabChanged, useBrowserTabTitle } from '../../app/browserTab';
vi.mock('../../app/api', () => ({api: vi.fn(), jsonMutation: (method:string, body:unknown) => ({method, body:JSON.stringify(body)})}));
afterEach(() => { cleanup(); vi.resetAllMocks(); document.title = 'Burrow'; });
it('loads persisted suffix, previews and saves trimmed suffix, and clears to default', async () => {
  vi.mocked(api).mockResolvedValueOnce({suffix:'Dev'}).mockResolvedValueOnce({suffix:'Prod'}).mockResolvedValueOnce({suffix:''});
  render(<BrowserTabSettings />);
  const input = await screen.findByLabelText('Browser tab suffix');
  await waitFor(() => expect((input as HTMLInputElement).value).toBe('Dev'));
  fireEvent.change(input, {target:{value:' Prod '}});
  expect(screen.getByText('Burrow — Prod')).toBeTruthy();
  fireEvent.click(screen.getByText('Save tab suffix'));
  await screen.findByText('Browser tab suffix saved.');
  expect(api).toHaveBeenCalledWith('/api/settings/browser-tab', expect.objectContaining({method:'PUT',body:'{"suffix":"Prod"}'}));
  fireEvent.change(input, {target:{value:''}}); fireEvent.click(screen.getByText('Save tab suffix'));
  await waitFor(() => expect(api).toHaveBeenLastCalledWith('/api/settings/browser-tab', expect.objectContaining({body:'{"suffix":""}'})));
});
it('fails closed and retries load', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({suffix:'Test'});
  render(<BrowserTabSettings />);
  await screen.findByRole('alert');
  expect((screen.getByText('Save tab suffix') as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByText('Retry browser tab settings'));
  await waitFor(() => expect((screen.getByLabelText('Browser tab suffix') as HTMLInputElement).value).toBe('Test'));
});
it('applies title on startup and saves immediately, rejecting stale startup reads', async () => {
  let resolve!: (value:unknown) => void;
  vi.mocked(api).mockImplementationOnce(() => new Promise(r => { resolve = r; }));
  renderHook(useBrowserTabTitle);
  act(() => window.dispatchEvent(new CustomEvent(browserTabChanged, {detail:'Prod'})));
  await act(async () => resolve({suffix:'Dev'}));
  expect(document.title).toBe('Burrow — Prod');
  act(() => window.dispatchEvent(new CustomEvent(browserTabChanged, {detail:''})));
  expect(document.title).toBe('Burrow');
});
it('loads environment suffix on startup', async () => {
  vi.mocked(api).mockResolvedValue({suffix:'Dev'});
  renderHook(useBrowserTabTitle);
  await waitFor(() => expect(document.title).toBe('Burrow — Dev'));
});
