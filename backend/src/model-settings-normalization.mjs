import { isProviderPool, normalizeProviderPool } from './provider-pool-settings.mjs';
import { canonicalizeOauthConnection } from './model-settings-auth.mjs';
import { anthropicSupportsTemperature, isAnthropicMessagesConnection, normalizeAnthropicModelMetadata, anthropicDiscoveredReasoningEfforts, anthropicThinkingCapabilities } from './anthropic-model-capabilities.mjs';

function normalize(value) { return String(value ?? '').trim(); }

function asBoolean(value) { return value === true || value === 1; }

function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }

function positiveInteger(value) { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : null; }

export function assertConnection(input = {}) {
  const provider = normalize(input.provider);
  const apiType = normalize(input.apiType);
  const baseUrl = normalize(input.baseUrl || (isProviderPool(input) ? 'https://pool.invalid' : '')).replace(/\/+$/, '');
  if (!provider) throw new Error('provider_required');
  if (!apiType) throw new Error('api_type_required');
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error('base_url_invalid');
  const acceptedInput = [...new Set((Array.isArray(input.acceptedInput) ? input.acceptedInput : []).map(normalize).filter((type) => ['text', 'image'].includes(type)))];
  return { provider, apiType, baseUrl, acceptedInput, autoUseExpiringResets: input.autoUseExpiringResets === true && !isProviderPool(input), ...(isProviderPool(input) ? { pool: normalizeProviderPool(input.pool) } : {}) };
}

const MODEL_INPUT_CAPABILITIES = Object.freeze(['text', 'image', 'audio', 'video', 'file']);

const MODEL_OUTPUT_CAPABILITIES = Object.freeze(['text', 'audio', 'image', 'video', 'file']);

function normalizedInput(value) {
  return [...new Set((Array.isArray(value) ? value : []).map(normalize).filter((type) => MODEL_INPUT_CAPABILITIES.includes(type)))];
}

export function normalizedCatalogModalities(value, { input = false } = {}) {
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
  const fields = Array.isArray(value.fields) ? value.fields.filter(field => ['displayName', 'discoveredContextWindow', 'contextWindow', 'outputTokens', 'discoveredInput', 'discoveredOutput'].includes(field)) : null;
  return source && snapshotAt && matchedProvider && matchedModel ? { source, snapshotAt, matchedProvider, matchedModel, ...(fields ? { fields } : {}) } : null;
}

export function safeModelMetadata(model = {}, { provider = '', apiType = '' } = {}) {
  const metadata = model?.metadata && typeof model.metadata === 'object' ? model.metadata : {};
  const capabilities = model?.capabilities && typeof model.capabilities === 'object' ? model.capabilities : {};
  const nativeProtocol = ['anthropic-messages', 'anthropic-lb'].includes(normalize(apiType));
  const incompatibleNative = apiType && !nativeProtocol && (model.anthropicMetadata || model.capabilityProvenance?.source === 'anthropic-models-api');
  const nativeOwned = !incompatibleNative && Object.hasOwn(model, 'anthropicMetadata');
  const wrappedNative = nativeOwned ? normalizeAnthropicModelMetadata(model.anthropicMetadata) : null;
  const anthropicMetadata = wrappedNative ?? (nativeProtocol && !Object.hasOwn(model, 'anthropicMetadata') ? normalizeAnthropicModelMetadata(model) : null);
  const nativeFields = new Set([
    ...(Number.isSafeInteger(anthropicMetadata?.max_input_tokens) ? ['discoveredContextWindow', 'contextWindow'] : []),
    ...(Number.isSafeInteger(anthropicMetadata?.max_tokens) ? ['outputTokens'] : []),
    ...(typeof anthropicMetadata?.capabilities?.image_input?.supported === 'boolean' ? ['discoveredInput'] : []),
  ]);
  const fallbackProvenance = incompatibleNative ? null : normalizeCapabilityProvenance(model.fallbackCapabilityProvenance);
  const fallbackFields = (fallbackProvenance?.fields || []).filter(field => !nativeFields.has(field));
  const unknownNativeFields = new Set([
    ...(nativeOwned && model.anthropicMetadata === null ? ['discoveredInput', 'discoveredOutput', 'reasoningEfforts', 'discoveredContextWindow', 'contextWindow', 'outputTokens'] : []),
    ...(anthropicMetadata?.max_input_tokens === null ? ['discoveredContextWindow', 'contextWindow'] : []),
    ...(anthropicMetadata?.max_tokens === null ? ['outputTokens'] : []),
    ...(anthropicMetadata?.capabilities === null ? ['discoveredInput', 'reasoningEfforts'] : []),
    ...(anthropicMetadata?.capabilities?.image_input === null ? ['discoveredInput'] : []),
    ...(anthropicMetadata?.capabilities?.effort === null ? ['reasoningEfforts'] : []),
  ]);
  // Explicit native unknowns invalidate echoed projections, unless a separately
  // attributed fallback supplies them. Absent native fields may coexist with
  // generic metadata from compatible proxies. New refresh snapshots are merged
  // separately, so omission cannot revive an older snapshot's fields.
  const projected = key => incompatibleNative || (unknownNativeFields.has(key) && !fallbackFields.includes(key)) ? undefined : model[key];
  const nativeImageInput = anthropicMetadata?.capabilities?.image_input?.supported;
  const nativeInput = typeof nativeImageInput === 'boolean' ? ['text', ...(nativeImageInput ? ['image'] : [])] : null;
  const nativeEfforts = anthropicDiscoveredReasoningEfforts(anthropicMetadata);
  const override = model.acceptedInputOverride ?? model.accepted_input_override;
  const suppliedDiscovered = Array.isArray(projected('discoveredInput')) ? normalizedInput(projected('discoveredInput')) : null;
  const discovered = nativeInput ?? suppliedDiscovered ?? discoveredInput(model, metadata, capabilities);
  const suppliedOutput = Array.isArray(projected('discoveredOutput')) ? normalizedOutput(projected('discoveredOutput')) : null;
  const discoveredOutputs = suppliedOutput ?? discoveredOutput(model, metadata, capabilities);
  const outputOverride = model.acceptedOutputOverride ?? model.accepted_output_override;
  const displayName = normalize(model.displayName ?? model.display_name ?? model.label ?? model.name ?? metadata.display_name ?? metadata.displayName);
  const supportedReasoningLevels = incompatibleNative || unknownNativeFields.has('reasoningEfforts') ? [] : Array.isArray(projected('reasoningEfforts'))
    ? projected('reasoningEfforts')
    : Array.isArray(model.supportedReasoningLevels)
      ? model.supportedReasoningLevels
      : Array.isArray(model.supported_reasoning_levels)
        ? model.supported_reasoning_levels
        : Array.isArray(metadata.supported_reasoning_levels)
          ? metadata.supported_reasoning_levels
          : Array.isArray(metadata.supportedReasoningLevels)
            ? metadata.supportedReasoningLevels
            : [];
  const reasoningEfforts = nativeEfforts ?? [...new Set(supportedReasoningLevels
    .map((level) => normalize(typeof level === 'string' ? level : level?.effort ?? level?.id ?? level?.name))
    .filter(Boolean))];
  const defaultReasoningEffort = normalize(model.defaultReasoningEffort ?? model.default_reasoning_effort ?? model.default_reasoning_level ?? model.defaultReasoningLevel ?? metadata.default_reasoning_level ?? metadata.defaultReasoningLevel);
  const knownCapabilities = knownModelCapabilities({ provider, apiType, modelId: model.id });
  const supportsTemperatureValue = model.supportsTemperature ?? model.supports_temperature ?? metadata.supportsTemperature ?? metadata.supports_temperature ?? capabilities.supportsTemperature ?? capabilities.supports_temperature ?? knownCapabilities.supportsTemperature;
  const outputTokens = positiveInteger(anthropicMetadata?.max_tokens) ?? positiveInteger(projected('outputTokens') ?? model.output_tokens ?? model.maxOutputTokens ?? model.max_output_tokens ?? metadata.output_tokens ?? metadata.outputTokens ?? metadata.max_output_tokens ?? metadata.maxOutputTokens ?? capabilities.output_tokens ?? capabilities.outputTokens ?? capabilities.max_output_tokens ?? capabilities.maxOutputTokens);
  const suppliedDiscoveredContextWindow = positiveInteger(projected('discoveredContextWindow') ?? model.discovered_context_window);
  const providerContextWindow = positiveInteger(model.context_window ?? metadata.context_window ?? metadata.contextWindow ?? capabilities.context_length ?? anthropicMetadata?.max_input_tokens);
  const legacyContextWindow = positiveInteger(projected('contextWindow'));
  const contextWindowOverride = positiveInteger(model.contextWindowOverride ?? model.context_window_override);
  const discoveredContextWindow = positiveInteger(anthropicMetadata?.max_input_tokens) ?? suppliedDiscoveredContextWindow ?? providerContextWindow ?? (!contextWindowOverride ? legacyContextWindow : null);
  const contextWindow = contextWindowOverride ?? discoveredContextWindow;
  const capabilityProvenance = incompatibleNative ? null : normalizeCapabilityProvenance(model.capabilityProvenance);
  const fallbackCapabilityProvenance = fallbackFields.length ? { ...fallbackProvenance, fields: fallbackFields } : null;
  return {
    ...(nativeProtocol ? anthropicThinkingCapabilities({ model: model.id, anthropicMetadata, reasoningEfforts: reasoningEfforts.length ? reasoningEfforts : undefined }) : {}),
    ...(anthropicMetadata ? { anthropicMetadata } : nativeOwned && model.anthropicMetadata === null ? { anthropicMetadata: null } : {}),
    ...(Array.isArray(model.supportedGenerationMethods) ? { supportedGenerationMethods: model.supportedGenerationMethods.filter(x => typeof x === 'string') } : {}),
    ...(model.googleMetadata && typeof model.googleMetadata === 'object' ? { googleMetadata: Object.fromEntries(['name','baseModelId','version','description','inputTokenLimit','outputTokenLimit','thinking','temperature','maxTemperature','topP','topK','metadataSource','outputCapabilitySource'].filter(k => model.googleMetadata[k] !== undefined).map(k => [k, model.googleMetadata[k]])) } : {}),
    ...(displayName ? { displayName } : {}),
    ...(capabilityProvenance ? { capabilityProvenance } : {}),
    ...(fallbackCapabilityProvenance ? { fallbackCapabilityProvenance } : {}),
    ...(reasoningEfforts.length || nativeEfforts !== undefined || (!incompatibleNative && !unknownNativeFields.has('reasoningEfforts') && Array.isArray(projected('reasoningEfforts'))) ? { reasoningEfforts } : {}),
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

// A new native catalogue snapshot replaces provider facts, not operator intent.
// Selection-only saves still patch existing metadata; an absent proxy capability
// is unknown and must not revive an old native projection during refresh.
export function mergeModelMetadata(prior, model, { provider = '', apiType = '', refresh = false } = {}) {
  const nativeSnapshot = apiType === 'anthropic-messages' && (refresh || model.anthropicMetadata || model.capabilityProvenance?.source === 'anthropic-models-api');
  const retained = nativeSnapshot ? Object.fromEntries(
    ['acceptedInputOverride', 'acceptedOutputOverride', 'contextWindowOverride', 'selected', 'manual']
      .filter(key => prior?.[key] !== undefined).map(key => [key, prior[key]]),
  ) : prior;
  return normalizeModels([{ ...retained, ...model }], { provider, apiType })[0];
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
    autoUseExpiringResets: row.auto_use_expiring_resets === true && !isProviderPool({ apiType: canonical.apiType }),
    ...(isProviderPool({ apiType: canonical.apiType }) ? { pool: parseJson(row.pool_json, null) } : {}),
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
