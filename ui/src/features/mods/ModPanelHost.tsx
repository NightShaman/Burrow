import { useEffect, useRef, useState } from 'react';
import { api } from '../../app/api';
import type { ModPanel } from '../../app/modPanels';

type Cleanup = void | (() => void) | { unmount: () => void };
type ControlModule = { mountControl?: (context: { modId: string; root: HTMLElement; api: <T = unknown>(path: string, init?: RequestInit) => Promise<T> }) => Cleanup | Promise<Cleanup> };

export function ModPanelHost({ panel }: { panel: ModPanel }) {
  const root = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let disposed = false;
    let cleanup: (() => void) | undefined;
    const node = root.current;
    if (!node) return;
    const timer = window.setTimeout(() => { if (!disposed) { disposed = true; setLoading(false); setError('The mod panel took too long to load.'); } }, 15000);
    setError(''); setLoading(true);
    const url = panel.controlUrl + (panel.version ? `?v=${encodeURIComponent(panel.version)}` : '');
    void import(/* @vite-ignore */ url).then(async (module: ControlModule) => {
      if (disposed) return;
      if (typeof module.mountControl !== 'function') throw new Error('The mod does not export mountControl.');
      const result = await module.mountControl({ modId: panel.modId, root: node, api: <T,>(path: string, init?: RequestInit) => {
        const normalized = path.startsWith('/') ? path : `/${path}`;
        if (normalized.includes('..') || normalized.includes('?') || normalized.includes('#')) return Promise.reject(new Error('Invalid mod API path.'));
        return api<T>(`/api/mods/${panel.modId}${normalized}`, init);
      } });
      const dispose = typeof result === 'function' ? result : result?.unmount;
      if (disposed) { dispose?.(); node.replaceChildren(); } else { cleanup = dispose; window.clearTimeout(timer); setLoading(false); }
    }).catch((cause) => { if (!disposed) { window.clearTimeout(timer); setLoading(false); setError(cause instanceof Error ? cause.message : 'Could not load mod panel.'); } });
    return () => { disposed = true; window.clearTimeout(timer); cleanup?.(); node.replaceChildren(); };
  }, [panel.modId, panel.controlUrl, panel.version]);
  return <div className="page-view mod-panel-page" data-mod-id={panel.modId}>
    {loading && !error && <p role="status">Loading {panel.name}…</p>}
    {error && <section className="setting-section"><h2>{panel.name} unavailable</h2><p role="alert">{error}</p></section>}
    <div ref={root} />
  </div>;
}
