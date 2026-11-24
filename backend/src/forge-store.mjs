import { videoOptionsCapability } from './model-adapters/video-generation-options.mjs';
import { imageOptionsCapability } from './model-adapters/image-generation-options.mjs';
import { forgeMediaContract, forgeModelConfig, forgeConnectionModels, declaredForgeKind } from './model-adapters/forge-media-contract.mjs';

export function forgeCatalog(connections) {
  const models = connections.flatMap(connection => forgeConnectionModels(connection).filter(model => model.selected !== false).flatMap(model => {
    const config = forgeModelConfig(connection, model);
    const contract = forgeMediaContract(config);
    const kind = contract?.kind || declaredForgeKind(config);
    if (!kind) return [];
    const available = Boolean(contract);
    const agentReferenceImage = contract?.referenceImages
      ? { available: true, reason: null }
      : { available: false, reason: 'agent_reference_image_unsupported' };
    const referenceArtifacts = contract?.referenceImages
      ? { available: true, ...(contract.referenceImageLimit ? { maxImages: contract.referenceImageLimit } : {}) }
      : { available: false };
    const videoOptions = available && kind === 'video' ? videoOptionsCapability(config) : null;
    const imageOptions = available && kind === 'image' ? imageOptionsCapability(config) : null;
    return [{ connectionId: connection.id, modelId: model.id, label: model.name || model.id, kind,
      ...(contract ? { mode: contract.mode } : {}),
      ...(contract?.connectionLevel ? { connectionLevel: true } : {}),
      available, unavailableReason: available ? null : kind === 'video' ? 'video_provider_contract_unavailable' : 'provider_contract_unavailable',
      controls: [], agentReferenceImage, referenceArtifacts, referenceAttachments: { ...referenceArtifacts },
      ...(imageOptions ? { imageOptions } : {}), ...(videoOptions ? { videoOptions } : {}) }];
  }));
  const musicModels = models.filter(model => model.available && model.mode === 'music');
  const music = musicModels.length ? { available: true, reason: null, models: musicModels } : { available: false, reason: 'music_model_not_configured' };
  return { ok: true, models, music, sourceAttachments: { available: models.some(model => model.referenceAttachments.available), field: 'referenceAttachmentIds' },
    video: models.some(model => model.kind === 'video' && model.available)
      ? { available: true, reason: null } : { available: false, reason: 'video_provider_contract_unavailable' } };
}

/** Legacy entry point: callers must inject the PostgreSQL store. */
export class ForgeStore {
  constructor() { throw new Error('forge_postgres_store_required'); }
}
