import { useEffect, useState } from 'react';
import { loadModPanels, modsChangedEvent, type ModPanel } from './modPanels';

/** Owns discovery requests, freshness ordering, polling and listener lifetime. */
export function useModDiscovery() {
  const [modPanels, setModPanels] = useState<ModPanel[]>([]);
  const [modsLoaded, setModsLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    let sequence = 0;
    const refresh = () => {
      const current = ++sequence;
      void loadModPanels()
        .then((panels) => {
          if (live && current === sequence) {
            setModPanels(panels);
            setModsLoaded(true);
          }
        })
        .catch(() => {
          if (live && current === sequence) {
            setModPanels([]);
            setModsLoaded(true);
          }
        });
    };
    refresh();
    window.addEventListener(modsChangedEvent, refresh);
    const interval = window.setInterval(refresh, 30000);
    return () => {
      live = false;
      window.removeEventListener(modsChangedEvent, refresh);
      window.clearInterval(interval);
    };
  }, []);
  return { modPanels, modsLoaded };
}
