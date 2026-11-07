import { openaiOAuthIdentity } from './openai-oauth-login.mjs';
import { isProviderPool } from './provider-pool-settings.mjs';
import { modelHttpError } from './model-settings-diagnostics.mjs';

function normalize(value) { return String(value ?? '').trim(); }

function numberOrNull(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; }

const ANTHROPIC_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

const ANTHROPIC_OAUTH_TOKEN_ENDPOINTS = Object.freeze([
  'https://platform.claude.com/v1/oauth/token',
  'https://console.anthropic.com/v1/oauth/token',
]);

export function secretPreview(auth = {}, fallbackProvider = '') {
  return {
    type: auth.type || null,
    provider: auth.provider || fallbackProvider || null,
    source: auth.source || null,
    expiresAt: auth.expiresAt || null,
  };
}

export function normalizeAuth(input = {}, fallbackProvider = '') {
  const supplied = input.auth && typeof input.auth === 'object' ? input.auth : null;
  if (supplied) {
    const type = normalize(supplied.type || supplied.authType || 'api_key').toLowerCase();
    const provider = normalize(supplied.provider || fallbackProvider);
    const source = normalize(supplied.source || 'operator');
    if (type === 'api_key') {
      const apiKey = normalize(supplied.apiKey ?? supplied.key ?? supplied.token ?? supplied.value);
      if (!apiKey) throw new Error('model_auth_api_key_required');
      return { type, provider, source, apiKey };
    }
    if (type === 'token' || type === 'bearer_token') {
      const token = normalize(supplied.token ?? supplied.accessToken ?? supplied.value);
      if (!token) throw new Error('model_auth_token_required');
      return { type: 'token', provider, source, token, expiresAt: numberOrNull(supplied.expiresAt) };
    }
    if (type === 'oauth') {
      const accessToken = normalize(supplied.accessToken ?? supplied.access ?? supplied.token);
      const refreshToken = normalize(supplied.refreshToken ?? supplied.refresh);
      const expiresAt = numberOrNull(supplied.expiresAt ?? supplied.expires);
      if (!accessToken) throw new Error('model_auth_access_token_required');
      if (!refreshToken) throw new Error('model_auth_refresh_token_required');
      if (!expiresAt) throw new Error('model_auth_expires_at_required');
      return { type, provider, source, accessToken, refreshToken, expiresAt };
    }
    throw new Error('model_auth_type_invalid');
  }
  const apiKey = input.apiKey === undefined ? undefined : normalize(input.apiKey);
  return apiKey ? { type: 'api_key', provider: fallbackProvider, source: 'legacy-api-key', apiKey } : null;
}

// Operator credential replacement, not a new OAuth login. Called under the
// connection write lock; blank fields never erase retained credentials.
export function mergeOpenAiOAuthTokens(prior, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('model_oauth_tokens_invalid');
  if (Object.keys(patch).some(key => !['id_token', 'access_token', 'refresh_token'].includes(key))) throw new Error('model_oauth_tokens_invalid');
  if (Object.values(patch).some(value => typeof value !== 'string')) throw new Error('model_oauth_tokens_invalid');
  if (prior?.type !== 'oauth' || prior.provider?.toLowerCase() !== 'openai') throw new Error('model_openai_oauth_connection_required');
  const values = Object.fromEntries(Object.entries(patch).map(([key, value]) => [key, value.trim()]).filter(([, value]) => value));
  const next = { ...prior };
  if (values.id_token) next.idToken = values.id_token;
  if (values.refresh_token) next.refreshToken = values.refresh_token;
  if (values.access_token) {
    let payload;
    try {
      const parts = values.access_token.split('.');
      if (parts.length !== 3) throw new Error();
      payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch { throw new Error('model_oauth_access_token_expiry_required'); }
    // JWT claims are metadata, not proof of authorization; the provider still
    // validates the token when used. Never reuse the old token's expiry/identity.
    if (typeof payload?.exp !== 'number' || !Number.isFinite(payload.exp) || payload.exp <= 0) throw new Error('model_oauth_access_token_expiry_required');
    next.accessToken = values.access_token;
    next.expiresAt = payload.exp * 1000;
    delete next.accountId;
    delete next.planType;
    delete next.email;
    Object.assign(next, openaiOAuthIdentity(next.accessToken));
  }
  return next;
}

export function openAiLikeProvider(value = '') {
  return /openai/i.test(String(value || ''));
}

export function isChatGptBackendUrl(value = '') {
  try { return new URL(String(value || '')).hostname.toLowerCase() === 'chatgpt.com' && /\/backend-api(?:\/|$)/i.test(new URL(String(value || '')).pathname); } catch { return false; }
}

export function canonicalizeOauthConnection(connection, auth) {
  if (isProviderPool(connection) || auth?.type !== 'oauth' || !openAiLikeProvider(auth.provider || connection.provider) || !isChatGptBackendUrl(connection.baseUrl)) return connection;
  return { ...connection, apiType: 'openai-responses' };
}

export async function refreshAnthropicOauth(auth = {}, { fetchImpl = fetch, nowMs = Date.now(), signal = null } = {}) {
  signal?.throwIfAborted();
  const refreshToken = normalize(auth.refreshToken);
  if (!refreshToken) throw new Error('model_auth_refresh_token_required');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: ANTHROPIC_OAUTH_CLIENT_ID });
  let lastError = null;
  for (const endpoint of ANTHROPIC_OAUTH_TOKEN_ENDPOINTS) {
    try {
      const response = await fetchImpl(endpoint, { method: 'POST', ...(signal ? { signal } : {}), headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
      const data = await response.json().catch(() => { signal?.throwIfAborted(); return {}; });
      if (!response.ok) throw modelHttpError('model_auth_refresh_failed', response.status);
      const accessToken = normalize(data.access_token);
      if (!accessToken) throw new Error('model_auth_refresh_missing_access_token');
      return {
        ...auth,
        accessToken,
        refreshToken: normalize(data.refresh_token) || refreshToken,
        expiresAt: nowMs + (Math.max(1, Number(data.expires_in) || 3600) * 1000),
      };
    } catch (error) { signal?.throwIfAborted(); lastError = error; }
  }
  throw lastError || new Error('model_auth_refresh_failed');
}
