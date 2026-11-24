import { forgeMediaContract } from './forge-media-contract.mjs';
import { createOpenAIGeneratedArtifactAdapter } from './openai-generated-artifacts.mjs';
import { createGoogleMediaAdapter } from './google-media.mjs';
import { createGoogleLyriaAdapter } from './google-lyria.mjs';
import { createGoogleSpeechAdapter } from './google-speech.mjs';
import { createXaiMediaAdapter } from './xai-media.mjs';
import { createForgeVideoAdapter } from './forge-video.mjs';

export function createForgeMediaAdapter(options = {}) {
  const contract = forgeMediaContract(options.config);
  if (!contract) throw new Error('provider_contract_unavailable');
  if (contract.mode === 'video') return (options.videoAdapterFactory || createForgeVideoAdapter)(options);
  if (contract.provider === 'xai') return (options.xaiAdapterFactory || createXaiMediaAdapter)(options);
  if (contract.id === 'google-speech') return (options.speechAdapterFactory || createGoogleSpeechAdapter)(options);
  if (contract.id === 'google-music') return (options.googleAdapterFactory || createGoogleLyriaAdapter)(options);
  if (contract.id === 'google-image') return (options.googleImageAdapterFactory || createGoogleMediaAdapter)({ ...options, config: { ...options.config, api: 'google-generative-language' } });
  return (options.adapterFactory || createOpenAIGeneratedArtifactAdapter)(options);
}
