import { useState } from 'react';
import { api } from './api';
import { usePolling } from './usePolling';

export type ProviderPoolWindow = {
  requests: number; successes: number; failures: number; cancellations: number;
  attempts: number; retries: number;
  inputTokens: number | null; outputTokens: number | null; cachedTokens: number | null;
  cachePercent: number | null; errorPercent: number | null; durationMs: number;
  coverage: { inputAttempts: number; outputAttempts: number; cachedAttempts: number; cacheAttempts: number; cacheInputTokens: number | null };
};
export type ProviderPoolMetricsResponse = { ok: true; windows: Record<'24h' | '7d', ProviderPoolWindow> };
const count = (value: number | null | undefined) => value == null ? '—' : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
const percent = (value: number | null | undefined) => value == null ? '—' : `${new Intl.NumberFormat('en', { maximumFractionDigits: 1 }).format(value)}%`;

export function ProviderPoolMetrics() {
  const [windowKey, setWindowKey] = useState<'24h' | '7d'>('24h');
  const [metrics, setMetrics] = useState<ProviderPoolMetricsResponse | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  usePolling(async (isCancelled, signal) => {
    try {
      const next = await api<ProviderPoolMetricsResponse>('/api/metrics/provider-pools', { signal });
      if (!next?.windows?.['24h'] || !next.windows['7d']) throw new Error('Invalid pool metrics response');
      if (!isCancelled()) { setMetrics(next); setUnavailable(false); }
    } catch {
      if (!isCancelled()) { setMetrics(null); setUnavailable(true); }
    }
  }, 30_000);
  const current = metrics?.windows[windowKey];
  const tokens = current?.inputTokens != null && current.outputTokens != null ? current.inputTokens + current.outputTokens : null;
  const partialCache = current && current.coverage.cacheAttempts < current.attempts;
  const cacheTitle = current
    ? `Cached prompt tokens / input tokens on attempts reporting both. ${partialCache ? 'Partial cache coverage: ' : 'Cache coverage: '}${current.coverage.cacheAttempts} of ${current.attempts} attempts; missing cache usage is not treated as zero.`
    : 'Cache usage unavailable.';
  return <div className="pool-footer-metrics" role="group" aria-label="Native OpenAI load balancing metrics" title={unavailable ? 'Load balancing metrics unavailable; retrying automatically.' : undefined}>
    <span className="pool-footer-label">OpenAI LB</span>
    <select aria-label="Load balancing metrics window" value={windowKey} onChange={event => setWindowKey(event.target.value as '24h' | '7d')}><option value="24h">24h</option><option value="7d">7d</option></select>
    <span className="pool-footer-stat" title="Logical requests across native OpenAI load balancing pools.">Requests <strong>{count(current?.requests)}</strong></span>
    <span className="pool-footer-stat" title={current ? `Input: ${current.inputTokens?.toLocaleString('en') ?? 'unknown'}; output: ${current.outputTokens?.toLocaleString('en') ?? 'unknown'}. Total is input + output; cached tokens are already included in input. Coverage: input ${current.coverage.inputAttempts}/${current.attempts}, output ${current.coverage.outputAttempts}/${current.attempts} attempts.` : 'Token usage unavailable.'}>Tokens <strong>{count(tokens)}</strong></span>
    <span className="pool-footer-stat" tabIndex={0} title={cacheTitle} aria-label={`Prompt cached ${percent(current?.cachePercent)}. ${cacheTitle}`}>Prompt cached <strong>{percent(current?.cachePercent)}</strong></span>
    <span className="pool-footer-stat" title="Final failed logical requests / all logical requests, including cancellations in the denominator. Cancellations are not errors; a successful retry is a success.">Errors <strong>{percent(current?.errorPercent)}</strong></span>
  </div>;
}
