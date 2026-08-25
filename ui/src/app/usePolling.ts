import { useEffect, useRef } from 'react';

export type IsPollingCancelled = () => boolean;

/** Runs the latest asynchronous refresh work immediately and on an interval without overlapping requests. */
export function usePolling(refresh: (isCancelled: IsPollingCancelled) => void | Promise<void>, intervalMs: number, enabled = true, restartKey?: string) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    if (!enabled) return;

    let cancelled = false;
    let refreshInFlight = false;
    const isCancelled = () => cancelled;
    const poll = () => {
      if (cancelled || refreshInFlight) return;
      refreshInFlight = true;
      Promise.resolve()
        .then(() => refreshRef.current(isCancelled))
        .catch(() => {
          // Individual refreshers own domain-specific failure behavior.
        })
        .finally(() => { refreshInFlight = false; });
    };

    poll();
    const interval = window.setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [enabled, intervalMs, restartKey]);
}
