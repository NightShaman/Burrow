import { operationalEvent } from './operational-log.mjs';
import { safeModelMetadata, normalizedCatalogModalities } from './model-settings-normalization.mjs';
import { openAiLikeProvider } from './model-settings-auth.mjs';
import { safeCacheRecord, cacheGetAsync, cacheSetAsync } from './model-catalog-cache.mjs';
import { modelHttpError, modelSettingsFailureDiagnostic } from './model-settings-diagnostics.mjs';

function normalize(value) { return String(value ?? '').trim(); }

const MODELS_DEV_CATALOG_META_KEY = 'models_dev_catalog';

export const MODELS_DEV_CATALOG_URL = 'https://models.dev/catalog.json';

export const MODELS_DEV_CATALOG_CACHE_TTL_MS = 24 * 60 * 60_000;

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

export function enrichFromModelsDev(models, catalog, { provider, snapshotAt } = {}) {
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
      ...(Array.isArray(modalities.input) ? { discoveredInput: normalizedCatalogModalities(modalities.input, { input: true }) } : {}),
      ...(Array.isArray(modalities.output) ? { discoveredOutput: normalizedCatalogModalities(modalities.output) } : {}),
    });
    // Provider responses are authoritative. The catalog only fills absent fields;
    // explicit operator overrides remain on the provider-normalized model.
    const provenance = { source: 'models.dev', snapshotAt, matchedProvider: normalize(matchProvider.id || matchProvider.key), matchedModel: normalize(match.id || match.key) };
    const fills = Object.fromEntries(Object.entries(catalogMetadata).filter(([key]) => model[key] === undefined));
    return {
      ...fills,
      ...model,
      capabilityProvenance: model.capabilityProvenance ?? provenance,
      ...(model.capabilityProvenance && Object.keys(fills).length ? { fallbackCapabilityProvenance: { ...provenance, fields: Object.keys(fills) } } : {}),
    };
  });
}

// Runtime-only state also covers failures before any catalog has been cached.
// A fresh/stale cache hit is not evidence that the upstream recovered.
const modelsDevOutages = new WeakSet();

function modelsDevFetchTransition(store, available, error = null, cached = {}) {
  if (!store?.logger) return;
  if (!available) {
    if (modelsDevOutages.has(store)) return;
    modelsDevOutages.add(store);
    const { errorCode, errorType, classification, upstreamStatus } = modelSettingsFailureDiagnostic(error, 'models_dev_catalog_failed');
    operationalEvent(store.logger, 'models_dev_catalog_unavailable', {
      dependency: 'models_dev_catalog', errorCode, errorType, classification,
      ...(upstreamStatus === undefined ? {} : { upstreamStatus }),
      fallback: cached.catalog ? 'stale_cache' : 'provider_only',
    }, { level: 'warn', component: 'model-settings' });
  } else if (modelsDevOutages.delete(store)) {
    operationalEvent(store.logger, 'models_dev_catalog_restored', { dependency: 'models_dev_catalog' }, { level: 'info', component: 'model-settings' });
  }
}

export async function modelsDevSnapshot({ store, fetchImpl = fetch, signal, nowMs = Date.now(), catalogUrl = MODELS_DEV_CATALOG_URL, ttlMs = MODELS_DEV_CATALOG_CACHE_TTL_MS } = {}) {
  const target = store;
  const cached = safeCacheRecord(await cacheGetAsync(target, MODELS_DEV_CATALOG_META_KEY));
  const checked = Date.parse(cached.lastCheckedAt || '');
  if (cached.catalog && Number.isFinite(checked) && nowMs - checked < Math.max(1, Number(ttlMs) || MODELS_DEV_CATALOG_CACHE_TTL_MS)) return cached;
  let fetched = false;
  try {
    const headers = { accept: 'application/json', 'user-agent': 'Burrow/models-dev-catalog' };
    if (cached.etag) headers['if-none-match'] = cached.etag;
    const response = await fetchImpl(catalogUrl, { headers, signal });
    const checkedAt = new Date(nowMs).toISOString();
    let next;
    if (response.status === 304 && cached.catalog) next = { ...cached, lastCheckedAt: checkedAt, lastError: null };
    else {
      const body = await response.json().catch(() => null);
      if (!response.ok || !body || typeof body !== 'object') throw modelHttpError('models_dev_catalog_failed', response.status);
      next = { catalog: body, etag: response.headers.get('etag') || null, snapshotAt: checkedAt, lastCheckedAt: checkedAt, lastError: null };
    }
    fetched = true;
    modelsDevFetchTransition(target, true);
    if (target) await cacheSetAsync(target, MODELS_DEV_CATALOG_META_KEY, next, nowMs);
    return next;
  } catch (error) {
    // Preserve the existing persistence/fallback path, but do not mislabel a
    // cache write failure after a healthy fetch as an upstream outage.
    if (!fetched) modelsDevFetchTransition(target, false, error, cached);
    if (cached.catalog) {
      const next = { ...cached, lastCheckedAt: new Date(nowMs).toISOString(), lastError: modelSettingsFailureDiagnostic(error) };
      if (target) await cacheSetAsync(target, MODELS_DEV_CATALOG_META_KEY, next, nowMs);
      return next;
    }
    return null;
  }
}

export function modelsDevProviderIdentity({ provider = '', apiType = '', baseUrl = '', auth = {} } = {}) {
  const type = normalize(apiType).toLowerCase();
  let hostname = '';
  try { hostname = new URL(normalize(baseUrl)).hostname.toLowerCase(); } catch {}
  if (type === 'anthropic-messages') return 'anthropic';
  if (hostname.endsWith('.openai.azure.com') || hostname.endsWith('.services.ai.azure.com')) return 'azure';
  if (hostname === 'api.openai.com' || hostname === 'chatgpt.com' || openAiLikeProvider(auth.provider)) return 'openai';
  return normalize(provider);
}
