import { useEffect, useRef, useState } from 'react';
import { apiLocal as api } from '../../app/api';
import type { ModArchive } from '../../app/modPanels';

type ArchiveContext = { date: string; modId: string; runtimeScope: 'local'; root: HTMLElement; api: <T = unknown>(path: string, init?: RequestInit) => Promise<T> };
type Cleanup = void | (() => void) | { unmount?: () => void; update?: (context: ArchiveContext) => void };
type ArchiveModule = { mountArchive?: (context: ArchiveContext) => Cleanup | Promise<Cleanup> };

export function ModArchiveHost({ panel, date }: { panel: ModArchive; date: string }) {
  const root = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const dateRef = useRef(date);
  dateRef.current = date;
  const updateRef = useRef<(() => void) | undefined>(undefined);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    const host = root.current;
    if (!host) return;
    // A late async mount must never clear a newer mount's DOM.
    const node = document.createElement('div');
    host.replaceChildren(node);
    const timer = window.setTimeout(() => { if (!disposed) { disposed = true; setLoading(false); setError('The mod panel took too long to load.'); } }, 15000);
    setError(''); setLoading(true);
    const url = panel.archiveUrl + (panel.version ? `?v=${encodeURIComponent(panel.version)}` : '');
    void import(/* @vite-ignore */ url).then(async (module: ArchiveModule) => {
      if (disposed) return;
      if (typeof module.mountArchive !== 'function') throw new Error('The mod does not export mountArchive.');
      const context: ArchiveContext = { date: dateRef.current, modId: panel.modId, runtimeScope: 'local', root: node, api: <T,>(path: string, init?: RequestInit) => {
        const normalized = path.startsWith('/') ? path : `/${path}`;
        if (normalized.includes('..') || normalized.includes('#') || normalized.includes('\\') || /%2e|%2f|%5c/i.test(normalized.split('?')[0])) return Promise.reject(new Error('Invalid mod API path.'));
        return api<T>(`/api/mods/${panel.modId}${normalized}`, init);
      } };
      const result = await module.mountArchive(context);
      const dispose = typeof result === 'function' ? result : result?.unmount;
      if (disposed) { dispose?.(); node.replaceChildren(); } else {
        cleanup = dispose;
        updateRef.current = () => {
          if (disposed || context.date === dateRef.current) return;
          context.date = dateRef.current;
          if (result && typeof result !== 'function' && result.update) {
            try { result.update({ ...context }); }
            catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update mod panel.'); }
          } else setRevision(value => value + 1); // Legacy mounts still receive fresh date context.
        };
        window.clearTimeout(timer); setLoading(false);
        updateRef.current(); // Catch date changes while import/mount was pending.
      }
    }).catch((cause) => { if (!disposed) { window.clearTimeout(timer); setLoading(false); node.replaceChildren(); setError(cause instanceof Error ? cause.message : 'Could not load mod panel.'); } });
    return () => { disposed = true; updateRef.current = undefined; window.clearTimeout(timer); try { cleanup?.(); } catch { /* A mod cleanup must not break Archive navigation. */ } finally { node.replaceChildren(); } };
  }, [panel.modId, panel.archiveUrl, panel.version, revision]);
  useEffect(() => { updateRef.current?.(); }, [date]);
  return <div className="page-view mod-panel-page" data-mod-id={panel.modId}>
    {loading && !error && <p role="status">Loading {panel.name}…</p>}
    {error && <section className="setting-section"><h2>{panel.name} unavailable</h2><p role="alert">{error}</p></section>}
    <div ref={root} />
  </div>;
}
