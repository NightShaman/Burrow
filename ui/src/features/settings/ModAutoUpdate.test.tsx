import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModsSettings } from './ModsSettings';
import { saveModAutoUpdate, type ModRecord } from './modManagementApi';

const installed: ModRecord = {
  id: 'alpha/mod',
  name: 'Alpha',
  status: 'installed',
  enabled: true,
  version: '1',
  latestVersion: '2',
  updateAvailable: true,
  autoUpdateAvailable: true,
  autoUpdateEnabled: false,
};
const path = '/api/mod-management/alpha%2Fmod/auto-update';
const toggle = () =>
  screen.getByRole('switch', { name: 'Update automatically' }) as HTMLInputElement;
function mount(mods: ModRecord[], write?: (init: RequestInit) => Promise<Response>) {
  const fetcher = vi.fn(async (url: string, init: RequestInit = {}) => {
    if (url === '/api/mod-management')
      return Response.json({ mods, sources: [], restartRequired: false });
    if (url === '/api/mods') return Response.json({ ok: true, mods: [] });
    if (url === path && init.method === 'PUT' && write) return write(init);
    throw new Error(`Unexpected: ${init.method} ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<ModsSettings />);
  return fetcher;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe('installed mod automatic updates', () => {
  it('sends only the selected mod setting, waits for confirmation and leaves manual updates intact', async () => {
    const mods = [{ ...installed }, { ...installed, id: 'beta', name: 'Beta' }];
    let release!: () => void;
    const fetcher = mount(mods, async (init) => {
      expect(new Headers(init.headers).get('content-type')).toBe('application/json');
      expect(JSON.parse(String(init.body))).toEqual({ enabled: true });
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      mods[0].autoUpdateEnabled = true;
      return Response.json({ ok: true, autoUpdateEnabled: true });
    });
    await screen.findByRole('switch');
    expect(toggle().checked).toBe(false);
    fireEvent.click(toggle());
    expect(toggle().disabled).toBe(true);
    expect(toggle().checked).toBe(false);
    fireEvent.click(toggle());
    await act(async () => release());
    expect(toggle().checked).toBe(true);
    expect(toggle().disabled).toBe(false);
    expect(
      fetcher.mock.calls
        .filter(([, init]) => init?.method && init.method !== 'GET')
        .map(([url]) => url),
    ).toEqual([path]);
    expect((screen.getByRole('button', { name: 'Update' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Manage Beta' }));
    expect(toggle().checked).toBe(false);
  });
  it('allows opting out after losing the installed source, then prevents re-enabling', async () => {
    const mod = {
      ...installed,
      autoUpdateEnabled: true,
      autoUpdateAvailable: false,
      autoUpdateReason: 'The installed source is no longer configured.',
    };
    mount([mod], async (init) => {
      expect(JSON.parse(String(init.body))).toEqual({ enabled: false });
      mod.autoUpdateEnabled = false;
      return Response.json({ ok: true, autoUpdateEnabled: false });
    });
    await screen.findByRole('switch');
    expect(toggle().checked).toBe(true);
    expect(toggle().disabled).toBe(false);
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().checked).toBe(false));
    expect(toggle().disabled).toBe(true);
    expect(screen.getByText(mod.autoUpdateReason).id).toBe(
      toggle().getAttribute('aria-describedby'),
    );
  });
  it.each([
    'Approval required for new permissions.',
    'Requires a newer version of Core.',
    'Core restart required.',
    'Source check failed.',
  ])('reports the reason supplied by Core: %s', async (reason) => {
    mount([{ ...installed, autoUpdateEnabled: true, autoUpdateReason: reason }]);
    await screen.findByRole('switch');
    expect(screen.getByText(reason).id).toBe(toggle().getAttribute('aria-describedby'));
  });
  it('does not offer enrollment for an uninstalled mod or an older inventory', async () => {
    mount([
      { ...installed, status: 'available' },
      { id: 'old', name: 'Old', status: 'installed' },
    ]);
    await screen.findByRole('button', { name: 'Install' });
    expect(screen.queryByRole('switch')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Manage Old' }));
    expect(screen.queryByRole('switch')).toBeNull();
  });
  it('keeps the confirmed setting on failure, scopes the diagnostic to its mod, and permits retry', async () => {
    const mod = { ...installed };
    const write = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({ error: 'Source configuration changed.' }, { status: 409 }),
      )
      .mockImplementationOnce(async () => {
        mod.autoUpdateEnabled = true;
        return Response.json({ ok: true, autoUpdateEnabled: true });
      });
    mount([mod, { ...installed, id: 'beta', name: 'Beta' }], write);
    await screen.findByRole('switch');
    fireEvent.click(toggle());
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Source configuration changed.',
    );
    expect(toggle().checked).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Manage Beta' }));
    expect(screen.queryByRole('alert')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Manage Alpha' }));
    fireEvent.click(toggle());
    await waitFor(() => expect(toggle().checked).toBe(true));
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it.each([{}, { ok: true, autoUpdateEnabled: false }, { ok: true, autoUpdateEnabled: 'true' }])(
    'rejects an unconfirmed write: %j',
    async (ack) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => Response.json(ack)),
      );
      await expect(saveModAutoUpdate(installed.id, true)).rejects.toThrow('Core did not confirm');
    },
  );
});
