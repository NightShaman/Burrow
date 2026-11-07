import { googleNativeApi, discoverGoogleModels } from './model-adapters/google-native-catalog.mjs';
import { openaiOAuthIdentity } from './openai-oauth-login.mjs';
import { normalizeModels } from './model-settings-normalization.mjs';
import { openAiLikeProvider, isChatGptBackendUrl } from './model-settings-auth.mjs';
import { modelHttpError } from './model-settings-diagnostics.mjs';
import { parseSemver, maxSemver, CODEX_CLIENT_VERSION_FLOOR, readCodexClientVersionCacheAsync, writeCodexClientVersionCacheAsync, resolveCodexClientVersion } from './codex-client-version.mjs';
import { MODELS_DEV_CATALOG_URL, MODELS_DEV_CATALOG_CACHE_TTL_MS, modelsDevSnapshot, modelsDevProviderIdentity, enrichFromModelsDev } from './models-dev-catalog.mjs';

function normalize(value) { return String(value ?? '').trim(); }

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
    .map((model) => ({ ...model, id: model.slug || model.id, selected: true, manual: false })));
}

function observedMinimumClientVersion(body = {}) {
  const data = Array.isArray(body.models) ? body.models : Array.isArray(body.data) ? body.data : [];
  return maxSemver(data.map((model) => model?.minimal_client_version ?? model?.minimalClientVersion));
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
      if (!response.ok) { lastError = modelHttpError('model_discovery_failed', response.status); continue; }
      if (!Array.isArray(body.models)) throw Object.assign(new Error('model_discovery_invalid'), { upstreamStatus: response.status });
      const models = normalizeCodexCatalogModels(body);
      const minimumObservedModelVersion = observedMinimumClientVersion(body);
      if (target) await writeCodexClientVersionCacheAsync(target, { lastGoodCatalogVersion: version, minimumObservedModelVersion, lastCatalogAt: new Date(nowMs).toISOString(), lastCatalogCount: models.length }, { nowMs });
      return enrich(models);
    }
    throw lastError || new Error('model_discovery_failed');
  }

  const url = modelDiscoveryUrl({ baseUrl, apiType });
  const headers = modelDiscoveryHeaders({ apiType, apiKey, auth });
  const anthropic = normalize(apiType) === 'anthropic-messages';
  const models = [], cursors = new Set();
  let cursor = '';
  for (;;) {
    signal?.throwIfAborted();
    let pageUrl = url;
    if (cursor) {
      const next = new URL(url);
      next.searchParams.set('after_id', cursor);
      pageUrl = next.toString();
    }
    const response = await fetchImpl(pageUrl, { headers, signal });
    const body = await response.json().catch(error => {
      signal?.throwIfAborted();
      if (error?.name === 'AbortError') throw error;
      return {};
    });
    signal?.throwIfAborted();
    if (!response.ok) throw modelHttpError('model_discovery_failed', response.status);
    if (!Array.isArray(body?.data) && !Array.isArray(body?.models)) throw Object.assign(new Error('model_discovery_invalid'), { upstreamStatus: response.status });
    const data = Array.isArray(body.data) ? body.data : body.models;
    models.push(...data.map(model => ({ ...model, id: model?.id, selected: true, manual: false,
      ...(anthropic ? {
        capabilityProvenance: { source: 'anthropic-models-api', snapshotAt: new Date(nowMs).toISOString(), matchedProvider: 'anthropic', matchedModel: normalize(model.id) },
      } : {}),
    })));
    // Older native responses and compatible proxies may omit pagination. Never
    // return a partial catalogue as success when a provider declares more pages.
    if (!anthropic || (!cursor && body.has_more === undefined) || body.has_more === false) break;
    if (body.has_more !== true || !data.length || typeof body.last_id !== 'string' || !body.last_id.trim() || body.last_id !== data.at(-1)?.id || cursors.has(body.last_id)) {
      throw new Error('model_discovery_pagination_invalid');
    }
    cursor = body.last_id;
    cursors.add(cursor);
  }
  return enrich(normalizeModels(models, { provider, apiType }));
}
