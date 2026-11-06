import { createHash, randomUUID } from 'node:crypto';

// Native OpenAI WHAM banked rate-limit reset contract. Never retry an
// uncertain POST. A new attempt is allowed only after confirmed non-consumption.
const activeAccounts = new Set();
const attempts = new Map();
const uncertainAccounts = new Set(); // Fallback for non-persistent/manual test clients.
const identifier = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const failure = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });
const date = value => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
};
export const AUTO_RESET_EXPIRY_MS = 600_000;

export function createOpenAiResetCreditsService({ resolveSource, fetchImpl = globalThis.fetch, clock = Date.now,
  resetStore,
  resetCreditsUrl = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits', refreshUsage, invalidateUsage = () => {}, timeoutMs = 10_000 } = {}) {
  const headers = source => ({ accept: 'application/json', authorization: `Bearer ${source.token}`, originator: 'burrow',
    ...(source.accountId ? { 'ChatGPT-Account-Id': source.accountId } : {}) });

  async function snapshot(source, evidence = false) {
    try {
      const response = await fetchImpl(resetCreditsUrl, { headers: headers(source), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      if (!response.ok) return failure(response.status, `openai_reset_credits_failed:${response.status}`);
      const data = await response.json();
      if (!data || data.error || !Array.isArray(data.credits) || !Number.isInteger(data.available_count) || data.available_count < 0) return failure(502, 'openai_reset_credits_invalid_response');
      const observed = data.credits.filter(item => item && identifier(item.id)).map(item => ({ id: item.id, status: item.status,
        expiresAt: date(item.expires_at), redeemedAt: date(item.redeemed_at), redeemStartedAt: date(item.redeem_started_at) }));
      const available = observed.filter(item => item.status === 'available' && !item.redeemedAt && !item.redeemStartedAt)
        .map(item => ({ id: item.id, expiresAt: item.expiresAt }))
        .filter(item => !item.expiresAt || Date.parse(item.expiresAt) > clock());
      const expiries = available.map(item => item.expiresAt).filter(Boolean).sort();
      return { ok: true, connectionId: source.connectionId, fetchedAt: new Date(clock()).toISOString(),
        credits: { availableCount: data.available_count, nearestExpiresAt: expiries[0] || null, available },
        ...(evidence ? { observed } : {}) };
    } catch { return failure(502, 'openai_reset_credits_unavailable'); }
  }

  async function openaiResetCredits({ connectionId } = {}) {
    if (!identifier(connectionId)) return failure(400, 'connection_id_required');
    const source = await resolveSource(connectionId);
    if (!source) return failure(503, 'openai_oauth_usage_config_missing');
    return snapshot(source);
  }

  async function consume({ connectionId, creditId, requestId }, automatic = false) {
    if (!identifier(connectionId) || (!automatic && ![creditId, requestId].every(identifier))) return failure(400, 'reset_credit_request_invalid');
    const source = await resolveSource(connectionId);
    if (!source) return failure(503, 'openai_oauth_usage_config_missing');
    const account = stableResetAccount(source) || (!resetStore ? createHash('sha256').update(source.token).digest('hex') : null);
    if (!account || (automatic && !resetStore)) return failure(409, 'reset_credit_stable_identity_required');
    let key = JSON.stringify([account, requestId]);
    const previous = !automatic && attempts.get(key);
    if (previous) return previous.creditId === creditId ? { ...previous.result, replayed: true } : failure(409, 'reset_credit_request_id_conflict');
    if (activeAccounts.has(account)) return failure(409, 'reset_credit_redemption_in_progress');
    if (attempts.size >= 10000) return failure(503, 'reset_credit_replay_capacity_reached');
    activeAccounts.add(account);
    try {
      const fresh = await snapshot(source, true);
      if (!fresh.ok) return fresh;
      let pinnedRetry = null;
      if (resetStore) {
        try {
          const pending = await resetStore.pending(account);
          // Absence, expiry, changed counts and stale "available" responses are
          // NOT evidence that an unknown dispatch did not consume a credit.
          for (const entry of pending) {
            const exact = fresh.observed.find(item => item.id === entry.creditId);
            if (exact?.status === 'redeemed' && exact.redeemedAt) {
              await resetStore.settle({ account, ...entry, outcome: 'consumed', code: 'provider_history_confirmed' });
            }
          }
          if ((await resetStore.pending(account)).length) return failure(409, 'reset_credit_outcome_unknown', { ambiguous: true });
          // Reconciliation is a read/settlement-only poll: never fall through to
          // another credit in the same operation that resolves an unknown one.
          if (pending.length) return { ok: true, connectionId, code: 'reset_credit_reconciled' };
          if (automatic) pinnedRetry = await resetStore.retryCredit(account);
        } catch { return failure(503, 'reset_credit_ledger_unavailable'); }
      } else if (uncertainAccounts.has(account)) return failure(409, 'reset_credit_outcome_unknown', { ambiguous: true });
      const eligible = item => item.expiresAt && Date.parse(item.expiresAt) > clock() && Date.parse(item.expiresAt) <= clock() + AUTO_RESET_EXPIRY_MS;
      const credit = automatic
        ? (pinnedRetry
          ? fresh.credits.available.find(item => item.id === pinnedRetry.creditId && item.expiresAt === pinnedRetry.expiresAt && eligible(item))
          : fresh.credits.available.filter(eligible).sort((a, b) => a.expiresAt.localeCompare(b.expiresAt))[0])
        : fresh.credits.available.find(item => item.id === creditId);
      if (!credit) return automatic ? { ok: true, connectionId, code: 'no_expiring_reset_credit' } : failure(409, 'reset_credit_unavailable');
      creditId = credit.id;
      if (automatic) requestId = `auto:${randomUUID()}`;
      key = JSON.stringify([account, requestId]);
      const identity = { account, creditId, requestId, expiresAt: credit.expiresAt };
      if (resetStore) {
        try { if (!await resetStore.claim(identity)) return failure(409, 'reset_credit_already_claimed'); }
        catch { return failure(503, 'reset_credit_claim_unavailable'); }
      }
      let result;
      let outcome = 'unknown';
      let code = null;
      let httpStatus = null;
      attempts.set(key, { creditId, result: failure(409, 'reset_credit_outcome_unknown', { ambiguous: true }) });
      uncertainAccounts.add(account);
      try {
        const response = await fetchImpl(`${resetCreditsUrl}/consume`, { method: 'POST', headers: { ...headers(source), 'content-type': 'application/json' },
          body: JSON.stringify({ credit_id: creditId, redeem_request_id: requestId }), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
        httpStatus = response.status;
        if (!response.ok) {
          // Definite HTTP rejection may be retried after cooldown, not transport
          // uncertainty/server failure. The same pinned credit is revalidated.
          const ambiguous = response.status >= 500 || response.status === 408 || response.status < 400;
          outcome = ambiguous ? 'unknown' : 'retryable';
          result = failure(response.status, `openai_reset_credit_consume_failed:${response.status}`, { ambiguous });
        } else {
          const data = await response.json();
          if (data?.error || !['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed'].includes(data?.code) ||
              (data.credit?.id != null && data.credit.id !== creditId) ||
              (data.code === 'nothing_to_reset' && (data.windows_reset > 0 || data.credit?.status === 'redeemed' || data.credit?.redeemed_at || data.credit?.redeem_started_at))) {
            result = failure(502, 'reset_credit_outcome_unknown', { ambiguous: true });
          } else {
            code = data.code;
            outcome = code === 'nothing_to_reset' ? 'retryable' : code === 'no_credit' ? 'unavailable' : 'consumed';
            result = code === 'no_credit' ? failure(409, 'reset_credit_unavailable') : { ok: true, connectionId, requestId, code };
          }
        }
      } catch { result = failure(502, 'reset_credit_outcome_unknown', { ambiguous: true }); }
      // Persist actual result BEFORE optional refresh. If storage fails the
      // pre-dispatch unknown fence remains, including across a hard restart.
      if (resetStore) {
        try { await resetStore.settle({ ...identity, outcome, code, httpStatus, error: result.error || null }); }
        catch {
          result = { ...result, outcomeRecorded: false, ledgerError: 'reset_credit_outcome_record_failed' };
          outcome = 'unknown';
        }
      }
      if (outcome !== 'unknown') uncertainAccounts.delete(account);
      invalidateUsage();
      if (result.ok) {
        try { result.usageRefresh = await refreshUsage({ connectionId, force: true }); }
        catch { result.usageRefresh = failure(502, 'openai_oauth_usage_unavailable'); }
        result.creditsRefresh = await snapshot(source);
      }
      attempts.set(key, { creditId, result });
      return result;
    } finally { activeAccounts.delete(account); }
  }
  // Keep automatic mode private to the scheduler, not operator-controlled body fields.
  const consumeOpenaiResetCredit = ({ connectionId, creditId, requestId } = {}) => consume({ connectionId, creditId, requestId });
  const autoConsumeExpiringResetCredit = ({ connectionId } = {}) => consume({ connectionId }, true);
  return { openaiResetCredits, consumeOpenaiResetCredit, autoConsumeExpiringResetCredit };
}

// Access tokens rotate; only a provider account or stable JWT subject fences work.
export function stableResetAccount(source) {
  if (source.accountId) return `account:${source.accountId}`;
  try {
    const payload = JSON.parse(Buffer.from(source.token.split('.')[1], 'base64url').toString());
    if (typeof payload.sub === 'string' && payload.sub.trim()) return `subject:${payload.sub}`;
  } catch {}
  return null;
}
