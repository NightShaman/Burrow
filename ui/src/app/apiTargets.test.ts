import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadModSettingsContributions } from './apiTargets';

describe('runtime and mod boundaries', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('loads only explicit same-host Node Goblin settings and rejects foreign-origin contribution URLs', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          mods: [
            {
              id: 'node-goblin',
              name: 'Node Goblin',
              contributions: {
                settings: [
                  {
                    id: 'operations',
                    navigation: { title: 'Node Goblin' },
                    primary: { title: 'Operations', capability: 'settingsUi' },
                  },
                ],
              },
              ui: { settingsUrl: '/api/mods/node-goblin/ui/settings.js' },
            },
            {
              id: 'unsafe',
              ui: { settingsUrl: 'https://remote.example/api/mods/unsafe/ui/settings.js' },
            },
          ],
        }),
        { headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(loadModSettingsContributions()).resolves.toEqual([
      {
        modId: 'node-goblin',
        name: 'Node Goblin',
        settingsUrl: '/api/mods/node-goblin/ui/settings.js',
        settings: [
          {
            id: 'operations',
            navigation: { title: 'Node Goblin' },
            primary: { title: 'Operations', capability: 'settingsUi' },
          },
        ],
      },
    ]);
    expect(fetchMock).toHaveBeenCalledWith('/api/mods', expect.any(Object));
  });
  it('rejects catalog outages rather than returning an empty success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            ok: false,
            error: 'catalog_unavailable',
            message: 'Mod discovery failed.',
          }),
          { status: 503, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    await expect(loadModSettingsContributions()).rejects.toMatchObject({
      message: 'Mod discovery failed.',
      code: 'catalog_unavailable',
      status: 503,
    });
  });
  it('distinguishes an empty catalog from a malformed catalog', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true, mods: [] }), {
            headers: { 'content-type': 'application/json' },
          }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: true }), {
            headers: { 'content-type': 'application/json' },
          }),
        ),
    );
    await expect(loadModSettingsContributions()).resolves.toEqual([]);
    await expect(loadModSettingsContributions()).rejects.toThrow('Invalid mod catalog response.');
  });
});
