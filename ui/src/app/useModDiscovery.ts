import { useEffect, useState } from 'react';
import { loadModDiscovery, modsChangedEvent } from './modPanels';

/** Owns discovery requests, freshness ordering, polling and listener lifetime. */
export function useModDiscovery() {
  const [catalog, setCatalog] = useState<Awaited<ReturnType<typeof loadModDiscovery>>>({
    modPanels: [],
    modArchives: [],
  });
  const [modsLoaded, setModsLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    let request: AbortController | undefined;
    const refresh = () => {
      request?.abort();
      const current = (request = new AbortController());
      void loadModDiscovery(current.signal)
        .then((result) => {
          if (live && !current.signal.aborted) {
            setCatalog(result);
            setModsLoaded(true);
          }
        })
        .catch(() => {
          if (live && !current.signal.aborted) {
            setModsLoaded(true);
          }
        });
    };
    refresh();
    window.addEventListener(modsChangedEvent, refresh);
    const interval = window.setInterval(refresh, 30000);
    return () => {
      live = false;
      request?.abort();
      window.removeEventListener(modsChangedEvent, refresh);
      window.clearInterval(interval);
    };
  }, []);
  return { ...catalog, modsLoaded };
}
