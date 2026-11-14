import { createHash } from 'node:crypto';
import { isProviderPool } from './provider-pool-settings.mjs';
import { createOpenAiResetCreditsService, stableResetAccount } from './openai-reset-credits-service.mjs';

// Invalidation epoch reaches native pool service instances without sharing cache ownership.
let openaiUsageGeneration = 0;
// Reporting only: importing this module acquires no runtime resources.
// Capacity is a relative plan weight, not remaining quota or a billing guarantee.
export function openaiTierMetadata(planType) {
  const metadata = { provider: 'openai', capacity: null, status: 'unknown' };
  if (typeof planType === 'string') metadata.planType = planType;
  const capacity = { plus: 1, team: 1, business: 1, prolite: 5, pro: 10, promax: 25 }[planType];
  if (typeof capacity === 'number') Object.assign(metadata, { capacity, status: 'known' });
  return metadata;
}

export function anthropicTierMetadata(profile, { unavailable = false } = {}) {
  const metadata = { provider: 'anthropic', capacity: null, status: unavailable ? 'unavailable' : 'unknown' };
  if (unavailable) return metadata;
  const organization = profile?.organization && typeof profile.organization === 'object' ? profile.organization : profile;
  for (const [raw, key] of [['organization_type', 'organizationType'], ['rate_limit_tier', 'rateLimitTier'], ['seat_tier', 'seatTier']]) {
    const value = organization?.[raw] ?? profile?.[raw];
    if (typeof value === 'string') metadata[key] = value;
  }
  let capacity = null;
  if (metadata.organizationType === 'claude_pro') capacity = 1;
  if (metadata.organizationType === 'claude_max') {
    if (metadata.rateLimitTier === 'default_claude_max_5x') capacity = 5;
    if (metadata.rateLimitTier === 'default_claude_max_20x') capacity = 20;
  }
  if (metadata.organizationType === 'claude_team') {
    if (metadata.seatTier === 'team_standard') capacity = 1.25;
    if (metadata.seatTier === 'team_tier_1') capacity = 6.25;
  }
  if (capacity !== null) Object.assign(metadata, { capacity, status: 'known' });
  return metadata;
}

export function createProviderUsageService({ modelLookup, authSecretToken, fetchImpl = globalThis.fetch, clock = Date.now, anthropicCoordinationStore, random = Math.random, openaiOauthUsageCache = new Map(), resetStore, resetCreditsUrl, timeoutMs, openaiUsageUrl = 'https://chatgpt.com/backend-api/wham/usage' } = {}) {
  let cacheGeneration = openaiUsageGeneration;
  const ANTHROPIC_USAGE_CACHE_MS = 30_000;
  const OPENAI_OAUTH_USAGE_CACHE_MS = 30_000;
  const OPENAI_OAUTH_USAGE_URL = openaiUsageUrl;
function anthropicConnectionCandidate(connection = {}) {
    const provider = String(connection.provider || '').toLowerCase();
    const apiType = String(connection.apiType || connection.api_type || '').toLowerCase();
    const baseUrl = String(connection.baseUrl || connection.base_url || '').toLowerCase();
    return provider.includes('anthropic') || provider.includes('claude') || apiType === 'anthropic-messages' || baseUrl.includes('anthropic.com');
  }

  function openaiOauthConnectionCandidate(connection = {}) {
    const provider = String(connection.provider || '').toLowerCase();
    const apiType = String(connection.apiType || connection.api_type || '').toLowerCase();
    const baseUrl = String(connection.baseUrl || connection.base_url || '').toLowerCase();
    return provider.includes('openai') || apiType.startsWith('openai-') || baseUrl.includes('chatgpt.com');
  }

  function originFromUrl(value = '') {
    try { return new URL(value).origin; } catch { return null; }
  }

  async function resolveAnthropicUsageSource(connectionId = '') {
    const store = modelLookup();
    const requestedId = String(connectionId || '').trim();
    const connections = await store.list();
    const candidates = requestedId ? connections.filter((connection) => connection.id === requestedId) : connections.filter(anthropicConnectionCandidate);
    for (const connection of candidates) {
      if (!anthropicConnectionCandidate(connection)) continue;
      const auth = await store.resolveAuth(connection.id);
      if (String(auth?.type || '').toLowerCase() !== 'oauth') continue;
      const token = authSecretToken(auth);
      const origin = originFromUrl(connection.baseUrl || 'https://api.anthropic.com') || 'https://api.anthropic.com';
      if (token) return { origin, token, connectionId: connection.id, provider: connection.provider || 'Anthropic', expiresAt: auth.expiresAt || null };
    }
    return null;
  }

  async function resolveOpenAiOauthUsageSource(connectionId = '') {
    const store = modelLookup();
    const requestedId = String(connectionId || '').trim();
    const connections = await store.list();
    const candidates = requestedId ? connections.filter((connection) => connection.id === requestedId) : connections.filter(openaiOauthConnectionCandidate);
    for (const connection of candidates) {
      if (isProviderPool(connection) || connection.pool || !openaiOauthConnectionCandidate(connection)) continue;
      const auth = await store.resolveAuth(connection.id);
      if (String(auth?.type || '').toLowerCase() !== 'oauth') continue;
      const authProvider = String(auth.provider || '').toLowerCase();
      if (authProvider && authProvider !== 'openai') continue;
      const token = authSecretToken(auth);
      if (token) return { token, accountId: auth.accountId || null, connectionId: connection.id, provider: connection.provider || 'OpenAI', expiresAt: auth.expiresAt || null };
    }
    return null;
  }

  function isoOrNull(value) {
    if (!value) return null;
    const text = String(value);
    const ms = Number(text);
    if (Number.isFinite(ms) && ms > 0) return new Date(ms < 10_000_000_000 ? ms * 1000 : ms).toISOString();
    const date = new Date(text);
    return Number.isNaN(date.getTime()) ? text : date.toISOString();
  }

  function sanitizeAnthropicUsageWindow(key, raw = null) {
    if (!raw || typeof raw !== 'object') return null;
    const utilization = usagePercent(raw.utilization ?? raw.used_percentage ?? raw.usedPercent);
    return {
      key,
      label: key.split('_').map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(' '),
      usedPercent: utilization,
      exhausted: utilization === null ? null : utilization >= 100,
      windowSeconds: key === 'five_hour' ? 18_000 : 604_800,
      resetAt: isoOrNull(raw.resets_at ?? raw.resetAt ?? raw.resetsAt),
    };
  }

  function sanitizeAnthropicUsage(data = {}) {
    const windows = ['five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus', 'seven_day_oauth_apps']
      .map((key) => sanitizeAnthropicUsageWindow(key, data?.[key]))
      .filter(Boolean);
    const extra = data?.extra_usage && typeof data.extra_usage === 'object' ? data.extra_usage : null;
    return {
      windows,
      exhausted: exhaustedFromWindows(windows),
      extraUsage: extra ? {
        isEnabled: Boolean(extra.is_enabled ?? extra.isEnabled),
        monthlyLimit: finiteNumber(extra.monthly_limit ?? extra.monthlyLimit),
        usedCredits: finiteNumber(extra.used_credits ?? extra.usedCredits),
        usedPercent: usagePercent(extra.utilization ?? extra.used_percentage),
      } : null,
    };
  }


  function finiteNumber(value) {
    if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function usagePercent(value) {
    const number = finiteNumber(value);
    return number === null ? null : Math.max(0, number);
  }

  function exhaustedFromWindows(windows) {
    if (windows.some((window) => window.exhausted === true)) return true;
    return windows.some((window) => window.exhausted === false) ? false : null;
  }

  function labelForWindowSeconds(seconds) {
    const value = Number(seconds);
    if (!Number.isFinite(value) || value <= 0) return 'Window';
    const days = value / 86_400;
    if (days >= 28) return `${Math.round(days)}d`;
    if (Math.abs(days - Math.round(days)) < 0.05 && days >= 1) return `${Math.round(days)}d`;
    const hours = value / 3_600;
    if (Math.abs(hours - Math.round(hours)) < 0.05 && hours >= 1) return `${Math.round(hours)}h`;
    return `${Math.round(value / 60)}m`;
  }

  function sanitizeOpenAiUsageWindow(key, raw = null) {
    if (!raw || typeof raw !== 'object') return null;
    const windowSeconds = finiteNumber(raw.limit_window_seconds ?? raw.limitWindowSeconds ?? raw.window_seconds ?? raw.windowSeconds);
    const usedPercent = usagePercent(raw.used_percent ?? raw.usedPercent ?? raw.utilization);
    const resetAt = isoOrNull(raw.reset_at ?? raw.resetAt ?? raw.resets_at ?? raw.resetsAt);
    if (usedPercent === null && !resetAt && !Number.isFinite(windowSeconds)) return null;
    return {
      key,
      label: labelForWindowSeconds(windowSeconds),
      usedPercent,
      exhausted: usedPercent === null ? null : usedPercent >= 100,
      resetAt,
      windowSeconds: Number.isFinite(windowSeconds) ? windowSeconds : null,
    };
  }

  function sanitizeAdditionalOpenAiRateLimits(additional) {
    if (!additional || typeof additional !== 'object') return [];
    return Object.entries(additional).flatMap(([name, value]) => {
      if (!value || typeof value !== 'object') return [];
      const scope = typeof value.metered_feature === 'string' ? value.metered_feature : String(name);
      const limit = value.rate_limit ?? value.rateLimit ?? value;
      const windows = ['primary', 'secondary'].map(key => sanitizeOpenAiUsageWindow(`additional_${name}_${key}`, limit[`${key}_window`] ?? limit[`${key}Window`])).filter(Boolean);
      const direct = sanitizeOpenAiUsageWindow(`additional_${name}`, value);
      return (windows.length ? windows : direct ? [direct] : []).map(window => ({ ...window, scope }));
    });
  }

  function sanitizeOpenAiOauthUsage(data = {}) {
    const rateLimit = data?.rate_limit ?? data?.rateLimit;
    const mainWindows = [
      sanitizeOpenAiUsageWindow('primary', rateLimit?.primary_window ?? rateLimit?.primaryWindow),
      sanitizeOpenAiUsageWindow('secondary', rateLimit?.secondary_window ?? rateLimit?.secondaryWindow),
    ].filter(Boolean);
    const boolean = value => typeof value === 'boolean' ? value : null;
    const allowed = boolean(rateLimit?.allowed ?? data.allowed);
    const reached = data.rate_limit_reached_type ?? data.rateLimitReachedType ?? data.reachedType;
    const reachedType = typeof reached === 'string' ? reached : typeof reached?.type === 'string' ? reached.type : null;
    const spend = data.spend_control ?? data.spendControl;
    const spendControl = spend && typeof spend === 'object' ? {
      enabled: boolean(spend.enabled), limitReached: boolean(spend.reached ?? spend.limit_reached ?? spend.limitReached),
      limit: finiteNumber(spend.limit), balance: finiteNumber(spend.balance),
    } : null;
    const credits = data?.credits && typeof data.credits === 'object' ? {
      hasCredits: boolean(data.credits.has_credits ?? data.credits.hasCredits),
      unlimited: boolean(data.credits.unlimited), balance: finiteNumber(data.credits.balance),
      overageLimitReached: boolean(data.credits.overage_limit_reached ?? data.credits.overageLimitReached),
    } : null;
    const limitReached = boolean(rateLimit?.limit_reached ?? rateLimit?.limitReached);
    const exhausted = exhaustedFromWindows(mainWindows);
    const blocked = allowed === false || limitReached === true || exhausted === true || Boolean(reachedType);
    const checkedAt = new Date(clock()).toISOString();
    const status = (status, label, reason, scope = 'account', resetAt = null) => ({ status, label, reason, scope, resetAt, checkedAt });
    // Subscription windows describe the actionable restriction first. WHAM may
    // also report depleted overage credits when an included window is exhausted.
    const long = mainWindows.find(window => window.exhausted && (window.windowSeconds >= 86400 || (window.windowSeconds === null && window.key === 'secondary')));
    const short = mainWindows.find(window => window.exhausted && window !== long);
    let accountStatus;
    if (spendControl?.limitReached === true || credits?.overageLimitReached === true || /spend.*(cap|limit)|spend_control|workspace_(owner|member)_usage_limit_reached/.test(reachedType || '')) {
      accountStatus = status('spend_cap', 'Spend Cap Reached', 'spend_cap_reached');
    } else if (/entitlement|subscription|not_entitled|usage_not_included/.test(reachedType || '')) {
      accountStatus = status('entitlement', 'Entitlement Required', 'entitlement_required');
    } else if (long) {
      accountStatus = status('limit_exceeded', 'Limit Exceeded', 'long_window_exhausted', 'account', long.resetAt);
    } else if (short) {
      accountStatus = status('rate_limited', 'Rate Limited', 'short_window_exhausted', 'account', short.resetAt);
    } else if (/^workspace_(owner|member)_credits_depleted$/.test(reachedType || '')) {
      accountStatus = status('credits_depleted', 'Credits Depleted', 'credits_depleted');
    } else {
      if (/weekly|secondary|long/.test(reachedType || '')) accountStatus = status('limit_exceeded', 'Limit Exceeded', 'long_window_exhausted');
      else if (/primary|short|rate_limit/.test(reachedType || '')) accountStatus = status('rate_limited', 'Rate Limited', 'short_window_exhausted');
      else if (allowed === true || (!blocked && exhausted === false)) accountStatus = status('available', 'Active', 'usage_available');
      else accountStatus = status('unknown', 'Unknown', blocked ? 'restriction_unspecified' : 'usage_missing');
    }
    return {
      tierMetadata: openaiTierMetadata(data.plan_type ?? data.planType),
      exhausted: blocked ? true : exhausted,
      planType: typeof (data.plan_type ?? data.planType) === 'string' ? (data.plan_type ?? data.planType) : null,
      blocked, allowed, reachedType, spendControl, accountStatus,
      windows: [...mainWindows, ...sanitizeAdditionalOpenAiRateLimits(data.additional_rate_limits ?? data.additionalRateLimits)], credits,
    };
  }

  // The credential hash identifies identical credentials, not an account.
  async function anthropicOauthUsage({ connectionId = '', force = false } = {}) {
    const source = await resolveAnthropicUsageSource(connectionId);
    const empty = (error, status) => ({ ok:false, status, error, usage:null, fetchedAt:null, cached:false, cacheTtlMs:0, serverTime:new Date(clock()).toISOString(), sampleAgeMs:null, stale:true, lastSuccess:null, lastError:{error,status,at:new Date(clock()).toISOString()}, retryAt:null, retryAfterMs:0, refreshing:false });
    if (!source?.origin || !source?.token) return empty('anthropic_oauth_usage_config_missing', 503);
    if (!anthropicCoordinationStore) return empty('anthropic_oauth_coordination_unavailable', 503);
    const key = createHash('sha256').update(JSON.stringify([source.origin, source.token])).digest('hex');
    const retryDelay = (response, failures, now) => {
      const header = response?.headers?.get('retry-after');
      let ms = 0;
      if (header && /^\d+(?:\.\d+)?$/.test(header.trim())) ms = Number(header) * 1000;
      else if (header) ms = Date.parse(header) - now;
      if (Number.isFinite(ms) && ms > 0) return ms;
      return Math.min(300_000, 5_000 * 2 ** Math.min(failures - 1, 6)) * (1 + Math.max(0, Math.min(1, random())) * 0.25);
    };
    try {
      return await anthropicCoordinationStore.run(key, async (state, observedGeneration) => {
        let now = clock();
        let cached = true;
        const age = () => state.lastSuccess ? Math.max(0, now - Date.parse(state.lastSuccess.fetchedAt)) : null;
        const cooldown = () => (state.retryAtMs || 0) > now;
        // A force request queued behind another fetch shares that completed attempt.
        if (!cooldown() && (state.generation || 0) === observedGeneration && (force || !state.lastSuccess || age() >= ANTHROPIC_USAGE_CACHE_MS || state.lastError)) {
          cached = false;
          let response;
          try {
            response = await fetchImpl(`${source.origin}/api/oauth/usage`, { headers:{ accept:'application/json', authorization:`Bearer ${source.token}`, 'anthropic-beta':'oauth-2025-04-20' }, signal:AbortSignal.timeout(10_000) });
            if (!response.ok) throw Object.assign(new Error('upstream'), { status:response.status });
            const data = await response.json();
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw Object.assign(new Error('malformed'), { malformed:true });
            const usage = sanitizeAnthropicUsage(data);
            now = clock();
            // Profile has an independent, longer cache and retry schedule; refresh never forces it.
            if (!state.profile || now >= state.profile.expiresAtMs) {
              try {
                const profileResponse = await fetchImpl(`${source.origin}/api/oauth/profile`, { method:'GET', headers:{ accept:'application/json', authorization:`Bearer ${source.token}`, 'anthropic-beta':'oauth-2025-04-20' }, signal:AbortSignal.timeout(10_000) });
                if (!profileResponse.ok) {
                  const failures = (state.profile?.failures || 0) + 1;
                  state.profile = { metadata:state.profile?.metadata || anthropicTierMetadata(null, {unavailable:true}), failures, expiresAtMs:clock() + retryDelay(profileResponse, failures, clock()) };
                } else state.profile = { metadata:anthropicTierMetadata(await profileResponse.json()), failures:0, expiresAtMs:clock() + 3_600_000 };
              } catch { const failures = (state.profile?.failures || 0) + 1; state.profile = { metadata:state.profile?.metadata || anthropicTierMetadata(null, {unavailable:true}), failures, expiresAtMs:clock() + retryDelay(null, failures, clock()) }; }
            }
            state.lastSuccess = { fetchedAt:new Date(now).toISOString(), usage:{...usage, tierMetadata:state.profile.metadata} };
            state.lastError = null; state.failures = 0; state.retryAtMs = 0;
          } catch (err) {
            now = clock();
            const status = err.status || 502;
            const error = (err.malformed || err instanceof SyntaxError) ? 'anthropic_oauth_usage_invalid' : err.status ? `anthropic_oauth_usage_failed:${status}` : 'anthropic_oauth_usage_unavailable';
            state.failures = (state.failures || 0) + 1;
            state.lastError = {error,status,at:new Date(now).toISOString()};
            state.retryAtMs = now + retryDelay(response, state.failures, now);
          }
          state.generation = (state.generation || 0) + 1;
        }
        now = clock();
        const sampleAgeMs = age();
        const ok = Boolean(state.lastSuccess && !state.lastError);
        const retryAfterMs = Math.max(0, (state.retryAtMs || 0) - now);
        const result = { ok, status:ok ? 200 : state.lastError?.status || 503, error:ok ? null : state.lastError?.error || 'anthropic_oauth_usage_unavailable', source:'anthropic-oauth', endpoint:'/api/oauth/usage', connectionId:source.connectionId, provider:source.provider, usage:ok ? state.lastSuccess.usage : null, fetchedAt:state.lastSuccess?.fetchedAt || null, cached, cacheTtlMs:ok ? Math.max(0, ANTHROPIC_USAGE_CACHE_MS - sampleAgeMs) : 0, serverTime:new Date(now).toISOString(), sampleAgeMs, stale:sampleAgeMs === null || sampleAgeMs >= ANTHROPIC_USAGE_CACHE_MS, lastSuccess:state.lastSuccess || null, lastError:state.lastError || null, retryAt:retryAfterMs ? new Date(state.retryAtMs).toISOString() : null, retryAfterMs, refreshing:false };
        return {state,result};
      });
    } catch { return { ...empty('anthropic_oauth_coordination_unavailable', 503), connectionId:source.connectionId, provider:source.provider }; }
  }


  async function openaiOauthUsage({ connectionId = '', force = false } = {}) {
    const source = await resolveOpenAiOauthUsageSource(connectionId);
    if (!source?.token) return { ok: false, status: 503, error: 'openai_oauth_usage_config_missing', usage: null };
    if (cacheGeneration !== openaiUsageGeneration) { openaiOauthUsageCache.clear(); cacheGeneration = openaiUsageGeneration; }
    const cacheKey = source.connectionId;
    const fetchGeneration = openaiUsageGeneration;
    const cached = openaiOauthUsageCache.get(cacheKey);
    const nowMs = clock();
    if (!force && cached && nowMs - cached.fetchedAtMs < OPENAI_OAUTH_USAGE_CACHE_MS) return { ...cached.result, cached: true, cacheTtlMs: Math.max(0, OPENAI_OAUTH_USAGE_CACHE_MS - (nowMs - cached.fetchedAtMs)) };
    try {
      const headers = { accept: 'application/json', authorization: `Bearer ${source.token}`, originator: 'burrow', 'user-agent': 'burrow/dev' };
      if (source.accountId) headers['ChatGPT-Account-Id'] = source.accountId;
      const response = await fetchImpl(OPENAI_OAUTH_USAGE_URL, { headers, signal: AbortSignal.timeout(10_000) });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return { ok: false, status: response.status, error: `openai_oauth_usage_failed:${response.status}`, usage: null };
      const result = {
        ok: true,
        source: 'openai-oauth-wham',
        endpoint: '/backend-api/wham/usage',
        connectionId: source.connectionId,
        provider: source.provider,
        cached: false,
        cacheTtlMs: OPENAI_OAUTH_USAGE_CACHE_MS,
        fetchedAt: new Date(nowMs).toISOString(),
        usage: sanitizeOpenAiOauthUsage(data),
      };
      if (fetchGeneration === openaiUsageGeneration) openaiOauthUsageCache.set(cacheKey, { fetchedAtMs: nowMs, result });
      return result;
    } catch (error) {
      return { ok: false, status: 502, error: 'openai_oauth_usage_unavailable', usage: null };
    }
  }

  const resets = createOpenAiResetCreditsService({ resolveSource: resolveOpenAiOauthUsageSource, fetchImpl, clock,
    resetStore, resetCreditsUrl, timeoutMs, refreshUsage: openaiOauthUsage, invalidateUsage: () => { openaiOauthUsageCache.clear(); openaiUsageGeneration++; } });
  async function pollExpiringResets() {
    const results = [];
    const accounts = new Set();
    for (const connection of await modelLookup().list()) {
      if (connection.autoUseExpiringResets !== true || connection.pool || isProviderPool(connection)) continue;
      try {
        const source = await resolveOpenAiOauthUsageSource(connection.id);
        const account = source && stableResetAccount(source);
        if (!account || !resetStore || accounts.has(account)) continue;
        accounts.add(account);
        // The redemption service owns fresh selection and exact-credit outcome
        // reconciliation. Never select a replacement after an uncertain POST.
        const result = await resets.autoConsumeExpiringResetCredit({ connectionId: connection.id });
        results.push({ connectionId: connection.id, ...result });
      } catch { results.push({ connectionId: connection.id, ok: false, error: 'openai_reset_poll_failed' }); }
    }
    return results;
  }
  return { anthropicOauthUsage, openaiOauthUsage, pollExpiringResets, ...resets };
}
