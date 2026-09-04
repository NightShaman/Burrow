import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadApiTargetContributions, loadApiTargets, normalizeApiTarget, ownedResourceId, parseOwnedResourceId, targetForResource } from './apiTargets';

describe('API target contributions', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('validates the minimal v1 target shape', () => {
    expect(normalizeApiTarget({ id: 'node-1', name: 'Node One', baseUrl: 'http://node-one:8787/', enabled: true })).toEqual({ id: 'node-1', name: 'Node One', baseUrl: 'http://node-one:8787', enabled: true });
    expect(normalizeApiTarget({ id: 'bad', name: 'Bad', baseUrl: 'file:///tmp', enabled: true })).toBeNull();
    expect(normalizeApiTarget({ id: 'node', name: 'Node', baseUrl: 'http://node', enabled: 'yes' })).toBeNull();
  });

  it('loads enabled targets from a mod contribution endpoint', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, mods: [{ id: 'node-goblin', contributions: { apiTargets: '/api/mods/node-goblin/targets' } }] }), { headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, targets: [
        { id: 'node-1', name: 'Node One', baseUrl: 'http://node-one:8787', enabled: true },
        { id: 'node-2', name: 'Node Two', baseUrl: 'http://node-two:8787', enabled: false },
      ] }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadApiTargets()).resolves.toEqual([
      { id: 'local', name: 'Local', baseUrl: '', enabled: true },
      { id: 'node-1', name: 'Node One', baseUrl: 'http://node-one:8787', enabled: true },
    ]);
  });

  it('discovers host-managed target settings from scoped contribution endpoints', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, mods: [
      { id: 'node-goblin', name: 'Node Goblin', contributions: { apiTargets: '/api/mods/node-goblin/targets' } },
      { id: 'unsafe', name: 'Unsafe', contributions: { apiTargets: '/api/mods/other/targets' } },
    ] }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadApiTargetContributions()).resolves.toEqual([
      { modId: 'node-goblin', name: 'Node Goblin', endpoint: '/api/mods/node-goblin/targets' },
    ]);
  });

  it('discovers scoped mod settings assets without requiring an API targets contribution', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, mods: [
      { id: 'node-goblin', name: 'Node Goblin', contributions: { settings: [{ id: 'operations', navigation: { title: 'Node Goblin' }, primary: { title: 'Operations', capability: 'settingsUi' } }] }, ui: { settingsUrl: '/api/mods/node-goblin/ui/settings.js' } },
      { id: 'unsafe', name: 'Unsafe', ui: { settingsUrl: '/api/mods/other/ui/settings.js' } },
    ] }), { headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);

    await expect(loadApiTargetContributions()).resolves.toEqual([
      {
        modId: 'node-goblin',
        name: 'Node Goblin',
        settingsUrl: '/api/mods/node-goblin/ui/settings.js',
        settings: [{ id: 'operations', navigation: { title: 'Node Goblin' }, primary: { title: 'Operations', capability: 'settingsUi' } }],
      },
    ]);
  });

  it('namespaces remote resources and resolves their owner without changing local IDs', () => {
    const targets = [
      { id: 'local', name: 'Local', baseUrl: '', enabled: true },
      { id: 'node-1', name: 'Node One', baseUrl: 'http://node-one:8787', enabled: true },
    ];
    expect(ownedResourceId('local', 'smatchet')).toBe('smatchet');
    expect(ownedResourceId('node-1', 'smatchet')).toBe('node-1::smatchet');
    expect(parseOwnedResourceId('node-1::smatchet')).toEqual({ targetId: 'node-1', resourceId: 'smatchet' });
    expect(targetForResource(targets, 'node-1::smatchet')).toEqual({ target: targets[1], resourceId: 'smatchet' });
  });
});
