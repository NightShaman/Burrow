import { useEffect, useRef, useState } from 'react';
import { api, type OpenAiResetCredits } from '../../app/api';
import { useConfirm } from '../../app/ConfirmDialog';
import { formatResetIn } from './AccountStatus';

export function soonestReset(snapshot: OpenAiResetCredits | null, now = Date.now()) {
  if (!snapshot?.ok || snapshot.credits.availableCount <= 0) return null;
  return [...snapshot.credits.available]
    .filter(credit => !credit.expiresAt || Date.parse(credit.expiresAt) > now)
    .sort((a, b) => (a.expiresAt ? Date.parse(a.expiresAt) : Infinity) - (b.expiresAt ? Date.parse(b.expiresAt) : Infinity))[0] ?? null;
}

export function resetRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // LAN HTTP is not a secure context, but getRandomValues is available there.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

type ConsumeResult = { ok: boolean; code: 'reset' | 'nothing_to_reset' | 'already_redeemed'; usageRefresh?: { ok: boolean }; creditsRefresh?: OpenAiResetCredits };
// Keep uncertain operations locked across panel remounts for this browser session.
const uncertainAccounts = new Set<string>();

export function OpenAiResets({ connectionId, name, onUsageRefresh }: { connectionId: string; name: string; onUsageRefresh: () => void }) {
  const confirm = useConfirm();
  const [snapshot, setSnapshot] = useState<OpenAiResetCredits | null>(null);
  const [fetchError, setFetchError] = useState(false);
  const [busy, setBusy] = useState<'checking' | 'confirming' | 'consuming' | null>(null);
  const [message, setMessage] = useState('');
  const [uncertain, setUncertain] = useState(() => uncertainAccounts.has(connectionId));
  const [now, setNow] = useState(Date.now());
  const pending = useRef(false);
  const mounted = useRef(true);
  const path = `/api/openai/oauth/reset-credits?connectionId=${encodeURIComponent(connectionId)}`;
  const fetchCredits = async () => {
    const value = await api<OpenAiResetCredits>(path);
    if (!value?.ok || !Number.isInteger(value.credits?.availableCount) || !Array.isArray(value.credits?.available)) throw new Error('Invalid reset credits');
    return value;
  };

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    const load = async () => {
      if (pending.current) return;
      try {
        const value = await fetchCredits();
        if (!cancelled && !pending.current) { setSnapshot(value); setFetchError(false); }
      } catch { if (!cancelled && !pending.current) setFetchError(true); }
    };
    void load();
    const timer = window.setInterval(() => { setNow(Date.now()); void load(); }, 60_000);
    return () => { cancelled = true; mounted.current = false; window.clearInterval(timer); };
  }, [connectionId]);

  const useReset = async () => {
    if (pending.current || uncertainAccounts.has(connectionId)) return;
    pending.current = true;
    setBusy('checking'); setMessage('');
    let dispatched = false;
    try {
      const fresh = await fetchCredits();
      if (!mounted.current) return;
      setSnapshot(fresh); setFetchError(false);
      const credit = soonestReset(fresh);
      if (!credit) { setMessage('No available reset. Availability refreshed.'); return; }
      setBusy('confirming');
      const accepted = await confirm({ title: `Use reset for ${name}?`, message: `Consume one banked reset${credit.expiresAt ? ` expiring ${new Date(credit.expiresAt).toLocaleString()}` : ' (expiry not reported)'}. This cannot be undone.`, confirmLabel: 'Consume one reset', tone: 'danger' });
      if (!accepted || !mounted.current) return;
      if (credit.expiresAt && Date.parse(credit.expiresAt) <= Date.now()) { setMessage('That reset expired. Check availability again.'); return; }
      setBusy('consuming');
      const requestId = resetRequestId();
      dispatched = true;
      uncertainAccounts.add(connectionId);
      const result = await api<ConsumeResult>('/api/openai/oauth/reset-credits/consume', { method: 'POST', body: JSON.stringify({ connectionId, creditId: credit.id, requestId }) });
      if (!result.ok) throw new Error('Reset outcome unknown');
      uncertainAccounts.delete(connectionId);
      if (!mounted.current) return;
      const refreshed = result.creditsRefresh;
      if (refreshed?.ok) { setSnapshot(refreshed); setFetchError(false); }
      else { setSnapshot(null); setFetchError(true); }
      const outcome = result.code === 'nothing_to_reset' ? 'Nothing to reset.' : result.code === 'already_redeemed' ? 'Reset already redeemed.' : 'Reset used.';
      setMessage(`${outcome}${!result.usageRefresh?.ok ? ' Usage refresh failed.' : ''}${!refreshed?.ok ? ' Reset availability refresh failed.' : ''}`);
      onUsageRefresh();
    } catch (error) {
      if (!mounted.current) {
        if (dispatched) uncertainAccounts.add(connectionId);
        return;
      }
      if (!dispatched) { setFetchError(true); setMessage('Could not check reset availability. No reset sent.'); }
      else {
        const failure = error as Error & { status?: number; details?: unknown };
        let details: { ambiguous?: boolean } = {};
        try { details = typeof failure.details === 'string' ? JSON.parse(failure.details) : failure.details ?? {}; } catch { /* Unknown response is ambiguous. */ }
        const ambiguous = details.ambiguous === true || !failure.status || failure.status >= 500 || failure.status === 408 || failure.message.includes('outcome_unknown');
        if (ambiguous) {
          uncertainAccounts.add(connectionId); setUncertain(true);
          setMessage('Reset outcome unknown. Do not retry; verify account usage and reset history first.');
        } else { uncertainAccounts.delete(connectionId); setMessage(failure.message.includes('unavailable') ? 'Reset no longer available. Availability will refresh.' : 'Reset rejected. No reset confirmed.'); }
        setSnapshot(null); setFetchError(true);
        onUsageRefresh();
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy(null);
    }
  };

  const stale = !snapshot || !Number.isFinite(Date.parse(snapshot.fetchedAt)) || now - Date.parse(snapshot.fetchedAt) > 120_000;
  const expired = snapshot?.credits.nearestExpiresAt && Date.parse(snapshot.credits.nearestExpiresAt) <= now;
  const known = snapshot && !fetchError && !stale && !expired;
  const credit = soonestReset(snapshot, now);
  return <div className="account-resets" aria-busy={!!busy}>
    <div className="account-resets-row">
      <span className="account-resets-summary" title={known && snapshot.credits.nearestExpiresAt ? `Earliest expiry: ${new Date(snapshot.credits.nearestExpiresAt).toLocaleString()}` : undefined}>
        <span>{known ? `${snapshot.credits.availableCount} banked` : fetchError ? 'Resets unavailable' : snapshot ? 'Resets stale' : 'Resets checking…'}</span>
        {known && snapshot.credits.availableCount > 0 && <small>{snapshot.credits.nearestExpiresAt ? `expires ${formatResetIn(snapshot.credits.nearestExpiresAt, now)}` : 'expiry unknown'}</small>}
      </span>
      <button type="button" className="secondary" disabled={!!busy || uncertain || (!!known && !credit)} onClick={() => void useReset()}>{busy === 'checking' ? 'Checking…' : busy === 'consuming' ? 'Using…' : 'Use reset…'}</button>
    </div>
    {(message || uncertain) && <small className="account-reset-message" role="status">{message || 'Reset outcome unknown. Do not retry; verify account usage and reset history first.'}</small>}
  </div>;
}
