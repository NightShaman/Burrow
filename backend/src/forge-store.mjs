import { imageOptionsCapability } from './model-adapters/image-generation-options.mjs';
import { googleNativeApi, googleMediaKind } from './model-adapters/google-native-catalog.mjs';
import { generatedArtifactKind } from './model-adapters/openai-generated-artifacts.mjs';
import { googleLyriaSupported } from './model-adapters/google-lyria.mjs';
import { referenceImageCapability } from './model-adapters/reference-image-capability.mjs';

export function forgeCatalog(connections) {
  const models = connections.flatMap(c => (c.models || []).filter(m => m.selected !== false).flatMap(m => {
    const outputs = m.acceptedOutputOverride ?? m.acceptedOutput ?? m.discoveredOutput ?? [];
    const inputs = m.acceptedInputOverride ?? m.acceptedInput ?? m.discoveredInput ?? c.acceptedInput;
    const config = { ...c, model: m.id, acceptedInput: inputs,
      acceptedOutput: m.acceptedOutputOverride ?? m.acceptedOutput ?? m.discoveredOutput,
      supportedGenerationMethods: m.supportedGenerationMethods };
    const nativeKind = googleNativeApi(c) ? googleMediaKind(config) : null;
    const google = googleLyriaSupported({ ...c, model: m.id });
    const effectiveOutputs = google && m.acceptedOutputOverride === undefined && m.acceptedOutput === undefined && !outputs.length ? ['audio'] : nativeKind && !outputs.length ? [nativeKind] : outputs;
    // Native image contracts return TEXT and IMAGE together; the generic
    // OpenAI media-only classifier intentionally rejects text outputs.
    const kind = effectiveOutputs.includes('video') ? 'video' : nativeKind || generatedArtifactKind({ capabilities: { outputs: effectiveOutputs } });
    if (!kind) return [];
    const available = kind !== 'video' && ( /^openai-/.test(c.apiType) || (kind === 'audio' && google) || nativeKind === kind );
    const agentReferenceImage = available && kind === 'image'
      ? referenceImageCapability({ ...config, capabilities: { inputs, outputs: effectiveOutputs } })
      : { available: false, reason: 'agent_reference_image_unsupported' };
    const imageOptions = available && kind === 'image' ? imageOptionsCapability({ ...config, capabilities: { inputs, outputs: effectiveOutputs } }) : null;
    return [{ ...(imageOptions ? { imageOptions } : {}), connectionId: c.id, modelId: m.id, label: m.name || m.id, kind, available, unavailableReason: available ? null : kind === 'video' ? 'video_provider_contract_unavailable' : 'provider_contract_unavailable', controls: [], agentReferenceImage }];
  }));
  const musicModels = models.filter(m => m.kind === 'audio' && m.available && googleLyriaSupported({ ...connections.find(c => c.id === m.connectionId), model: m.modelId }));
  const music = musicModels.length ? { available: true, reason: null, models: musicModels } : { available: false, reason: 'music_model_not_configured' };
  return { ok: true, models, music, sourceAttachments: { available: false, reason: 'source_attachments_unsupported' }, video: { available: false, reason: 'video_provider_contract_unavailable' } };
}

/** Legacy entry point: callers must inject the PostgreSQL store. */
export class ForgeStore {
  constructor() { throw new Error('forge_postgres_store_required'); }
}
