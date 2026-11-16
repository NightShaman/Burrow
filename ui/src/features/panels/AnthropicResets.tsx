import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, type AnthropicFullResets } from '../../app/api';
import { useConfirm } from '../../app/ConfirmDialog';
import { resetRequestId } from './OpenAiResets';

export function validFullResets(
  value: AnthropicFullResets | null | undefined,
): value is AnthropicFullResets {
  return (
    !!value &&
    Number.isSafeInteger(value.availableCount) &&
    value.availableCount >= 0 &&
    (value.nearestExpiresAt === null ||
      (typeof value.nearestExpiresAt === 'string' &&
        Number.isFinite(Date.parse(value.nearestExpiresAt))))
  );
}
const locks = new Set<string>();
const outcomes: Record<string, string> = {
  reset: 'Full reset used.',
  already_used: 'Full reset already used.',
  not_limited: 'Account is not limited.',
  cooldown: 'Reset is on cooldown.',
  ineligible: 'Account is ineligible for a Full reset.',
  unavailable: 'Full reset unavailable.',
  error: 'Reset rejected. No reset confirmed.',
};
function body(value: unknown): { code?: string; ambiguous?: boolean } {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}
export function AnthropicResets({
  connectionId,
  name,
  onUsageRefresh,
  children,
}: {
  children?: ReactNode;
  connectionId: string;
  name: string;
  onUsageRefresh: () => void;
}) {
  const confirm = useConfirm();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [locked, setLocked] = useState(() => locks.has(connectionId));
  const pending = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const inventory = async () => {
    const result = await api<{ ok: boolean; fullResets: AnthropicFullResets; fetchedAt: string }>(
      `/api/models/anthropic/reset-inventory?connectionId=${encodeURIComponent(connectionId)}`,
    );
    if (
      !result.ok ||
      !validFullResets(result.fullResets) ||
      !Number.isFinite(Date.parse(result.fetchedAt))
    )
      throw new Error('Inventory unavailable');
    return result;
  };
  const activate = async () => {
    if (pending.current || locks.has(connectionId)) return;
    pending.current = true;
    // Also fence simultaneous controls and remounts while checking/confirming.
    locks.add(connectionId);
    setBusy(true);
    setMessage('');
    let dispatched = false;
    let definite = false;
    try {
      const fresh = await inventory();
      if (!mounted.current) return;
      if (fresh.fullResets.availableCount === 0) {
        setMessage('No Full resets available.');
        return;
      }
      const accepted = await confirm({
        title: `Use Full reset for ${name}?`,
        message: `${fresh.fullResets.availableCount} Full resets available. Consume one to reset five-hour and seven-day limits. This cannot be undone.`,
        confirmLabel: 'Consume one Full reset',
        tone: 'danger',
      });
      if (!accepted || !mounted.current) return;
      const requestId = resetRequestId();
      dispatched = true;
      let result;
      try {
        result = body(
          await api('/api/models/anthropic/reset-activation', {
            method: 'POST',
            body: JSON.stringify({ connectionId, requestId, confirmed: true }),
          }),
        );
      } catch (error) {
        result = body((error as { details?: unknown })?.details);
      }
      definite =
        result.ambiguous !== true &&
        typeof result.code === 'string' &&
        Object.hasOwn(outcomes, result.code);
      if (mounted.current)
        setMessage(
          definite
            ? outcomes[result.code!]
            : 'Reset outcome unknown. Do not retry; verify account usage and reset history.',
        );
      onUsageRefresh();
      if (definite) {
        try {
          const refreshed = await inventory();
          if (mounted.current)
            setMessage(
              `${outcomes[result.code!]} ${refreshed.fullResets.availableCount} Full resets now available.`,
            );
        } catch {
          if (mounted.current)
            setMessage(`${outcomes[result.code!]} Reset availability refresh failed.`);
        }
      }
    } catch {
      if (mounted.current) setMessage('Could not check reset availability. No reset sent.');
    } finally {
      if (!dispatched || definite) locks.delete(connectionId);
      pending.current = false;
      if (mounted.current) {
        setBusy(false);
        setLocked(locks.has(connectionId));
      }
    }
  };
  return (
    <div className="account-resets" aria-busy={busy}>
      <div className="account-resets-row">
        {children}
        <button
          type="button"
          className="secondary"
          disabled={busy || locked}
          onClick={() => void activate()}
        >
          {busy ? 'Checking / using' : 'Use Full reset'}
        </button>
      </div>
      {(message || locked) && (
        <small className="account-reset-message" role="status">
          {message ||
            'Reset outcome unknown. Do not retry; verify account usage and reset history.'}
        </small>
      )}
    </div>
  );
}
