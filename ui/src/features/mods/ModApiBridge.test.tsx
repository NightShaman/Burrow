import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModPanelHost } from './ModPanelHost';
import { ModArchiveHost } from './ModArchiveHost';

const { mountControl, mountArchive, api, apiLocal } = vi.hoisted(() => ({
  mountControl: vi.fn(),
  mountArchive: vi.fn(),
  api: vi.fn(),
  apiLocal: vi.fn(),
}));
vi.mock('./ModPanelLifecycleFixture', () => ({ mountControl, mountArchive }));
vi.mock('../../app/api', () => ({ api, apiLocal }));

afterEach(async () => {
  cleanup();
  await act(async () => {
    await vi.dynamicImportSettled();
  });
  vi.resetAllMocks();
});

describe.each(['main', 'archive'] as const)('%s mod API bridge', (host) => {
  async function bridge(modId = 'burrow-menagerie') {
    const mount = host === 'main' ? mountControl : mountArchive;
    const client = host === 'main' ? api : apiLocal;
    const otherClient = host === 'main' ? apiLocal : api;
    const panel = { modId, name: 'Menagerie' };
    if (host === 'main')
      render(<ModPanelHost panel={{ ...panel, controlUrl: './ModPanelLifecycleFixture' }} />);
    else
      render(
        <ModArchiveHost
          panel={{ ...panel, archiveUrl: './ModPanelLifecycleFixture' }}
          date="2026-11-09"
        />,
      );
    await waitFor(() => expect(mount).toHaveBeenCalledTimes(1));
    const context = mount.mock.calls[0][0] as {
      api: (path: string, init?: RequestInit) => Promise<unknown>;
    };
    return { request: context.api, client, otherClient };
  }

  it.each([
    ['/visit-log?agentId=ratchet', '/visit-log?agentId=ratchet'],
    [
      'visit-log?agentId=ratchet&limit=10&offset=20',
      '/visit-log?agentId=ratchet&limit=10&offset=20',
    ],
    [
      '/visit-log?agentId=ratchet&cursor=a%2Fb%2Bc%3D%26x%3Fy%23z',
      '/visit-log?agentId=ratchet&cursor=a%2Fb%2Bc%3D%26x%3Fy%23z',
    ],
    [
      '/visit-log?search=hello..%2e%2f%5c&label=Ratchet+%26+friends',
      '/visit-log?search=hello..%2e%2f%5c&label=Ratchet+%26+friends',
    ],
    ['/residents', '/residents'],
    ['', '/'],
  ])('forwards %s unchanged under the declaring mod namespace', async (path, expected) => {
    const { request, client, otherClient } = await bridge();
    const response = { ok: true, visits: [{ id: 'existing-visit' }] };
    client.mockResolvedValue(response);
    const init = { method: 'GET', signal: new AbortController().signal };
    await expect(request(path, init)).resolves.toBe(response);
    expect(client).toHaveBeenCalledExactlyOnceWith(`/api/mods/burrow-menagerie${expected}`, init);
    expect(otherClient).not.toHaveBeenCalled();
  });

  it.each([
    '/../secret',
    '/visit-log/../../other-mod',
    '/%2e%2e/secret?agentId=ratchet',
    '/%2E%2E/secret',
    '/archive%2fgifts',
    '/archive%2Fgifts',
    '/archive%5csecret',
    '/archive\\secret',
    '/visit-log#fragment',
    '/visit-log?agentId=ratchet#fragment',
  ])('rejects invalid path %s before calling either API client', async (path) => {
    const { request } = await bridge();
    await expect(request(path)).rejects.toThrow('Invalid mod API path.');
    expect(api).not.toHaveBeenCalled();
    expect(apiLocal).not.toHaveBeenCalled();
  });

  it('cannot turn an absolute URL or API-looking path into an unscoped request', async () => {
    const { request, client } = await bridge('other-mod');
    await request('https://example.test/visit-log?agentId=ratchet');
    await request('/api/mods/burrow-menagerie/visit-log?agentId=ratchet');
    expect(client.mock.calls.map(([path]) => path)).toEqual([
      '/api/mods/other-mod/https://example.test/visit-log?agentId=ratchet',
      '/api/mods/other-mod/api/mods/burrow-menagerie/visit-log?agentId=ratchet',
    ]);
  });
});
