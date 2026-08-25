import { randomBytes, randomUUID, createCipheriv, createDecipheriv } from 'node:crypto';
import { openSettingsDatabase, settingsDatabasePath, getSettingsMeta, setSettingsMeta } from './settings-database.mjs';
import { openaiOAuthIdentity, refreshOpenAiOAuth } from './openai-oauth-login.mjs';
import { __agentRegistry } from './agent-registry.mjs';
import { anthropicSupportsTemperature, isAnthropicMessagesConnection } from './anthropic-model-capabilities.mjs';

const AAD_PREFIX = 'burrow-model-secret-v1';

function now() { return new Date().toISOString(); }
function normalize(value) { return String(value ?? '').trim(); }
function asBoolean(value) { return value === true || value === 1; }
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function stringifyJson(value) { return JSON.stringify(value ?? {}); }
function numberOrNull(value) { const n = Number(value); return Number.isFinite(n) && n > 0 ? n : null; }

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
function readCodexClientVersionCache(storeOrDb) {
  const db = storeOrDb?.db || storeOrDb;
  return db ? safeCacheRecord(getSettingsMeta(db, CODEX_CLIENT_VERSION_META_KEY)) : {};
}
function writeCodexClientVersionCache(storeOrDb, patch = {}, { nowMs = Date.now() } = {}) {
  const db = storeOrDb?.db || storeOrDb;
  if (!db) return safeCacheRecord(patch);
  const previous = readCodexClientVersionCache(db);
  const next = { ...previous, ...patch, updatedAt: new Date(nowMs).toISOString() };
  setSettingsMeta(db, CODEX_CLIENT_VERSION_META_KEY, next, { clock: () => new Date(nowMs).toISOString() });
  return next;
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

const oauthRefreshes = new Map();

export { settingsDatabasePath } from './settings-database.mjs';

export function settingsKeyFromEnvironment(env = process.env) {
  const encoded = normalize(env.BURROW_SETTINGS_KEY);
  if (!encoded) throw new Error('settings_encryption_key_missing');
  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) throw new Error('settings_encryption_key_invalid');
  return key;
}

function assertConnection(input = {}) {
  const provider = normalize(input.provider);
  const apiType = normalize(input.apiType);
  const baseUrl = normalize(input.baseUrl).replace(/\/+$/, '');
  if (!provider) throw new Error('provider_required');
  if (!apiType) throw new Error('api_type_required');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('base_url_invalid');
  const acceptedInput = [...new Set((Array.isArray(input.acceptedInput) ? input.acceptedInput : []).map(normalize).filter((type) => ['text', 'image'].includes(type)))];
  return { provider, apiType, baseUrl, acceptedInput };
}

function normalizedInput(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(normalize).filter((type) => ['text', 'image'].includes(type)))];
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

function safeModelMetadata(model = {}, { provider = '', apiType = '' } = {}) {
  const metadata = model?.metadata && typeof model.metadata === 'object' ? model.metadata : {};
  const capabilities = model?.capabilities && typeof model.capabilities === 'object' ? model.capabilities : {};
  const override = model.acceptedInputOverride ?? model.accepted_input_override;
  const suppliedDiscovered = Array.isArray(model.discoveredInput) ? normalizedInput(model.discoveredInput) : null;
  const discovered = suppliedDiscovered ?? discoveredInput(model, metadata, capabilities);
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
  return {
    ...(displayName ? { displayName } : {}),
    ...(reasoningEfforts.length ? { reasoningEfforts } : {}),
    ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
    ...(typeof supportsTemperatureValue === 'boolean' ? { supportsTemperature: supportsTemperatureValue } : {}),
    ...(Number.isFinite(Number(model.contextWindow ?? model.context_window ?? metadata.context_window ?? metadata.contextWindow ?? capabilities.context_length)) ? { contextWindow: Number(model.contextWindow ?? model.context_window ?? metadata.context_window ?? metadata.contextWindow ?? capabilities.context_length) } : {}),
    ...(discovered ? { discoveredInput: discovered } : {}),
    ...(Array.isArray(override) ? { acceptedInputOverride: normalizedInput(override) } : {}),
  };
}

function normalizeModels(models = [], { provider = '', apiType = '' } = {}) {
  const ids = new Set();
  return (Array.isArray(models) ? models : []).map((model) => {
    const input = typeof model === 'string' ? { id: model } : (model || {});
    const metadata = safeModelMetadata(input, { provider, apiType });
    const acceptedInput = metadata.acceptedInputOverride ?? metadata.discoveredInput;
    return {
      id: normalize(input.id),
      selected: typeof model === 'string' ? true : input.selected !== false,
      manual: Boolean(typeof model === 'object' && input.manual),
      ...metadata,
      ...(acceptedInput ? { acceptedInput } : {}),
    };
  }).filter((model) => model.id && !ids.has(model.id) && (ids.add(model.id), true));
}


function normalizeTemperature(value, fallback = 0.2) {
  const temperature = value === undefined || value === null || value === '' ? fallback : Number(value);
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) throw new Error('model_temperature_invalid');
  return temperature;
}

function normalizeReasoningEffort(value) {
  const effort = normalize(value || 'off').toLowerCase();
  if (!['off', 'minimal', 'low', 'medium', 'high', 'ultra', 'xhigh', 'max'].includes(effort)) throw new Error('model_reasoning_effort_invalid');
  return effort;
}

function aad(secretId, connectionId, name) { return Buffer.from(`${AAD_PREFIX}|${secretId}|connection|${connectionId}|${name}`); }
function encrypt(key, secretId, connectionId, name, value) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(secretId, connectionId, name));
  const ciphertext = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  return { ciphertext, nonce, authTag: cipher.getAuthTag() };
}
function decrypt(key, row) {
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

function assertIdentity(input = {}) {
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

function publicConnection(row) {
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

function secretPreview(auth = {}, fallbackProvider = '') {
  return {
    type: auth.type || null,
    provider: auth.provider || fallbackProvider || null,
    source: auth.source || null,
    expiresAt: auth.expiresAt || null,
  };
}

function normalizeAuth(input = {}, fallbackProvider = '') {
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

function canonicalizeOauthConnection(connection, auth) {
  if (auth?.type !== 'oauth' || !openAiLikeProvider(auth.provider || connection.provider) || !isChatGptBackendUrl(connection.baseUrl)) return connection;
  return { ...connection, apiType: 'openai-responses' };
}

async function refreshAnthropicOauth(auth = {}, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const refreshToken = normalize(auth.refreshToken);
  if (!refreshToken) throw new Error('model_auth_refresh_token_required');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: ANTHROPIC_OAUTH_CLIENT_ID });
  let lastError = null;
  for (const endpoint of ANTHROPIC_OAUTH_TOKEN_ENDPOINTS) {
    try {
      const response = await fetchImpl(endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`model_auth_refresh_failed:${response.status}`);
      const accessToken = normalize(data.access_token);
      if (!accessToken) throw new Error('model_auth_refresh_missing_access_token');
      return {
        ...auth,
        accessToken,
        refreshToken: normalize(data.refresh_token) || refreshToken,
        expiresAt: nowMs + (Math.max(1, Number(data.expires_in) || 3600) * 1000),
      };
    } catch (error) { lastError = error; }
  }
  throw lastError || new Error('model_auth_refresh_failed');
}

export class ModelSettingsStore {
  constructor({ databasePath, key, bootstrapSampleIdentities = process.env.BURROW_BOOTSTRAP_SAMPLE_IDENTITIES } = {}) {
    this.databasePath = databasePath || settingsDatabasePath();
    this.key = key || settingsKeyFromEnvironment();
    this.bootstrapSampleIdentities = __agentRegistry.bootstrapSampleIdentitiesEnabled(bootstrapSampleIdentities);
    this.db = openSettingsDatabase({ databasePath: this.databasePath });
  }

  close() { this.db.close(); }

  connectionSelectSql(where = '') {
    return `SELECT c.*, legacy.id AS secret_id, auth.id AS auth_secret_id, meta.value_json AS auth_preview_json
      FROM model_connections c
      LEFT JOIN model_connection_secrets legacy ON legacy.connection_id = c.id AND legacy.name = '${LEGACY_API_KEY_SECRET_NAME}'
      LEFT JOIN model_connection_secrets auth ON auth.connection_id = c.id AND auth.name = '${AUTH_SECRET_NAME}'
      LEFT JOIN settings_meta meta ON meta.key = 'model_auth_preview:' || c.id
      ${where}`;
  }

  list() {
    return this.db.prepare(`${this.connectionSelectSql()} ORDER BY c.updated_at DESC`).all().map(publicConnection);
  }

  get(id) {
    return publicConnection(this.db.prepare(this.connectionSelectSql('WHERE c.id = ?')).get(id));
  }

  secret(id, name) {
    const row = this.db.prepare(`SELECT * FROM model_connection_secrets WHERE connection_id = ? AND name = ?`).get(id, name);
    return row ? decrypt(this.key, row) : null;
  }

  apiKey(id) { return this.secret(id, LEGACY_API_KEY_SECRET_NAME); }

  auth(id) {
    const structured = this.secret(id, AUTH_SECRET_NAME);
    if (structured) return parseJson(structured, null);
    const apiKey = this.apiKey(id);
    return apiKey ? { type: 'api_key', provider: this.get(id)?.provider || null, source: 'legacy-api-key', apiKey } : null;
  }

  saveSecret(connectionId, name, value, timestamp = now()) {
    const old = this.db.prepare(`SELECT id FROM model_connection_secrets WHERE connection_id=? AND name=?`).get(connectionId, name);
    const secretId = old?.id || randomUUID();
    const sealed = encrypt(this.key, secretId, connectionId, name, value);
    if (old) this.db.prepare(`UPDATE model_connection_secrets SET ciphertext=?, nonce=?, auth_tag=?, updated_at=? WHERE id=?`).run(sealed.ciphertext, sealed.nonce, sealed.authTag, timestamp, secretId);
    else this.db.prepare(`INSERT INTO model_connection_secrets (id, connection_id, name, ciphertext, nonce, auth_tag, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(secretId, connectionId, name, sealed.ciphertext, sealed.nonce, sealed.authTag, timestamp, timestamp);
    return secretId;
  }

  hasAuth(id) { return Boolean(this.auth(id)); }

  save(input = {}) {
    let connection = assertConnection(input);
    const id = normalize(input.id) || randomUUID();
    const existing = this.db.prepare('SELECT id FROM model_connections WHERE id = ?').get(id);
    const existingAuth = existing ? this.auth(id) : null;
    const auth = input.auth === undefined && input.apiKey === undefined ? existingAuth : normalizeAuth(input, connection.provider);
    connection = canonicalizeOauthConnection(connection, auth);
    const duplicateLabel = this.db.prepare('SELECT id FROM model_connections WHERE lower(provider) = lower(?) AND id <> ?').get(connection.provider, id);
    if (duplicateLabel) throw new Error('provider_label_duplicate');
    const timestamp = now();
    const existingModels = existing
      ? normalizeModels(parseJson(this.db.prepare('SELECT models_json FROM model_connections WHERE id = ?').get(id)?.models_json, []), { provider: connection.provider, apiType: connection.apiType })
      : [];
    const submittedModels = normalizeModels(input.models, { provider: connection.provider, apiType: connection.apiType });
    // A connection edit commonly carries only model IDs/selection toggles. Keep
    // provider-discovered capabilities (especially contextWindow) unless a
    // fresh discovery explicitly supplies replacement metadata.
    const existingById = new Map(existingModels.map((model) => [model.id, model]));
    const models = submittedModels.map((model) => {
      const prior = existingById.get(model.id);
      if (!prior || model.manual || prior.manual) return model;
      return { ...prior, ...model, contextWindow: model.contextWindow ?? prior.contextWindow };
    });
    const acceptedInput = connection.acceptedInput;
    const save = () => {
      this.db.exec('BEGIN IMMEDIATE');
      try {
      if (existing) {
        this.db.prepare(`UPDATE model_connections SET provider=?, api_type=?, base_url=?, accepted_input_json=?, models_json=?, updated_at=? WHERE id=?`)
          .run(connection.provider, connection.apiType, connection.baseUrl, stringifyJson(acceptedInput), stringifyJson(models), timestamp, id);
      } else {
        this.db.prepare(`INSERT INTO model_connections (id, provider, api_type, base_url, accepted_input_json, models_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, connection.provider, connection.apiType, connection.baseUrl, stringifyJson(acceptedInput), stringifyJson(models), timestamp, timestamp);
      }
      if (auth) {
        if (auth.type === 'api_key' && input.auth === undefined) this.saveSecret(id, LEGACY_API_KEY_SECRET_NAME, auth.apiKey, timestamp);
        else {
          this.saveSecret(id, AUTH_SECRET_NAME, JSON.stringify(auth), timestamp);
          this.db.prepare(`INSERT INTO settings_meta (key,value_json,updated_at) VALUES (?,?,?)
            ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
            .run(`model_auth_preview:${id}`, JSON.stringify(secretPreview(auth, connection.provider)), timestamp);
        }
      }
        this.db.exec('COMMIT');
      } catch (error) {
        try { this.db.exec('ROLLBACK'); } catch {}
        throw error;
      }
    };
    save();
    return this.get(id);
  }

  remove(id) {
    const connectionId = normalize(id);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM agent_model_selections WHERE connection_id = ?').run(connectionId);
      const removed = this.db.prepare('DELETE FROM model_connections WHERE id = ?').run(connectionId).changes > 0;
      this.db.exec('COMMIT');
      return removed;
    } catch (error) {
      try { this.db.exec('ROLLBACK'); } catch {}
      throw error;
    }
  }

  modelSelection(agentId) {
    const agent = normalize(agentId);
    if (!agent) throw new Error('agent_id_invalid');
    const row = this.db.prepare('SELECT agent_id, connection_id, model_id, reasoning_effort, temperature, updated_at FROM agent_model_selections WHERE agent_id=?').get(agent);
    if (!row) return null;
    return { agentId: row.agent_id, connectionId: row.connection_id, model: row.model_id, reasoningEffort: row.reasoning_effort, temperature: Number(row.temperature), updatedAt: row.updated_at };
  }

  persistAuth(connectionId, auth, timestamp = now()) {
    const connection = this.get(connectionId);
    if (connection && auth?.type === 'oauth' && openAiLikeProvider(auth.provider || connection.provider) && isChatGptBackendUrl(connection.baseUrl) && connection.apiType !== 'openai-responses') {
      this.db.prepare('UPDATE model_connections SET api_type=?, updated_at=? WHERE id=?').run('openai-responses', timestamp, connectionId);
    }
    this.saveSecret(connectionId, AUTH_SECRET_NAME, JSON.stringify(auth), timestamp);
    this.db.prepare(`INSERT INTO settings_meta (key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .run(`model_auth_preview:${connectionId}`, JSON.stringify(secretPreview(auth, this.get(connectionId)?.provider || auth.provider)), timestamp);
    return auth;
  }

  async resolveAuth(id, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
    const connection = this.get(id);
    if (!connection) throw new Error('model_connection_not_found');
    let auth = this.auth(connection.id);
    if (!auth) throw new Error('model_connection_auth_required');
    if (auth.type === 'oauth' && !isOauthFresh(auth, nowMs)) {
      const refreshKey = `${connection.id}:${auth.refreshToken || ''}`;
      let refresh = oauthRefreshes.get(refreshKey);
      if (!refresh) {
        refresh = (async () => {
          const provider = auth.provider || connection.provider;
          let refreshed;
          if (openAiLikeProvider(provider)) refreshed = await refreshOpenAiOAuth(auth, { fetchImpl, nowMs });
          else if (anthropicLikeProvider(provider)) refreshed = await refreshAnthropicOauth(auth, { fetchImpl, nowMs });
          else throw new Error('model_auth_refresh_provider_unsupported');
          return this.persistAuth(connection.id, refreshed);
        })();
        oauthRefreshes.set(refreshKey, refresh);
      }
      try { auth = await refresh; }
      finally { if (oauthRefreshes.get(refreshKey) === refresh) oauthRefreshes.delete(refreshKey); }
    }
    const token = authToken(auth);
    if (!token) throw new Error('model_connection_auth_required');
    return {
      type: auth.type || 'api_key',
      provider: auth.provider || connection.provider,
      source: auth.source || null,
      token,
      expiresAt: auth.expiresAt || null,
    };
  }

  saveModelSelection({ agentId, connectionId, model, reasoningEffort = 'off', temperature = undefined } = {}) {
    const agent = normalize(agentId);
    const connection = this.get(normalize(connectionId));
    const modelId = normalize(model);
    if (!agent) throw new Error('agent_id_invalid');
    if (!connection) throw new Error('model_connection_not_found');
    const enabled = connection.models.find((item) => item.id === modelId && item.selected !== false);
    if (!enabled) throw new Error('model_not_enabled_for_connection');
    if (!this.hasAuth(connection.id)) throw new Error('model_connection_auth_required');
    const effort = normalizeReasoningEffort(reasoningEffort);
    const priorSelection = this.modelSelection(agent);
    const selectedTemperature = normalizeTemperature(temperature, priorSelection?.temperature ?? 0.2);
    if (enabled.reasoningEfforts?.length && effort !== 'off' && !enabled.reasoningEfforts.includes(effort)) throw new Error('model_reasoning_effort_not_supported');
    const timestamp = now();
    this.db.prepare(`INSERT INTO agent_model_selections (agent_id,connection_id,model_id,reasoning_effort,temperature,updated_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(agent_id) DO UPDATE SET connection_id=excluded.connection_id, model_id=excluded.model_id, reasoning_effort=excluded.reasoning_effort, temperature=excluded.temperature, updated_at=excluded.updated_at`)
      .run(agent, connection.id, modelId, effort, selectedTemperature, timestamp);
    return this.modelSelection(agent);
  }

  identities() {
    const agents = this.db.prepare(`SELECT id, name, avatar, updated_at AS updatedAt FROM chat_identities WHERE kind='agent' ORDER BY CASE id WHEN 'hatchet' THEN 0 ELSE 1 END, id`).all();
    const operator = this.db.prepare(`SELECT id, name, avatar, updated_at AS updatedAt FROM chat_identities WHERE kind='operator' AND id='default'`).get()
      || { id: 'default', name: this.defaultIdentityName('operator'), avatar: '', updatedAt: null };
    if (this.bootstrapSampleIdentities && !agents.some((agent) => agent.id === 'hatchet')) agents.unshift({ id: 'hatchet', name: 'Hatchet', avatar: '', updatedAt: null });
    return { operator, agents };
  }

  defaultIdentityName(kind) {
    if (this.bootstrapSampleIdentities) return kind === 'operator' ? 'Rob' : 'Hatchet';
    return '';
  }

  saveIdentity(input = {}) {
    const identity = assertIdentity(input);
    const existing = this.db.prepare(`SELECT name, avatar FROM chat_identities WHERE kind=? AND id=?`).get(identity.kind, identity.id);
    const name = identity.name === undefined ? (existing?.name || this.defaultIdentityName(identity.kind)) : identity.name;
    const avatar = identity.avatar === undefined ? (existing?.avatar || '') : identity.avatar;
    const timestamp = now();
    this.db.prepare(`INSERT INTO chat_identities (kind, id, name, avatar, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, id) DO UPDATE SET name=excluded.name, avatar=excluded.avatar, updated_at=excluded.updated_at`)
      .run(identity.kind, identity.id, name, avatar, timestamp, timestamp);
    return this.identities();
  }
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

export async function refreshCodexClientVersionCache({ store, db, fetchImpl = fetch, signal = undefined, nowMs = Date.now() } = {}) {
  const target = store || db;
  const attempts = [
    ['npm', NPM_CODEX_LATEST_URL],
    ['github', GITHUB_CODEX_LATEST_URL],
  ];
  let lastError = null;
  for (const [source, url] of attempts) {
    try {
      const version = await fetchCodexVersionFromUrl(url, { fetchImpl, signal, source });
      return writeCodexClientVersionCache(target, { currentVersion: version, source, lastCheckedAt: new Date(nowMs).toISOString(), lastError: null }, { nowMs });
    } catch (error) { lastError = error; }
  }
  return writeCodexClientVersionCache(target, { lastCheckedAt: new Date(nowMs).toISOString(), lastError: String(lastError?.message || lastError || 'codex_client_version_refresh_failed') }, { nowMs });
}

export function resolveCodexClientVersion({ store, db, nowMs = Date.now(), refresh = false, fetchImpl = fetch, signal = undefined } = {}) {
  const target = store || db;
  const cache = readCodexClientVersionCache(target);
  if (!refresh || codexClientVersionCacheFresh(cache, nowMs)) return Promise.resolve({ version: codexClientVersionFromCache(cache), cache, refreshed: false });
  return refreshCodexClientVersionCache({ store, db, fetchImpl, signal, nowMs }).then((next) => ({ version: codexClientVersionFromCache(next), cache: next, refreshed: true }));
}

export async function discoverModels({ baseUrl, apiType = 'openai-responses', apiKey, auth = {}, fetchImpl = fetch, signal = undefined, store = null, db = null, codexClientVersion = undefined, nowMs = Date.now() } = {}) {
  if (isChatGptBackendUrl(baseUrl) && openAiLikeProvider(auth.provider || 'OpenAI')) {
    const target = store || db;
    const initial = parseSemver(codexClientVersion)?.raw || (await resolveCodexClientVersion({ store, db, nowMs, refresh: false })).version;
    const headers = chatGptCodexCatalogHeaders({ apiKey, auth });
    const versions = [...new Set([initial, readCodexClientVersionCache(target).lastGoodCatalogVersion, CODEX_CLIENT_VERSION_FLOOR].map((value) => parseSemver(value)?.raw).filter(Boolean))];
    let lastError = null;
    for (const version of versions) {
      const response = await fetchImpl(chatGptCodexModelsUrl(baseUrl, version), { headers, signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) { lastError = new Error(`model_discovery_failed:${response.status}`); continue; }
      const models = normalizeCodexCatalogModels(body);
      const minimumObservedModelVersion = observedMinimumClientVersion(body);
      if (target) writeCodexClientVersionCache(target, { lastGoodCatalogVersion: version, minimumObservedModelVersion, lastCatalogAt: new Date(nowMs).toISOString(), lastCatalogCount: models.length }, { nowMs });
      return models;
    }
    throw lastError || new Error('model_discovery_failed');
  }

  const url = modelDiscoveryUrl({ baseUrl, apiType });
  return fetchImpl(url, { headers: modelDiscoveryHeaders({ apiType, apiKey, auth }), signal })
    .then(async (response) => {
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(`model_discovery_failed:${response.status}`);
      const data = Array.isArray(body.data) ? body.data : Array.isArray(body.models) ? body.models : [];
      return normalizeModels(data.map((model) => ({ ...model, id: model?.id, selected: false, manual: false })));
    });
}
