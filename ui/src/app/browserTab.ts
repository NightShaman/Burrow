import { useEffect } from 'react';
import { api } from './api';
export const browserTabChanged = 'burrow:browser-tab-changed';
export const browserTabTitle = (suffix: string) => suffix.trim() ? `Burrow — ${suffix.trim()}` : 'Burrow';
export function useBrowserTabTitle() {
  useEffect(() => {
    let live = true;
    let generation = 0;
    const refresh = () => {
      const current = ++generation;
      void api<{ suffix: string }>('/api/settings/browser-tab').then(result => {
        if (live && current === generation) document.title = browserTabTitle(result.suffix);
      }).catch(() => {});
    };
    const changed = (event: Event) => {
      ++generation;
      document.title = browserTabTitle((event as CustomEvent<string>).detail);
    };
    refresh();
    window.addEventListener(browserTabChanged, changed);
    window.addEventListener('focus', refresh);
    return () => { live = false; window.removeEventListener(browserTabChanged, changed); window.removeEventListener('focus', refresh); };
  }, []);
}
