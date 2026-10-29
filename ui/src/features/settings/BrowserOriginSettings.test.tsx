import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../app/api';
import { BrowserOriginSettings } from './BrowserOriginSettings';
vi.mock('../../app/api', () => ({ api: vi.fn() }));
const mocked = vi.mocked(api);
const response = (saved = true, effective = saved, source: 'environment' | 'database' | 'default' = 'database') => ({ ok: true as const, settings: { checkOrigin: saved }, effective: { checkOrigin: effective, source, allowedOrigins: ['http://localhost:5174'] } });
function deferred() { let resolve!: (value: ReturnType<typeof response>) => void; const promise = new Promise<ReturnType<typeof response>>(r => { resolve = r; }); return { promise, resolve }; }
const checkbox = () => screen.getByLabelText('Check browser origin') as HTMLInputElement;
beforeEach(() => { mocked.mockReset(); mocked.mockResolvedValue(response()); });
afterEach(cleanup);
async function mount() { render(<BrowserOriginSettings />); await waitFor(() => expect(checkbox().disabled).toBe(false)); }
describe('Browser origin settings', () => {
  it('loads default on, saves the preference and reports returned effective state', async () => {
    await mount(); expect(checkbox().checked).toBe(true);
    mocked.mockResolvedValueOnce(response(false)); fireEvent.click(checkbox());
    await screen.findByText('Browser origin setting saved and applied.');
    expect(mocked).toHaveBeenLastCalledWith('/api/settings/browser-origin', expect.objectContaining({ method: 'PUT', body: '{"checkOrigin":false}' }));
    expect(screen.getByText('Effective: Off')).toBeTruthy();
  });
  it('distinguishes saved preference from an environment override after save', async () => {
    mocked.mockResolvedValue(response(true, false, 'environment')); await mount();
    expect(checkbox().checked).toBe(true); expect(screen.getByText(/Effective: Off.*Environment override/)).toBeTruthy();
    mocked.mockResolvedValueOnce(response(false, false, 'environment')); fireEvent.click(checkbox());
    await screen.findByText('Preference saved. Environment override remains active.');
    expect(screen.queryByText('Browser origin setting saved and applied.')).toBeNull();
  });
  it('locks edits and saves during loading and saving', async () => {
    const load = deferred(); mocked.mockReturnValueOnce(load.promise); render(<BrowserOriginSettings />);
    expect(checkbox().disabled).toBe(true);
    await act(async () => load.resolve(response()));
    const save = deferred(); mocked.mockReturnValueOnce(save.promise); fireEvent.click(checkbox());
    expect(checkbox().disabled).toBe(true); expect(screen.getByText('Saving browser origin…')).toBeTruthy();
    await act(async () => save.resolve(response())); expect(checkbox().disabled).toBe(false);
  });
  it('retries loading and preserves the draft on save failure', async () => {
    mocked.mockRejectedValueOnce(new Error('offline')); render(<BrowserOriginSettings />);
    await screen.findByText('Could not load browser origin settings.'); fireEvent.click(screen.getByText('Retry browser origin'));
    await waitFor(() => expect(checkbox().disabled).toBe(false));
    mocked.mockRejectedValueOnce(new Error('offline')); fireEvent.click(checkbox());
    await screen.findByText('Could not save browser origin settings. Try saving again.'); expect(checkbox().checked).toBe(false); expect(checkbox().disabled).toBe(false);
  });
  it.each(['load', 'save'])('ignores an old runtime owner %s completion after remount', async action => {
    const old = deferred();
    if (action === 'load') mocked.mockReturnValueOnce(old.promise);
    const view = render(<BrowserOriginSettings />);
    if (action === 'save') { await waitFor(() => expect(checkbox().disabled).toBe(false)); mocked.mockReturnValueOnce(old.promise); fireEvent.click(checkbox()); }
    view.unmount(); await mount();
    await act(async () => old.resolve(response(false))); expect(checkbox().checked).toBe(true); expect(screen.queryByText('Browser origin setting saved and applied.')).toBeNull();
  });
});
