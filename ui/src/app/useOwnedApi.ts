import { useEffect, useMemo } from 'react';
import { apiForTarget, fetchApiForTarget } from './api';
import type { ApiTarget } from './apiTargets';

export function targetOwnerKey(target: ApiTarget | null | undefined) {
  return JSON.stringify(target ? [target.id, target.baseUrl, target.enabled] : ['unavailable']);
}

/** A mounted owner never consults the mutable global selection. Cleanup also
 * fences confirmations and follow-up requests from the retired owner. */
export function useOwnedApi(target: ApiTarget | null | undefined) {
  const owner = useMemo(() => ({ target: target && { ...target }, retired: false, abort: new AbortController() }), []);
  useEffect(() => {
    owner.retired = false;
    if (owner.abort.signal.aborted) owner.abort = new AbortController();
    return () => { owner.retired = true; owner.abort.abort(); };
  }, [owner]);
  function check() {
    if (owner.retired || !owner.target?.enabled || (owner.target.id !== 'local' && !owner.target.baseUrl)) throw new Error('Runtime owner unavailable');
  }
  return useMemo(() => ({
    api: async <T,>(path: string, init: RequestInit = {}): Promise<T> => {
      check();
      const result = await apiForTarget<T>(owner.target ?? undefined, path, { ...init, signal: init.signal ? AbortSignal.any([init.signal, owner.abort.signal]) : owner.abort.signal });
      check(); return result;
    },
    fetch: async (path: string, init: RequestInit = {}) => {
      check();
      const result = await fetchApiForTarget(owner.target ?? undefined, path, { ...init, signal: init.signal ? AbortSignal.any([init.signal, owner.abort.signal]) : owner.abort.signal });
      check(); return result;
    },
  }), [owner]);
}
