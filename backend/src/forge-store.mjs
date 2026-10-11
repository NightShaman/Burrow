import { googleNativeApi, googleMediaKind } from './model-adapters/google-native-catalog.mjs';
import { generatedArtifactKind } from './model-adapters/openai-generated-artifacts.mjs';
import { googleLyriaSupported } from './model-adapters/google-lyria.mjs';

export function forgeCatalog(connections) {
  const models = connections.flatMap(c => (c.models || []).filter(m => m.selected !== false).flatMap(m => {
    const outputs = m.acceptedOutput ?? m.discoveredOutput ?? [];
    const nativeKind = googleNativeApi(c) ? googleMediaKind({ ...c, model: m.id, acceptedOutput: m.acceptedOutputOverride ?? m.acceptedOutput, supportedGenerationMethods: m.supportedGenerationMethods }) : null;
    const google = googleLyriaSupported({ ...c, model: m.id });
    const effectiveOutputs = google && m.acceptedOutputOverride === undefined && m.acceptedOutput === undefined && !outputs.length ? ['audio'] : nativeKind && !outputs.length ? [nativeKind] : outputs;
    // Native image contracts return TEXT and IMAGE together; the generic
    // OpenAI media-only classifier intentionally rejects text outputs.
    const kind = effectiveOutputs.includes('video') ? 'video' : nativeKind || generatedArtifactKind({ capabilities: { outputs: effectiveOutputs } });
    if (!kind) return [];
    const available = kind !== 'video' && ( /^openai-/.test(c.apiType) || (kind === 'audio' && google) || nativeKind === kind );
    return [{ connectionId: c.id, modelId: m.id, label: m.name || m.id, kind, available, unavailableReason: available ? null : kind === 'video' ? 'video_provider_contract_unavailable' : 'provider_contract_unavailable', controls: [] }];
  }));
  const musicModels = models.filter(m => m.kind === 'audio' && m.available && googleLyriaSupported({ ...connections.find(c => c.id === m.connectionId), model: m.modelId }));
  const music = musicModels.length ? { available: true, reason: null, models: musicModels } : { available: false, reason: 'music_model_not_configured' };
  return { ok: true, models, music, sourceAttachments: { available: false, reason: 'source_attachments_unsupported' }, video: { available: false, reason: 'video_provider_contract_unavailable' } };
}

/** Legacy entry point: callers must inject the PostgreSQL store. */
export class ForgeStore {
  constructor() { throw new Error('forge_postgres_store_required'); }
}
