import { ConfirmProvider } from '../../app/ConfirmDialog';
import { clearBasicCredentials, setBasicCredentials } from '../../app/auth';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render as baseRender, waitFor } from '@testing-library/react';
import { ModSettingsHost } from './ModSettingsHost';
import { getObservedContext, resetObservedContext } from './ModSettingsAccessFixture';

const props = {
  modId: 'vault / admin',
  settingsUrl: './ModSettingsAccessFixture',
  agents: [],
  onAgentsChanged: async () => {},
  navigationTarget: null,
  overflowTarget: null,
};

afterEach(() => {
  cleanup();
  clearBasicCredentials();
  resetObservedContext();
  vi.unstubAllGlobals();
});

it('binds factory accessApi to the encoded current-mod access route without accepting a path', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetch);
  render(<ModSettingsHost {...props} />);
  await waitFor(() => expect(getObservedContext()).not.toBeNull());

  const context = getObservedContext()!;
  await context.accessApi({ method: 'POST', body: JSON.stringify({ grant: true }) });

  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0][0]).toBe('/api/operator/mods/vault%20%2F%20admin/access');
  expect(fetch.mock.calls[0][0]).not.toContain('/api/mods/');
  expect(context.accessApi.length).toBe(1);
  expect(context.api.length).toBe(2);
});

it('retains apiLocal authentication and structured errors for accessApi', async () => {
  setBasicCredentials('goblin', 'secret');
  const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'access denied', details: { reason: 'policy' } } }), {
    status: 403,
    headers: { 'content-type': 'application/json' },
  }));
  vi.stubGlobal('fetch', fetch);
  render(<ModSettingsHost {...props} modId="fixture" />);
  await waitFor(() => expect(getObservedContext()).not.toBeNull());

  await expect(getObservedContext()!.accessApi()).rejects.toMatchObject({
    message: 'access denied',
    status: 403,
    details: { reason: 'policy' },
  });

  const [path, init] = fetch.mock.calls[0] as [string, RequestInit];
  expect(path).toBe('/api/operator/mods/fixture/access');
  expect(new Headers(init.headers).get('authorization')).toBe('Basic Z29ibGluOnNlY3JldA==');
  expect(new Headers(init.headers).get('accept')).toBe('application/json');
});

function render(ui: Parameters<typeof baseRender>[0]) {
  return baseRender(ui, { wrapper: ConfirmProvider });
}
