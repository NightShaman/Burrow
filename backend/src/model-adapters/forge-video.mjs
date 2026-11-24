import { createGoogleVideoAdapter } from './google-video.mjs';
import { createXaiVideoAdapter } from './xai-video.mjs';
import { videoContract } from './video-contract.mjs';

const factories = { google: createGoogleVideoAdapter, xai: createXaiVideoAdapter };

export function createForgeVideoAdapter(options = {}) {
  const factory = factories[videoContract(options.config)];
  if (!factory) throw new Error('video_provider_contract_unavailable');
  return factory(options);
}
