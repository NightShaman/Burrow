import { useEffect, useMemo } from 'react';
import { api, fetchApi } from './api';

export function localRuntimeKey(available = true) { return available ? 'local' : 'unavailable'; }
/** Captures a mounted local resource owner and cancels/fences its requests on unmount. */
export function useOwnedApi(available = true) {
 const owner = useMemo(() => ({ available, retired: false, abort: new AbortController() }), []);
 useEffect(() => { owner.retired = false; if (owner.abort.signal.aborted) owner.abort = new AbortController(); return () => { owner.retired = true; owner.abort.abort(); }; }, [owner]);
 function check() { if (owner.retired || !owner.available) throw new Error('Local runtime unavailable'); }
 return useMemo(() => ({
  api: async <T,>(path: string, init: RequestInit = {}): Promise<T> => { check(); const result = await api<T>(path, { ...init, signal: init.signal ? AbortSignal.any([init.signal, owner.abort.signal]) : owner.abort.signal }); check(); return result; },
  fetch: async (path: string, init: RequestInit = {}) => { check(); const result = await fetchApi(path, { ...init, signal: init.signal ? AbortSignal.any([init.signal, owner.abort.signal]) : owner.abort.signal }); check(); return result; },
 }), [owner]);
}
