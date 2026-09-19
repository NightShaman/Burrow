import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadModPanels } from './modPanels';

describe('mod control destinations', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('only exposes active same-mod control assets', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, mods: [
      { id: 'lore-master', name: 'LoreMaster', status: 'active', version: '1.0', ui: { controlUrl: '/api/mods/lore-master/ui/control.js' } },
      { id: 'disabled', status: 'disabled', ui: { controlUrl: '/api/mods/disabled/ui/control.js' } },
      { id: 'failed', status: 'failed', ui: { controlUrl: '/api/mods/failed/ui/control.js' } },
      { id: 'unsafe', ui: { controlUrl: '/api/mods/other/ui/control.js' } },
    ] }), { headers: { 'content-type': 'application/json' } })));
    await expect(loadModPanels()).resolves.toEqual([{ modId: 'lore-master', name: 'LoreMaster', version: '1.0', controlUrl: '/api/mods/lore-master/ui/control.js' }]);
  });
});
