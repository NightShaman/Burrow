import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadModArchives } from './modPanels';

describe('mod archive destinations', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('only exposes active same-mod archive assets', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, mods: [
      { id: 'lore-master', name: 'LoreMaster', status: 'active', version: '1.0', ui: { archiveUrl: '/api/mods/lore-master/ui/archive.js' } },
      { id: 'disabled', status: 'disabled', ui: { archiveUrl: '/api/mods/disabled/ui/archive.js' } },
      { id: 'failed', status: 'failed', ui: { archiveUrl: '/api/mods/failed/ui/archive.js' } },
      { id: 'unsafe', ui: { archiveUrl: '/api/mods/other/ui/archive.js' } },
    ] }), { headers: { 'content-type': 'application/json' } })));
    await expect(loadModArchives()).resolves.toEqual([{ modId: 'lore-master', name: 'LoreMaster', version: '1.0', archiveUrl: '/api/mods/lore-master/ui/archive.js' }]);
  });
});
