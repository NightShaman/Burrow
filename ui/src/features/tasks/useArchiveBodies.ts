import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { archiveTurnId } from './archiveTurns';
import type { SessionTurn } from '../../app/api';

type Anchor = { node: HTMLElement; offset: number } | 'bottom' | null;
const latestBuffer = 3;
const batchSize = 3;

// Keep every completed body mounted. Only new bodies are scheduled in small batches per
// paint opportunity: a single enormous Markdown message is still synchronous.
export function useArchiveBodies(turns: SessionTurn[], scope: string, reader: RefObject<HTMLDivElement | null>) {
  const [completed, setCompleted] = useState<Set<SessionTurn>>(() => new Set());
  const anchor = useRef<Anchor>('bottom');
  const visible = useRef(new Set<number>());
  const programmaticTop = useRef(false);
  const state = useRef({ scope, turns: [] as SessionTurn[] });
  const initial = state.current.scope !== scope || !state.current.turns.length;
  const ready = new Set(initial ? [] : turns.filter(turn => completed.has(turn)));
  if (initial) turns.slice(-latestBuffer).forEach(turn => ready.add(turn));

  const remember = () => {
    const root = reader.current;
    if (!root) return;
    if (root.scrollHeight - root.clientHeight - root.scrollTop < 2) { anchor.current = 'bottom'; return; }
    const top = root.getBoundingClientRect().top;
    const rows = root.querySelectorAll<HTMLElement>('.archive-turn');
    let low = 0, high = rows.length;
    while (low < high) { const middle = (low + high) >>> 1; if (rows[middle].getBoundingClientRect().bottom <= top) low = middle + 1; else high = middle; }
    const row = rows[low];
    anchor.current = row ? { node: row, offset: row.getBoundingClientRect().top - top } : null;
  };
  const restore = () => {
    const root = reader.current;
    if (!root) return;
    const saved = anchor.current;
    const delta = saved === 'bottom' ? root.scrollHeight - root.clientHeight - root.scrollTop : saved?.node.isConnected ? saved.node.getBoundingClientRect().top - root.getBoundingClientRect().top - saved.offset : 0;
    if (Math.abs(delta) > 0.5) { root.scrollTop += delta; programmaticTop.current = true; }
  };
  const actions = useRef({ remember, restore });
  actions.current = { remember, restore };

  useLayoutEffect(() => {
    if (state.current.scope !== scope || !turns.length) {
      anchor.current = 'bottom';
    }
    state.current = { scope, turns };
    actions.current.restore();
    // Observing rows, not just the scroller, catches tables and late images
    // above the anchor even after all deferred work has finished.
    const root = reader.current;
    if (!root) return;
    const onScroll = () => {
      if (programmaticTop.current) { programmaticTop.current = false; return; }
      actions.current.remember();
    };
    root.addEventListener('scroll', onScroll, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => actions.current.restore());
    visible.current.clear();
    const viewport = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(entries => {
      entries.forEach(entry => { const index = Number((entry.target as HTMLElement).dataset.turnId); if (entry.isIntersecting) visible.current.add(index); else visible.current.delete(index); });
    }, { root, rootMargin: '300px' });
    root.querySelectorAll('.archive-turn').forEach(row => { observer?.observe(row); viewport?.observe(row); });
    return () => { root.removeEventListener('scroll', onScroll); observer?.disconnect(); viewport?.disconnect(); };
  }, [turns, scope, reader]);


  useLayoutEffect(() => {
    let cancelled = false;
    let frame = 0;
    let timer = 0;
    const done = new Set(ready);
    const pending = turns.filter(turn => !done.has(turn));
    if (!pending.length) {
      if (ready.size && completed.size !== ready.size) setCompleted(new Set(ready));
      return;
    }
    const next = () => {
      if (cancelled) return;
      // IntersectionObserver supplies viewport priorities after layout without
      // forcing a synchronous layout walk through accumulated history per batch.
      let chosen = turns.find(turn => visible.current.has(archiveTurnId(turn)) && !done.has(turn));
      chosen ??= pending.find(turn => !done.has(turn));
      if (!chosen) return;
      done.add(chosen);
      // Small bounded batches amortize React's walk over already-mounted rows.
      const start = turns.indexOf(chosen);
      for (let i = start + 1; i < turns.length && i < start + batchSize; i++) done.add(turns[i]);
      // Preserve the existing anchor; ResizeObserver also covers late media.
      setCompleted(new Set(done));
      if (done.size < turns.length) schedule();
    };
    const schedule = () => {
      frame = requestAnimationFrame(() => { timer = window.setTimeout(next, 0); });
    };
    schedule();
    return () => { cancelled = true; cancelAnimationFrame(frame); window.clearTimeout(timer); };
    // Each page/scope owns one queue; completed state must not restart it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, scope, reader]);

  return { ready, remember, pending: turns.some(turn => !ready.has(turn)) };
}
