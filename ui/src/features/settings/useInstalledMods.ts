import { useEffect, useState } from 'react';
import { modLifecyclePath, type ModRecord } from './modManagementApi';

export function useInstalledMods(
  mods: ModRecord[],
  run: (key: string, path: string, init?: RequestInit) => Promise<boolean>,
) {
  const [selectedModId, setSelectedModId] = useState<string | null>(null);
  useEffect(() => {
    if (!mods.some((mod) => mod.id === selectedModId)) setSelectedModId(mods[0]?.id ?? null);
  }, [mods, selectedModId]);
  const selectedMod = mods.find((mod) => mod.id === selectedModId) ?? null;
  const install = (mod: ModRecord) => {
    void run(mod.id, modLifecyclePath(mod.id, 'install'), {
      method: 'POST',
      body: JSON.stringify({}),
    });
  };
  const lifecycle = (mod: ModRecord, action: 'uninstall' | 'enable' | 'disable') => {
    void run(mod.id, modLifecyclePath(mod.id, action), { method: 'POST' });
  };

  return { selectedModId, setSelectedModId, selectedMod, install, lifecycle };
}
