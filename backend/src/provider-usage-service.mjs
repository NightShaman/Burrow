// Reporting only: importing this module acquires no runtime resources.
export function createProviderUsageService({ modelLookup, authSecretToken, fetchImpl = globalThis.fetch, clock = Date.now, anthropicUsageCache = new Map(), openaiOauthUsageCache = new Map(), openaiUsageUrl = 'https://chatgpt.com/backend-api/wham/usage' } = {}) {
  const ANTHROPIC_USAGE_CACHE_MS = 60_000;
  const OPENAI_OAUTH_USAGE_CACHE_MS = 60_000;
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
      if (!openaiOauthConnectionCandidate(connection)) continue;
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
    const utilization = Number(raw.utilization ?? raw.used_percentage ?? raw.usedPercent);
    return {
      key,
      label: key.split('_').map((part) => part ? part[0].toUpperCase() + part.slice(1) : part).join(' '),
      usedPercent: Number.isFinite(utilization) ? Math.max(0, Math.min(100, Math.round(utilization))) : null,
      resetAt: isoOrNull(raw.resets_at ?? raw.resetAt ?? raw.resetsAt),
    };
  }

  function sanitizeAnthropicUsage(data = {}) {
    const windows = ['five_hour', 'seven_day', 'seven_day_sonnet', 'seven_day_opus']
      .map((key) => sanitizeAnthropicUsageWindow(key, data?.[key]))
      .filter(Boolean);
    const extra = data?.extra_usage && typeof data.extra_usage === 'object' ? data.extra_usage : null;
    return {
      windows,
      extraUsage: extra ? {
        isEnabled: Boolean(extra.is_enabled ?? extra.isEnabled),
        monthlyLimit: Number.isFinite(Number(extra.monthly_limit ?? extra.monthlyLimit)) ? Number(extra.monthly_limit ?? extra.monthlyLimit) : null,
        usedCredits: Number.isFinite(Number(extra.used_credits ?? extra.usedCredits)) ? Number(extra.used_credits ?? extra.usedCredits) : null,
        usedPercent: Number.isFinite(Number(extra.utilization ?? extra.used_percentage)) ? Math.max(0, Math.min(100, Math.round(Number(extra.utilization ?? extra.used_percentage)))) : null,
      } : null,
    };
  }


  function clampUsagePercent(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(100, Math.round(number))) : null;
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
    const windowSeconds = Number(raw.limit_window_seconds ?? raw.limitWindowSeconds ?? raw.window_seconds ?? raw.windowSeconds);
    const usedPercent = clampUsagePercent(raw.used_percent ?? raw.usedPercent ?? raw.utilization);
    const resetAt = isoOrNull(raw.reset_at ?? raw.resetAt ?? raw.resets_at ?? raw.resetsAt);
    if (usedPercent === null && !resetAt && !Number.isFinite(windowSeconds)) return null;
    return {
      key,
      label: labelForWindowSeconds(windowSeconds),
      usedPercent,
      resetAt,
      windowSeconds: Number.isFinite(windowSeconds) ? windowSeconds : null,
    };
  }

  function sanitizeAdditionalOpenAiRateLimits(additional) {
    if (!additional || typeof additional !== 'object') return [];
    const entries = Array.isArray(additional) ? additional.map((value, index) => [`additional_${index + 1}`, value]) : Object.entries(additional);
    const windows = [];
    for (const [name, value] of entries) {
      if (!value || typeof value !== 'object') continue;
      const direct = sanitizeOpenAiUsageWindow(String(name), value);
      if (direct) windows.push(direct);
      for (const [childName, childValue] of Object.entries(value)) {
        const child = sanitizeOpenAiUsageWindow(`${name}_${childName}`, childValue);
        if (child) windows.push(child);
      }
    }
    return windows;
  }

  function sanitizeOpenAiOauthUsage(data = {}) {
    const rateLimit = data?.rate_limit && typeof data.rate_limit === 'object' ? data.rate_limit : data?.rateLimit;
    const windows = [
      sanitizeOpenAiUsageWindow('primary', rateLimit?.primary_window ?? rateLimit?.primaryWindow),
      sanitizeOpenAiUsageWindow('secondary', rateLimit?.secondary_window ?? rateLimit?.secondaryWindow),
      ...sanitizeAdditionalOpenAiRateLimits(data?.additional_rate_limits ?? data?.additionalRateLimits),
    ].filter(Boolean);
    return {
      planType: typeof data.plan_type === 'string' ? data.plan_type : (typeof data.planType === 'string' ? data.planType : null),
      blocked: Boolean(rateLimit?.limit_reached ?? rateLimit?.limitReached ?? data.rate_limit_reached_type ?? data.rateLimitReachedType),
      reachedType: typeof data.rate_limit_reached_type === 'string' ? data.rate_limit_reached_type : (typeof data.rateLimitReachedType === 'string' ? data.rateLimitReachedType : null),
      windows,
      credits: data?.credits && typeof data.credits === 'object' ? {
        hasCredits: typeof data.credits.has_credits === 'boolean' ? data.credits.has_credits : (typeof data.credits.hasCredits === 'boolean' ? data.credits.hasCredits : null),
        unlimited: typeof data.credits.unlimited === 'boolean' ? data.credits.unlimited : null,
        balance: Number.isFinite(Number(data.credits.balance)) ? Number(data.credits.balance) : null,
        overageLimitReached: Boolean(data.credits.overage_limit_reached ?? data.credits.overageLimitReached),
      } : null,
    };
  }

  async function anthropicOauthUsage({ connectionId = '', force = false } = {}) {
    const source = await resolveAnthropicUsageSource(connectionId);
    if (!source?.origin || !source?.token) return { ok: false, status: 503, error: 'anthropic_oauth_usage_config_missing', usage: null };
    const cacheKey = source.connectionId;
    const cached = anthropicUsageCache.get(cacheKey);
    const nowMs = clock();
    if (!force && cached && nowMs - cached.fetchedAtMs < ANTHROPIC_USAGE_CACHE_MS) return { ...cached.result, cached: true, cacheTtlMs: Math.max(0, ANTHROPIC_USAGE_CACHE_MS - (nowMs - cached.fetchedAtMs)) };
    try {
      const response = await fetchImpl(`${source.origin}/api/oauth/usage`, {
        headers: { accept: 'application/json', authorization: `Bearer ${source.token}`, 'anthropic-beta': 'oauth-2025-04-20' },
        signal: AbortSignal.timeout(10_000),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) return { ok: false, status: response.status, error: `anthropic_oauth_usage_failed:${response.status}`, usage: null };
      const result = {
        ok: true,
        source: 'anthropic-oauth',
        endpoint: '/api/oauth/usage',
        connectionId: source.connectionId,
        provider: source.provider,
        cached: false,
        cacheTtlMs: ANTHROPIC_USAGE_CACHE_MS,
        fetchedAt: new Date(nowMs).toISOString(),
        usage: sanitizeAnthropicUsage(data),
      };
      anthropicUsageCache.set(cacheKey, { fetchedAtMs: nowMs, result });
      return result;
    } catch (error) {
      return { ok: false, status: 502, error: 'anthropic_oauth_usage_unavailable', detail: String(error?.message || error), usage: null };
    }
  }


  async function openaiOauthUsage({ connectionId = '', force = false } = {}) {
    const source = await resolveOpenAiOauthUsageSource(connectionId);
    if (!source?.token) return { ok: false, status: 503, error: 'openai_oauth_usage_config_missing', usage: null };
    const cacheKey = source.connectionId;
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
      openaiOauthUsageCache.set(cacheKey, { fetchedAtMs: nowMs, result });
      return result;
    } catch (error) {
      return { ok: false, status: 502, error: 'openai_oauth_usage_unavailable', detail: String(error?.message || error), usage: null };
    }
  }

  return { anthropicOauthUsage, openaiOauthUsage };
}
