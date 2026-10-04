import { useEffect, useRef } from 'react';
import { clientBudgets } from './clientBudgets';

export type IsPollingCancelled = () => boolean;
export type PollRefresh = (isCancelled: IsPollingCancelled, signal: AbortSignal) => void | Promise<void>;

/** Runs the latest asynchronous refresh work immediately and on an interval without overlapping requests. */
export function usePolling(refresh: PollRefresh, intervalMs: number, enabled = true, restartKey?: string, deadlineMs = clientBudgets.requestDeadlineMs) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let refreshInFlight = false;
    let activeAbort: AbortController | null = null;
    const isCancelled = () => cancelled;
    const poll = () => {
      if (cancelled || refreshInFlight) return;
      refreshInFlight = true;
      const controller = new AbortController();
      activeAbort = controller;
      const deadline = window.setTimeout(() => controller.abort(), Math.max(1, deadlineMs));
      Promise.resolve()
        .then(() => refreshRef.current(isCancelled, controller.signal))
        .catch(() => {
          // Individual refreshers own domain-specific failure behavior.
        })
        .finally(() => { window.clearTimeout(deadline); if (activeAbort === controller) activeAbort = null; refreshInFlight = false; });
    };

    poll();
    const interval = window.setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      activeAbort?.abort();
      window.clearInterval(interval);
    };
  }, [enabled, intervalMs, restartKey, deadlineMs]);
}
