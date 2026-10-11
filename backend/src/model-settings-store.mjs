import { googleNativeApi, discoverGoogleModels } from './model-adapters/google-native-catalog.mjs';
import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { openaiOAuthIdentity, refreshOpenAiOAuth } from './openai-oauth-login.mjs';
import { anthropicSupportsTemperature, isAnthropicMessagesConnection } from './anthropic-model-capabilities.mjs';

const AAD_PREFIX = 'burrow-model-secret-v1';

function now() { return new Date().toISOString(); }
function normalize(value) { return String(value ?? '').trim(); }
function asBoolean(value) { return value === true || value === 1; }
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function stringifyJson(value) { return JSON.stringify(value ?? {}); }
function numberOrNull(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; }
function positiveInteger(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : null; }

function parseSemver(value = '') {
  const match = String(value || '').trim().match(/^(?:rust-v|v)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/i);
  return match ? { raw: `${Number(match[1])}.${Number(match[2])}.${Number(match[3])}`, parts: [Number(match[1]), Number(match[2]), Number(match[3])] } : null;
}
function compareSemver(a = '', b = '') {
  const left = parseSemver(a)?.parts;
  const right = parseSemver(b)?.parts;
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  for (let i = 0; i < 3; i += 1) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}
function maxSemver(values = []) {
  return values.map((value) => parseSemver(value)?.raw).filter(Boolean).sort(compareSemver).at(-1) || null;
}
function safeCacheRecord(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function codexClientVersionCacheFresh(cache = {}, nowMs = Date.now(), ttlMs = CODEX_CLIENT_VERSION_CACHE_TTL_MS) {
  const checked = Date.parse(cache.lastCheckedAt || '');
  return Number.isFinite(checked) && checked > 0 && nowMs - checked < Math.max(1, Number(ttlMs) || CODEX_CLIENT_VERSION_CACHE_TTL_MS);
}
async function readCodexClientVersionCacheAsync(target) {
  return cacheGetAsync(target, CODEX_CLIENT_VERSION_META_KEY);
}
async function writeCodexClientVersionCacheAsync(target, patch = {}, { nowMs = Date.now() } = {}) {
  const previous = await readCodexClientVersionCacheAsync(target);
  const next = { ...previous, ...patch, updatedAt: new Date(nowMs).toISOString() };
  return cacheSetAsync(target, CODEX_CLIENT_VERSION_META_KEY, next, nowMs);
}
function codexClientVersionFromCache(cache = {}) {
  return parseSemver(cache.currentVersion)?.raw || parseSemver(cache.lastGoodCatalogVersion)?.raw || CODEX_CLIENT_VERSION_FLOOR;
}

const AUTH_SECRET_NAME = 'providerAuth';
const LEGACY_API_KEY_SECRET_NAME = 'apiKey';
const OAUTH_REFRESH_SKEW_MS = 60_000;
const ANTHROPIC_OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const ANTHROPIC_OAUTH_TOKEN_ENDPOINTS = Object.freeze([
  'https://platform.claude.com/v1/oauth/token',
  'https://console.anthropic.com/v1/oauth/token',
]);
const CODEX_CLIENT_VERSION_META_KEY = 'openai_codex_client_version';
export const CODEX_CLIENT_VERSION_FLOOR = '0.145.0';
export const CODEX_CLIENT_VERSION_CACHE_TTL_MS = 24 * 60 * 60_000;
const NPM_CODEX_LATEST_URL = 'https://registry.npmjs.org/@openai%2Fcodex/latest';
const GITHUB_CODEX_LATEST_URL = 'https://api.github.com/repos/openai/codex/releases/latest';
const MODELS_DEV_CATALOG_META_KEY = 'models_dev_catalog';
export const MODELS_DEV_CATALOG_URL = 'https://models.dev/catalog.json';
export const MODELS_DEV_CATALOG_CACHE_TTL_MS = 24 * 60 * 60_000;

const oauthRefreshes = new Map();


export function settingsKeyFromEnvironment(env = process.env) {
  const encoded = normalize(env.BURROW_SETTINGS_KEY);
  if (!encoded) throw new Error('settings_encryption_key_missing');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('settings_encryption_key_invalid');
  return key;
}

export function assertConnection(input = {}) {
  const provider = normalize(input.provider);
  const apiType = normalize(input.apiType);
  const baseUrl = normalize(input.baseUrl).replace(/\/+$/, '');
  if (!provider) throw new Error('provider_required');
  if (!apiType) throw new Error('api_type_required');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('base_url_invalid');
  const acceptedInput = [...new Set((Array.isArray(input.acceptedInput) ? input.acceptedInput : []).map(normalize).filter((type) => ['text', 'image'].includes(type)))];
  return { provider, apiType, baseUrl, acceptedInput };
}

const MODEL_INPUT_CAPABILITIES = Object.freeze(['text', 'image', 'audio', 'video', 'file']);
const MODEL_OUTPUT_CAPABILITIES = Object.freeze(['text', 'audio', 'image', 'video', 'file']);

function normalizedInput(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(normalize).filter((type) => MODEL_INPUT_CAPABILITIES.includes(type)))];
}

function normalizedCatalogModalities(value, { input = false } = {}) {
  const normalized = (Array.isArray(value) ? value : []).map((type) => normalize(type) === 'pdf' ? 'file' : normalize(type));
  return input ? normalizedInput(normalized) : normalizedOutput(normalized);
}

function normalizedOutput(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(normalize).filter((type) => MODEL_OUTPUT_CAPABILITIES.includes(type)))];
}

function capabilityValues(model = {}, metadata = {}, capabilities = {}, names = []) {
  return names.flatMap((name) => [model[name], metadata[name], capabilities[name]]).find(Array.isArray) || null;
}

function discoveredOutput(model = {}, metadata = {}, capabilities = {}) {
  const modalities = capabilityValues(model, metadata, capabilities, ['output_modalities', 'outputModalities', 'outputs', 'outputCapabilities']);
  if (!modalities) return null;
  return normalizedOutput(modalities);
}

function discoveredInput(model = {}, metadata = {}, capabilities = {}) {
  const modalities = [model.input_modalities, model.inputModalities, metadata.input_modalities, metadata.inputModalities, capabilities.input_modalities, capabilities.inputModalities]
    .find(Array.isArray) || [];
  const explicitImage = [model.supports_images, model.supportsImages, model.supports_vision, model.supportsVision, capabilities.supports_images, capabilities.supportsImages, capabilities.supports_vision, capabilities.supportsVision].some(asBoolean);
  const knowsInput = modalities.length > 0 || [model.supports_images, model.supportsImages, model.supports_vision, model.supportsVision, capabilities.supports_images, capabilities.supportsImages, capabilities.supports_vision, capabilities.supportsVision].some((value) => value !== undefined);
  if (!knowsInput) return null;
  return normalizedInput(['text', ...(explicitImage || modalities.map(normalize).includes('image') ? ['image'] : [])]);
}

function knownModelCapabilities({ provider = '', apiType = '', modelId = '' } = {}) {
  if (isAnthropicMessagesConnection({ provider, apiType })) return { supportsTemperature: anthropicSupportsTemperature(modelId) };
  return {};
}

function normalizeCapabilityProvenance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const source = normalize(value.source);
  const snapshotAt = normalize(value.snapshotAt);
  const matchedProvider = normalize(value.matchedProvider);
  const matchedModel = normalize(value.matchedModel);
  return source && snapshotAt && matchedProvider && matchedModel ? { source, snapshotAt, matchedProvider, matchedModel } : null;
}

function safeModelMetadata(model = {}, { provider = '', apiType = '' } = {}) {
  const metadata = model?.metadata && typeof model.metadata === 'object' ? model.metadata : {};
  const capabilities = model?.capabilities && typeof model.capabilities === 'object' ? model.capabilities : {};
  const override = model.acceptedInputOverride ?? model.accepted_input_override;
  const suppliedDiscovered = Array.isArray(model.discoveredInput) ? normalizedInput(model.discoveredInput) : null;
  const discovered = suppliedDiscovered ?? discoveredInput(model, metadata, capabilities);
  const suppliedOutput = Array.isArray(model.discoveredOutput) ? normalizedOutput(model.discoveredOutput) : null;
  const discoveredOutputs = suppliedOutput ?? discoveredOutput(model, metadata, capabilities);
  const outputOverride = model.acceptedOutputOverride ?? model.accepted_output_override;
  const displayName = normalize(model.displayName ?? model.display_name ?? model.label ?? model.name ?? metadata.display_name ?? metadata.displayName);
  const supportedReasoningLevels = Array.isArray(model.reasoningEfforts)
    ? model.reasoningEfforts
    : Array.isArray(model.supportedReasoningLevels)
      ? model.supportedReasoningLevels
      : Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels
        : Array.isArray(metadata.supported_reasoning_levels)
          ? metadata.supported_reasoning_levels
          : Array.isArray(metadata.supportedReasoningLevels)
            ? metadata.supportedReasoningLevels
            : [];
  const reasoningEfforts = [...new Set(supportedReasoningLevels
    .map((level) => normalize(typeof level === 'string' ? level : level?.effort ?? level?.id ?? level?.name))
    .filter(Boolean))];
  const defaultReasoningEffort = normalize(model.defaultReasoningEffort ?? model.default_reasoning_effort ?? model.default_reasoning_level ?? model.defaultReasoningLevel ?? metadata.default_reasoning_level ?? metadata.defaultReasoningLevel);
  const knownCapabilities = knownModelCapabilities({ provider, apiType, modelId: model.id });
  const supportsTemperatureValue = model.supportsTemperature ?? model.supports_temperature ?? metadata.supportsTemperature ?? metadata.supports_temperature ?? capabilities.supportsTemperature ?? capabilities.supports_temperature ?? knownCapabilities.supportsTemperature;
  const outputTokens = positiveInteger(model.outputTokens ?? model.output_tokens ?? model.maxOutputTokens ?? model.max_output_tokens ?? metadata.output_tokens ?? metadata.outputTokens ?? metadata.max_output_tokens ?? metadata.maxOutputTokens ?? capabilities.output_tokens ?? capabilities.outputTokens ?? capabilities.max_output_tokens ?? capabilities.maxOutputTokens);
  const suppliedDiscoveredContextWindow = positiveInteger(model.discoveredContextWindow ?? model.discovered_context_window);
  const providerContextWindow = positiveInteger(model.context_window ?? metadata.context_window ?? metadata.contextWindow ?? capabilities.context_length);
  const legacyContextWindow = positiveInteger(model.contextWindow);
  const contextWindowOverride = positiveInteger(model.contextWindowOverride ?? model.context_window_override);
  const discoveredContextWindow = suppliedDiscoveredContextWindow ?? providerContextWindow ?? (!contextWindowOverride ? legacyContextWindow : null);
  const contextWindow = contextWindowOverride ?? discoveredContextWindow;
  const capabilityProvenance = normalizeCapabilityProvenance(model.capabilityProvenance);
  return {
    ...(Array.isArray(model.supportedGenerationMethods) ? { supportedGenerationMethods: model.supportedGenerationMethods.filter(x => typeof x === 'string') } : {}),
    ...(model.googleMetadata && typeof model.googleMetadata === 'object' ? { googleMetadata: Object.fromEntries(['name','baseModelId','version','description','inputTokenLimit','outputTokenLimit','thinking','temperature','maxTemperature','topP','topK','metadataSource','outputCapabilitySource'].filter(k => model.googleMetadata[k] !== undefined).map(k => [k, model.googleMetadata[k]])) } : {}),
    ...(displayName ? { displayName } : {}),
    ...(capabilityProvenance ? { capabilityProvenance } : {}),
    ...(reasoningEfforts.length ? { reasoningEfforts } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(typeof supportsTemperatureValue === 'boolean' ? { supportsTemperature: supportsTemperatureValue } : {}),
    ...(discoveredContextWindow ? { discoveredContextWindow } : {}),
    ...(contextWindowOverride ? { contextWindowOverride } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(outputTokens ? { outputTokens } : {}),
    ...(discovered ? { discoveredInput: discovered } : {}),
    ...(discoveredOutputs ? { discoveredOutput: discoveredOutputs } : {}),
    ...(Array.isArray(override) ? { acceptedInputOverride: normalizedInput(override) } : {}),
    ...(Array.isArray(outputOverride) ? { acceptedOutputOverride: normalizedOutput(outputOverride) } : {}),
  };
}

export function normalizeModels(models = [], { provider = '', apiType = '' } = {}) {
  const ids = new Set();
  return (Array.isArray(models) ? models : []).map((model) => {
    const input = typeof model === 'string' ? { id: model } : (model || {});
    const metadata = safeModelMetadata(input, { provider, apiType });
    const acceptedInput = metadata.acceptedInputOverride ?? metadata.discoveredInput;
    const acceptedOutput = metadata.acceptedOutputOverride ?? metadata.discoveredOutput;
    return {
      id: normalize(input.id),
      selected: typeof model === 'string' ? true : input.selected !== false,
      manual: Boolean(typeof model === 'object' && input.manual),
      ...metadata,
      ...(acceptedInput ? { acceptedInput } : {}),
      ...(acceptedOutput ? { acceptedOutput } : {}),
    };
  }).filter((model) => model.id && !ids.has(model.id) && (ids.add(model.id), true));
}


export function normalizeTemperature(value, fallback = 0.2) {
  const temperature = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error('model_temperature_invalid');
  return temperature;
}

export function normalizeReasoningEffort(value) {
  const effort = normalize(value || 'off').toLowerCase();
  if (!['off', 'minimal', 'low', 'medium', 'high', 'ultra', 'xhigh', 'max'].includes(effort)) throw new Error('model_reasoning_effort_invalid');
  return effort;
}

function aad(secretId, connectionId, name) { return Buffer.from(`${AAD_PREFIX}|${secretId}|connection|${connectionId}|${name}`); }
export function encrypt(key, secretId, connectionId, name, value) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(secretId, connectionId, name));
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}
export function decrypt(key, row) {
  let lastError;
  for (const prefix of [AAD_PREFIX, 'hatchetclaw-model-secret-v1']) {
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, row.nonce);
      decipher.setAAD(Buffer.from(`${prefix}|${row.id}|connection|${row.connection_id}|${row.name}`));
      decipher.setAuthTag(row.auth_tag);
      return Buffer.concat([decipher.update(row.ciphertext), decipher.final()]).toString('utf8');
    } catch (error) { lastError = error; }
  }
  throw lastError;
}

export function assertIdentity(input = {}) {
  const kind = normalize(input.kind);
  const id = normalize(input.id);
  const name = input.name === undefined ? undefined : normalize(input.name);
  const avatar = input.avatar === undefined ? undefined : String(input.avatar);
  if (!['operator', 'agent'].includes(kind)) throw new Error('identity_kind_invalid');
  if (!id || !/^[a-zA-Z0-9._-]{1,96}$/.test(id)) throw new Error('identity_id_invalid');
  if (name !== undefined && (!name || name.length > 64)) throw new Error('identity_name_invalid');
  if (avatar !== undefined && (avatar.length > 512_000 || (avatar && !avatar.startsWith('data:image/')))) throw new Error('identity_avatar_invalid');
  return { kind, id, name, avatar };
}

export function publicConnection(row) {
  if (!row) return null;
  const authPreview = parseJson(row.auth_preview_json, null);
  const hasStructuredAuth = Boolean(row.auth_secret_id);
  const canonical = canonicalizeOauthConnection({ provider: row.provider, apiType: row.api_type, baseUrl: row.base_url }, authPreview);
  return {
    id: row.id, provider: row.provider, apiType: canonical.apiType, baseUrl: row.base_url,
    acceptedInput: parseJson(row.accepted_input_json, ['text', 'image']),
    models: normalizeModels(parseJson(row.models_json, []), { provider: row.provider, apiType: canonical.apiType }),
    apiKeyConfigured: Boolean(row.secret_id || row.auth_secret_id),
    authConfigured: Boolean(row.secret_id || row.auth_secret_id),
    auth: hasStructuredAuth ? {
      configured: true,
      type: authPreview?.type || null,
      provider: authPreview?.provider || row.provider || null,
      source: authPreview?.source || null,
      expiresAt: authPreview?.expiresAt || null,
    } : { configured: Boolean(row.secret_id), type: row.secret_id ? 'api_key' : null, provider: row.provider || null, source: row.secret_id ? 'legacy-api-key' : null, expiresAt: null },
    createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

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

function authToken(auth = {}) {
  if (auth.type === 'oauth') return auth.accessToken || '';
  if (auth.type === 'token' || auth.type === 'bearer_token') return auth.token || '';
  if (auth.type === 'api_key') return auth.apiKey || '';
  return '';
}

function isOauthFresh(auth = {}, nowMs = Date.now()) {
  return auth.type === 'oauth' && Number(auth.expiresAt) > nowMs + OAUTH_REFRESH_SKEW_MS && Boolean(auth.accessToken);
}

function anthropicLikeProvider(value = '') {
  return /anthropic|claude/i.test(String(value || ''));
}
function openAiLikeProvider(value = '') {
  return /openai/i.test(String(value || ''));
}

function isChatGptBackendUrl(value = '') {
  try { return new URL(String(value || '')).hostname.toLowerCase() === 'chatgpt.com' && /\/backend-api(?:\/|$)/i.test(new URL(String(value || '')).pathname); } catch { return false; }
}
function chatGptCodexModelsUrl(baseUrl = '', clientVersion = CODEX_CLIENT_VERSION_FLOOR) {
  const base = normalize(baseUrl).replace(/\/+$/, '');
  const root = base.replace(/\/codex(?:\/responses)?$/i, '');
  return `${root}/codex/models?client_version=${encodeURIComponent(parseSemver(clientVersion)?.raw || CODEX_CLIENT_VERSION_FLOOR)}`;
}
function chatGptAccountIdFromAuth(auth = {}) {
  return normalize(auth.accountId) || normalize(openaiOAuthIdentity(auth.accessToken || auth.token || '').accountId);
}
function chatGptCodexCatalogHeaders({ apiKey, auth = {} } = {}) {
  const token = normalize(apiKey || auth.token || auth.apiKey || auth.accessToken);
  const accountId = chatGptAccountIdFromAuth(auth);
  return {
    accept: 'application/json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
  };
}
function normalizeCodexCatalogModels(body = {}) {
  const data = Array.isArray(body.models) ? body.models : Array.isArray(body.data) ? body.data : [];
  return normalizeModels(data
    .filter((model) => model && typeof model === 'object' && model.supported_in_api !== false && normalize(model.visibility) !== 'hide' && normalize(model.slug || model.id) !== 'codex-auto-review')
    .map((model) => ({ ...model, id: model.slug || model.id, selected: false, manual: false })));
}
function observedMinimumClientVersion(body = {}) {
  const data = Array.isArray(body.models) ? body.models : Array.isArray(body.data) ? body.data : [];
  return maxSemver(data.map((model) => model?.minimal_client_version ?? model?.minimalClientVersion));
}

export function canonicalizeOauthConnection(connection, auth) {
  if (auth?.type !== 'oauth' || !openAiLikeProvider(auth.provider || connection.provider) || !isChatGptBackendUrl(connection.baseUrl)) return connection;
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
      if (!response.ok) throw new Error(`model_auth_refresh_failed:${response.status}`);
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

// Compatibility export only; persistence requires the PostgreSQL store.
export class ModelSettingsStore {
  constructor() { throw new Error('postgres_required'); }
}

function modelDiscoveryUrl({ baseUrl, apiType } = {}) {
  const base = normalize(baseUrl).replace(/\/+$/, '');
  if (normalize(apiType) === 'anthropic-messages') {
    if (base.endsWith('/v1')) return `${base}/models`;
    return `${base}/v1/models`;
  }
  return `${base}/models`;
}

function modelDiscoveryHeaders({ apiType, apiKey, auth = {} } = {}) {
  const type = normalize(apiType);
  const token = normalize(apiKey || auth.token || auth.apiKey || auth.accessToken);
  if (type === 'anthropic-messages') {
    const authType = normalize(auth.type || 'api_key').toLowerCase();
    const oauthLike = authType === 'oauth' || authType === 'token' || authType === 'bearer_token';
    return {
      accept: 'application/json',
      'anthropic-version': auth.anthropicVersion || '2023-06-01',
      ...(oauthLike ? { 'anthropic-beta': auth.beta || 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14' } : {}),
      ...(token ? (oauthLike ? { authorization: `Bearer ${token}` } : { 'x-api-key': token }) : {}),
    };
  }
  return { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

async function fetchCodexVersionFromUrl(url, { fetchImpl = fetch, signal = undefined, source } = {}) {
  const response = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'Burrow/codex-version-resolver' }, signal });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`codex_client_version_${source}_failed:${response.status}`);
  const candidate = source === 'github' ? body.tag_name || body.name || body.version : body.version || body.tag_name || body.name;
  const parsed = parseSemver(candidate);
  if (!parsed) throw new Error(`codex_client_version_${source}_invalid`);
  return parsed.raw;
}

export async function refreshCodexClientVersionCache({ store, fetchImpl = fetch, signal = undefined, nowMs = Date.now() } = {}) {
  const target = store;
  const attempts = [
    ['npm', NPM_CODEX_LATEST_URL],
    ['github', GITHUB_CODEX_LATEST_URL],
  ];
  let lastError = null;
  for (const [source, url] of attempts) {
    try {
      const version = await fetchCodexVersionFromUrl(url, { fetchImpl, signal, source });
      return writeCodexClientVersionCacheAsync(target, { currentVersion: version, source, lastCheckedAt: new Date(nowMs).toISOString(), lastError: null }, { nowMs });
    } catch (error) { lastError = error; }
  }
  return writeCodexClientVersionCacheAsync(target, { lastCheckedAt: new Date(nowMs).toISOString(), lastError: String(lastError?.message || lastError || 'codex_client_version_refresh_failed') }, { nowMs });
}

export async function resolveCodexClientVersion({ store, nowMs = Date.now(), refresh = false, fetchImpl = fetch, signal = undefined } = {}) {
  const target = store;
  const cache = await readCodexClientVersionCacheAsync(target);
  if (!refresh || codexClientVersionCacheFresh(cache, nowMs)) return { version: codexClientVersionFromCache(cache), cache, refreshed: false };
  const next = await refreshCodexClientVersionCache({ store, fetchImpl, signal, nowMs });
  return { version: codexClientVersionFromCache(next), cache: next, refreshed: true };
}

function catalogProviders(catalog) {
  const root = catalog?.providers && typeof catalog.providers === 'object' ? catalog.providers : catalog;
  return Object.entries(root && typeof root === 'object' && !Array.isArray(root) ? root : {}).map(([key, value]) => ({ key, ...(value || {}) }));
}

function exactCatalogProvider(catalog, provider) {
  const requested = normalize(provider);
  if (!requested) return null;
  return catalogProviders(catalog).find((item) => requested === normalize(item.id || item.key)
    || requested === normalize(item.name)
    || (item.canonicalId !== undefined && requested === normalize(item.canonicalId))) || null;
}

function catalogModels(provider = {}) {
  const values = provider.models;
  if (Array.isArray(values)) return values;
  return Object.entries(values && typeof values === 'object' ? values : {}).map(([key, value]) => ({ key, ...(value || {}) }));
}

function azureModelCatalogId(modelId) {
  return normalize(modelId).replace(/-(?:19|20)\d{2}(?:-\d{2}-\d{2}|\d{4})$/, '');
}

function enrichFromModelsDev(models, catalog, { provider, snapshotAt } = {}) {
  const matchProvider = exactCatalogProvider(catalog, provider);
  if (!matchProvider) return models;
  const byId = new Map(catalogModels(matchProvider).map((model) => [normalize(model.id || model.key), model]).filter(([id]) => id));
  const azure = normalize(matchProvider.id || matchProvider.key) === 'azure';
  return models.map((model) => {
    const match = byId.get(model.id) || (azure ? byId.get(azureModelCatalogId(model.id)) : null);
    if (!match) return model;
    const modalities = match.modalities && typeof match.modalities === 'object' ? match.modalities : {};
    const limit = match.limit && typeof match.limit === 'object' ? match.limit : {};
    const catalogMetadata = safeModelMetadata({
      id: model.id,
      displayName: match.name,
      discoveredContextWindow: match.context_window ?? match.contextWindow ?? limit.context,
      outputTokens: match.max_output_tokens ?? match.outputTokens ?? limit.output,
      discoveredInput: normalizedCatalogModalities(modalities.input, { input: true }),
      discoveredOutput: normalizedCatalogModalities(modalities.output),
    });
    // Provider responses are authoritative. The catalog only fills absent fields;
    // explicit operator overrides remain on the provider-normalized model.
    return {
      ...catalogMetadata,
      ...model,
      capabilityProvenance: { source: 'models.dev', snapshotAt, matchedProvider: normalize(matchProvider.id || matchProvider.key), matchedModel: normalize(match.id || match.key) },
    };
  });
}

async function cacheGetAsync(target, key) {
  if (!target) return {};
  if (typeof target.cacheGet !== 'function') throw new Error('postgres_required');
  return safeCacheRecord(await target.cacheGet(key));
}
async function cacheSetAsync(target, key, value, nowMs) {
  if (!target) return value;
  if (typeof target.cacheSet !== 'function') throw new Error('postgres_required');
  await target.cacheSet(key, value, new Date(nowMs).toISOString());
  return value;
}
async function modelsDevSnapshot({ store, fetchImpl = fetch, signal, nowMs = Date.now(), catalogUrl = MODELS_DEV_CATALOG_URL, ttlMs = MODELS_DEV_CATALOG_CACHE_TTL_MS } = {}) {
  const target = store;
  const cached = safeCacheRecord(await cacheGetAsync(target, MODELS_DEV_CATALOG_META_KEY));
  const checked = Date.parse(cached.lastCheckedAt || '');
  if (cached.catalog && Number.isFinite(checked) && nowMs - checked < Math.max(1, Number(ttlMs) || MODELS_DEV_CATALOG_CACHE_TTL_MS)) return cached;
  try {
    const headers = { accept: 'application/json', 'user-agent': 'Burrow/models-dev-catalog' };
    if (cached.etag) headers['if-none-match'] = cached.etag;
    const response = await fetchImpl(catalogUrl, { headers, signal });
    const checkedAt = new Date(nowMs).toISOString();
    let next;
    if (response.status === 304 && cached.catalog) next = { ...cached, lastCheckedAt: checkedAt, lastError: null };
    else {
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || typeof body !== 'object') throw new Error(`models_dev_catalog_failed:${response.status}`);
      next = { catalog: body, etag: response.headers.get('etag') || null, snapshotAt: checkedAt, lastCheckedAt: checkedAt, lastError: null };
    }
    if (target) await cacheSetAsync(target, MODELS_DEV_CATALOG_META_KEY, next, nowMs);
    return next;
  } catch (error) {
    if (cached.catalog) {
      const next = { ...cached, lastCheckedAt: new Date(nowMs).toISOString(), lastError: String(error?.message || error) };
      if (target) await cacheSetAsync(target, MODELS_DEV_CATALOG_META_KEY, next, nowMs);
      return next;
    }
    return null;
  }
}

function modelsDevProviderIdentity({ provider = '', apiType = '', baseUrl = '', auth = {} } = {}) {
  const type = normalize(apiType).toLowerCase();
  let hostname = '';
  try { hostname = new URL(normalize(baseUrl)).hostname.toLowerCase(); } catch {}
  if (type === 'anthropic-messages') return 'anthropic';
  if (hostname.endsWith('.openai.azure.com') || hostname.endsWith('.services.ai.azure.com')) return 'azure';
  if (hostname === 'api.openai.com' || hostname === 'chatgpt.com' || openAiLikeProvider(auth.provider)) return 'openai';
  return normalize(provider);
}

export async function discoverModels({ baseUrl, provider = '', useModelsDev = false, apiType = 'openai-responses', apiKey, auth = {}, fetchImpl = fetch, catalogFetchImpl = fetchImpl, catalogUrl = MODELS_DEV_CATALOG_URL, catalogTtlMs = MODELS_DEV_CATALOG_CACHE_TTL_MS, signal = undefined, store = null, codexClientVersion = undefined, nowMs = Date.now() } = {}) {
  if (googleNativeApi({ apiType })) return normalizeModels(await discoverGoogleModels({ baseUrl, apiKey, auth }, { fetchImpl, signal }), { provider, apiType });
  const catalogProvider = modelsDevProviderIdentity({ provider, apiType, baseUrl, auth });
  const catalogSnapshot = useModelsDev && catalogProvider ? await modelsDevSnapshot({ store, fetchImpl: catalogFetchImpl, signal, nowMs, catalogUrl, ttlMs: catalogTtlMs }) : null;
  const enrich = (models) => catalogSnapshot?.catalog
    ? enrichFromModelsDev(models, catalogSnapshot.catalog, { provider: catalogProvider, snapshotAt: catalogSnapshot.snapshotAt })
    : models;
  if (isChatGptBackendUrl(baseUrl) && openAiLikeProvider(auth.provider || 'OpenAI')) {
    const target = store;
    const initial = parseSemver(codexClientVersion)?.raw || (await resolveCodexClientVersion({ store, nowMs, refresh: false })).version;
    const headers = chatGptCodexCatalogHeaders({ apiKey, auth });
    const versionCache = await readCodexClientVersionCacheAsync(target);
    const versions = [...new Set([initial, versionCache.lastGoodCatalogVersion, CODEX_CLIENT_VERSION_FLOOR].map((value) => parseSemver(value)?.raw).filter(Boolean))];
    let lastError = null;
    for (const version of versions) {
      const response = await fetchImpl(chatGptCodexModelsUrl(baseUrl, version), { headers, signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { lastError = new Error(`model_discovery_failed:${response.status}`); continue; }
      const models = normalizeCodexCatalogModels(body);
      const minimumObservedModelVersion = observedMinimumClientVersion(body);
      if (target) await writeCodexClientVersionCacheAsync(target, { lastGoodCatalogVersion: version, minimumObservedModelVersion, lastCatalogAt: new Date(nowMs).toISOString(), lastCatalogCount: models.length }, { nowMs });
      return enrich(models);
    }
    throw lastError || new Error('model_discovery_failed');
  }

  const url = modelDiscoveryUrl({ baseUrl, apiType });
  return fetchImpl(url, { headers: modelDiscoveryHeaders({ apiType, apiKey, auth }), signal })
    .then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`model_discovery_failed:${response.status}`);
      const data = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
      return enrich(normalizeModels(data.map((model) => ({ ...model, id: model?.id, selected: false, manual: false }))));
    });
}
