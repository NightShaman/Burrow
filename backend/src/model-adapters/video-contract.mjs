import { googleVideoSupported } from './google-native-catalog.mjs';

// A selected media output is not a transport contract. Match the native API
// boundary, not a connection label or generic OpenAI chat compatibility.
const XAI_VIDEO_MODELS = new Set([
  'grok-imagine-video',
  'grok-imagine-video-1.5',
  // Lite accepts one starting frame, not subject/style references.
  'grok-imagine-video-1.5-lite',
]);

export const VIDEO_REFERENCE_LIMIT = 6;

export function videoReferenceImageLimit(config = {}) {
  return config?.model === 'grok-imagine-video-1.5-lite' ? 1 : VIDEO_REFERENCE_LIMIT;
}

export function xaiVideoBase(config = {}) {
  try {
    const url = new URL(config.baseUrl);
    if (url.origin !== 'https://api.x.ai' || url.username || url.password || url.search || url.hash) return null;
    return ['', '/v1'].includes(url.pathname.replace(/\/+$/, '')) ? `${url.origin}/v1` : null;
  } catch { return null; }
}

export function videoContract(config) {
  if (!config) return null;
  if (googleVideoSupported(config)) return 'google';
  const outputs = config.acceptedOutputOverride ?? config.capabilities?.outputs ?? config.acceptedOutput ?? config.discoveredOutput;
  const api = config.api || config.apiType;
  return ['openai-chat-completions', 'openai-responses'].includes(api)
    && XAI_VIDEO_MODELS.has(config.model)
    && config.authConfigured !== false
    && (!config.auth?.type || config.auth.type === 'api_key' || config.auth.type === 'token')
    && (outputs === undefined || (Array.isArray(outputs) && outputs.includes('video')))
    && xaiVideoBase(config) ? 'xai' : null;
}

export function videoReferenceImagesSupported(config) {
  const contract = videoContract(config);
  if (!contract) return false;
  const inputs = config.acceptedInputOverride ?? config.capabilities?.inputs ?? config.acceptedInput ?? config.discoveredInput;
  if (inputs !== undefined) return Array.isArray(inputs) && inputs.includes('image');
  const flags = [config.capabilities?.images, config.capabilities?.vision, config.supportsVision, config.vision];
  return !flags.some(value => typeof value === 'boolean') || flags.includes(true);
}
