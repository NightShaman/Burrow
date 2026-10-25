import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { DreamPromotionSettings } from './DreamPromotionSettings';
vi.mock('../../app/api', () => ({ api: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const toggle = () => screen.getByRole('checkbox', { name: 'Promote Dreams to memory' }) as HTMLInputElement;
it('defaults missing values to true and persists both values across remount', async () => {
  let settings = {};
  vi.mocked(api).mockImplementation(async (_path, init) => {
    if (init?.method === 'PUT') settings = JSON.parse(init.body as string);
    return settings;
  });
  let view = render(<DreamPromotionSettings />);
  await waitFor(() => expect(toggle().disabled).toBe(false));
  expect(toggle().checked).toBe(true);
  for (const value of [false, true]) {
    fireEvent.click(toggle()); fireEvent.click(screen.getByRole('button', { name: 'Save promotion settings' }));
    await waitFor(() => expect(toggle().disabled).toBe(false));
    expect(settings).toEqual({ promoteDreamsToMemory: value });
    view.unmount(); view = render(<DreamPromotionSettings />);
    await waitFor(() => expect(toggle().disabled).toBe(false));
    expect(toggle().checked).toBe(value);
  }
});
it('blocks edits on failed read, retries, and preserves failed save draft', async () => {
  vi.mocked(api).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce({ promoteDreamsToMemory: false }).mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ promoteDreamsToMemory: true });
  render(<DreamPromotionSettings />);
  await screen.findByRole('alert'); expect(toggle().disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Retry loading promotion settings' }));
  await waitFor(() => expect(toggle().disabled).toBe(false));
  expect(toggle().checked).toBe(false);
  fireEvent.click(toggle()); fireEvent.click(screen.getByRole('button', { name: 'Save promotion settings' }));
  await screen.findByText(/Could not save/); expect(toggle().checked).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Save promotion settings' }));
  await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
});
it('ignores a late save after navigation', async () => {
  let resolve!: (value: unknown) => void;
  vi.mocked(api).mockImplementation(async (_path, init) => init?.method === 'PUT' ? new Promise(r => { resolve = r; }) : { promoteDreamsToMemory: true });
  const view = render(<DreamPromotionSettings />);
  await waitFor(() => expect(toggle().disabled).toBe(false));
  fireEvent.click(toggle()); fireEvent.click(screen.getByRole('button', { name: 'Save promotion settings' }));
  view.unmount(); render(<DreamPromotionSettings />);
  await waitFor(() => expect(toggle().disabled).toBe(false));
  await act(async () => resolve({ promoteDreamsToMemory: false }));
  expect(toggle().checked).toBe(true);
});
