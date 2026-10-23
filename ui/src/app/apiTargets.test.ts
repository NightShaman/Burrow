import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadModSettingsContributions } from './apiTargets';

describe('runtime and mod boundaries', () => {
 afterEach(() => vi.unstubAllGlobals());
 it('loads only explicit same-host Node Goblin settings and rejects foreign-origin contribution URLs', async () => {
  const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, mods: [
   { id: 'node-goblin', name: 'Node Goblin', contributions: { settings: [{ id: 'operations', navigation: { title: 'Node Goblin' }, primary: { title: 'Operations', capability: 'settingsUi' } }] }, ui: { settingsUrl: '/api/mods/node-goblin/ui/settings.js' } },
   { id: 'unsafe', ui: { settingsUrl: 'https://remote.example/api/mods/unsafe/ui/settings.js' } },
  ] }), { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  await expect(loadModSettingsContributions()).resolves.toEqual([{ modId: 'node-goblin', name: 'Node Goblin', settingsUrl: '/api/mods/node-goblin/ui/settings.js', settings: [{ id: 'operations', navigation: { title: 'Node Goblin' }, primary: { title: 'Operations', capability: 'settingsUi' } }] }]);
  expect(fetchMock).toHaveBeenCalledWith('/api/mods', expect.any(Object));
 });

 it('groups repeated settings contribution rows into one mod without duplicate sections', async () => {
  const { groupModSettingsContributions } = await import('./apiTargets');
  const settings = [
   { id: 'status', navigation: { title: 'Switchboard' }, primary: { title: 'Status', capability: 'settingsUi' as const } },
   { id: 'configuration', navigation: { title: 'Switchboard' }, primary: { title: 'Configuration', capability: 'settingsUi' as const } },
  ];
  expect(groupModSettingsContributions(settings.flatMap((setting) => [
   { modId: 'burrow-switchboard', name: 'Switchboard', settingsUrl: '/api/mods/burrow-switchboard/ui/settings.js', settings: [setting] },
   { modId: 'burrow-switchboard', name: 'Switchboard', settings: [setting] },
  ]))).toEqual([{
   modId: 'burrow-switchboard',
   name: 'Switchboard',
   settingsUrl: '/api/mods/burrow-switchboard/ui/settings.js',
   settings,
  }]);
 });

});
