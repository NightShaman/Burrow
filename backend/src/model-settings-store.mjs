// Compatibility facade. New consumers should import the owner modules directly.
// PostgreSQL remains the sole settings persistence/OAuth transaction authority.
export { settingsKeyFromEnvironment } from './settings-key.mjs';
export { encrypt, decrypt } from './model-secret-codec.mjs';
export { modelSettingsFailureDiagnostic } from './model-settings-diagnostics.mjs';
export { isProviderPool, normalizeProviderPool, assertProviderPoolMembers, providerPoolModels } from './provider-pool-settings.mjs';
export { assertConnection, normalizeModels, mergeModelMetadata, normalizeTemperature, normalizeReasoningEffort, assertIdentity, publicConnection } from './model-settings-normalization.mjs';
export { secretPreview, normalizeAuth, mergeOpenAiOAuthTokens, canonicalizeOauthConnection, refreshAnthropicOauth } from './model-settings-auth.mjs';
export { CODEX_CLIENT_VERSION_FLOOR, CODEX_CLIENT_VERSION_CACHE_TTL_MS, refreshCodexClientVersionCache, resolveCodexClientVersion } from './codex-client-version.mjs';
export { MODELS_DEV_CATALOG_URL, MODELS_DEV_CATALOG_CACHE_TTL_MS } from './models-dev-catalog.mjs';
export { discoverModels } from './model-catalog-service.mjs';

// Compatibility export only; persistence requires the PostgreSQL store.
export class ModelSettingsStore {
  constructor() { throw new Error('postgres_required'); }
}
