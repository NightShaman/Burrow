import { createHash } from 'node:crypto';

// Native WHAM contract, referenced from codex-lb's rate_limit_reset_credits.py.
// No proxy dependency; never retry the non-idempotent consume request.
const activeAccounts = new Set();
const attempts = new Map(); // Process-lifetime replay protection, including ambiguous outcomes.
const identifier = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
const failure = (status, error, extra = {}) => ({ ok: false, status, error, ...extra });
const date = value => {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString();
};

export function createOpenAiResetCreditsService({ resolveSource, fetchImpl = globalThis.fetch, clock = Date.now,
  resetCreditsUrl = 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits', refreshUsage, invalidateUsage = () => {}, timeoutMs = 10_000 } = {}) {
  const headers = source => ({ accept: 'application/json', authorization: `Bearer ${source.token}`, originator: 'burrow',
    ...(source.accountId ? { 'ChatGPT-Account-Id': source.accountId } : {}) });

  async function snapshot(source) {
    try {
      const response = await fetchImpl(resetCreditsUrl, { headers: headers(source), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
      if (!response.ok) return failure(response.status, `openai_reset_credits_failed:${response.status}`);
      const data = await response.json();
      if (!data || data.error || !Array.isArray(data.credits) || !Number.isInteger(data.available_count) || data.available_count < 0) return failure(502, 'openai_reset_credits_invalid_response');
      const available = data.credits.filter(item => item && identifier(item.id) && item.status === 'available')
        .map(item => ({ id: item.id, expiresAt: date(item.expires_at) }))
        .filter(item => !item.expiresAt || Date.parse(item.expiresAt) > clock());
      const expiries = available.map(item => item.expiresAt).filter(Boolean).sort();
      return { ok: true, connectionId: source.connectionId, fetchedAt: new Date(clock()).toISOString(),
        credits: { availableCount: data.available_count, nearestExpiresAt: expiries[0] || null, available } };
    } catch { return failure(502, 'openai_reset_credits_unavailable'); }
  }

  async function openaiResetCredits({ connectionId } = {}) {
    if (!identifier(connectionId)) return failure(400, 'connection_id_required');
    const source = await resolveSource(connectionId);
    if (!source) return failure(503, 'openai_oauth_usage_config_missing');
    return snapshot(source);
  }

  async function consumeOpenaiResetCredit({ connectionId, creditId, requestId } = {}) {
    if (![connectionId, creditId, requestId].every(identifier)) return failure(400, 'reset_credit_request_invalid');
    const source = await resolveSource(connectionId);
    if (!source) return failure(503, 'openai_oauth_usage_config_missing');
    // Aliases for the same OAuth account share the guard and replay ledger.
    const account = source.accountId || createHash('sha256').update(source.token).digest('hex');
    const key = JSON.stringify([account, requestId]);
    const previous = attempts.get(key);
    if (previous) return previous.creditId === creditId ? { ...previous.result, replayed: true } : failure(409, 'reset_credit_request_id_conflict');
    if (activeAccounts.has(account)) return failure(409, 'reset_credit_redemption_in_progress');
    if (attempts.size >= 10000) return failure(503, 'reset_credit_replay_capacity_reached');
    activeAccounts.add(account);
    try {
      const fresh = await snapshot(source);
      if (!fresh.ok) return fresh;
      if (!fresh.credits.available.some(item => item.id === creditId)) return failure(409, 'reset_credit_unavailable');
      let result;
      // Record before dispatch: uncertain responses must never trigger another POST.
      attempts.set(key, { creditId, result: failure(409, 'reset_credit_outcome_unknown', { ambiguous: true }) });
      try {
        const response = await fetchImpl(`${resetCreditsUrl}/consume`, { method: 'POST', headers: { ...headers(source), 'content-type': 'application/json' },
          body: JSON.stringify({ credit_id: creditId, redeem_request_id: requestId }), signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
        if (!response.ok) {
          result = failure(response.status, `openai_reset_credit_consume_failed:${response.status}`, { ambiguous: response.status >= 500 || response.status === 408 });
        } else {
          const data = await response.json();
          if (data?.error || !['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed'].includes(data?.code)) {
            result = failure(502, 'reset_credit_outcome_unknown', { ambiguous: true });
          } else if (data.code === 'no_credit') {
            result = failure(409, 'reset_credit_unavailable');
          } else {
            invalidateUsage();
            // A refresh failure is not a failed redemption and must not invite retry.
            let usage;
            try { usage = await refreshUsage({ connectionId, force: true }); }
            catch { usage = failure(502, 'openai_oauth_usage_unavailable'); }
            result = { ok: true, connectionId, requestId, code: data.code, usageRefresh: usage,
              creditsRefresh: await snapshot(source) };
          }
        }
      } catch { result = failure(502, 'reset_credit_outcome_unknown', { ambiguous: true }); }
      if (result.ambiguous) invalidateUsage();
      attempts.set(key, { creditId, result });
      return result;
    } finally { activeAccounts.delete(account); }
  }
  return { openaiResetCredits, consumeOpenaiResetCredit };
}
