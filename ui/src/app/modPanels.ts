import { apiLocal } from './api';

export type ModPanel = { modId: string; name: string; controlUrl: string; version?: string };
export const modsChangedEvent = 'burrow:mods-changed';

export async function loadModPanels(): Promise<ModPanel[]> {
  const catalog = await apiLocal<{ mods?: Array<{ id?: unknown; name?: unknown; status?: unknown; version?: unknown; ui?: { controlUrl?: unknown } }> }>('/api/mods');
  return (catalog.mods ?? []).flatMap((mod) => {
    if (typeof mod.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(mod.id) || mod.status === 'disabled' || mod.status === 'failed') return [];
    const url = mod.ui?.controlUrl;
    if (typeof url !== 'string' || !url.startsWith(`/api/mods/${mod.id}/`) || url.includes('?') || url.includes('#') || url.split('/').includes('..')) return [];
    return [{ modId: mod.id, name: typeof mod.name === 'string' && mod.name.trim() ? mod.name.trim() : mod.id, controlUrl: url, ...(typeof mod.version === 'string' ? { version: mod.version } : {}) }];
  });
}
