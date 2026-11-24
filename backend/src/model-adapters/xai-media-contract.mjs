import { xaiVideoBase } from './video-contract.mjs';

// Exact current image IDs and the published 1.0 alias, not name heuristics.
// https://docs.x.ai/developers/models/grok-imagine-image
// https://docs.x.ai/developers/models/grok-imagine-image-2.0
export const XAI_IMAGE_MODELS = Object.freeze([
  'grok-imagine-image', 'grok-imagine-image-2026-03-02', 'grok-imagine-image-2.0',
]);
export const XAI_IMAGE_REFERENCE_LIMIT = 5;
export const XAI_IMAGE_OUTPUT_LIMIT = 10;
export const XAI_SPEECH_TEXT_LIMIT = 60_000;
// This is a Burrow connection-level selector, NOT an xAI model ID. /v1/tts
// accepts text + voice_id + language, with no provider model parameter.
// https://docs.x.ai/developers/model-capabilities/audio/text-to-speech
export const XAI_SPEECH_SELECTOR = 'xai-tts';
export const xaiMediaBase = xaiVideoBase;
export const isXaiMediaEndpoint = config => Boolean(config && xaiMediaBase(config));
// Negative-routing aid only: even an unsupported path/version/auth on the real
// xAI host must not fall through to a generic OpenAI media contract.
export function isXaiProviderEndpoint(config = {}) {
  try { return new URL(config.baseUrl).hostname === 'api.x.ai'; }
  catch { return false; }
}

const apis = new Set(['openai-chat-completions', 'openai-responses', 'openai-completions']);
const imageContract = Object.freeze({ id: 'xai-image', provider: 'xai', mode: 'image', kind: 'image' });
const speechContract = Object.freeze({ id: 'xai-speech', provider: 'xai', mode: 'speech', kind: 'audio', referenceImages: false, connectionLevel: true });

function referenceInputEnabled(config) {
  const inputs = config.acceptedInputOverride ?? config.capabilities?.inputs ?? config.acceptedInput ?? config.discoveredInput;
  if (inputs !== undefined) return Array.isArray(inputs) && inputs.includes('image');
  const flags = [config.capabilities?.images, config.capabilities?.vision, config.supportsVision, config.vision];
  return !flags.some(value => typeof value === 'boolean') || flags.includes(true);
}

/** Pure catalog/dispatch contract. Metadata can disable an exact native route,
 * but a display name, audio/image modality, or generic chat API cannot create one.
 */
export function xaiMediaContract(config = {}) {
  if (!config || typeof config !== 'object' || config.enabled === false || config.disabled === true || config.selected === false) return null;
  if (!apis.has(config.api || config.apiType) || !isXaiMediaEndpoint(config)) return null;
  if (config.authConfigured === false || config.apiKeyConfigured === false || config.auth?.configured === false) return null;
  if (config.auth?.type && !['api_key', 'token'].includes(config.auth.type)) return null;
  const image = XAI_IMAGE_MODELS.includes(config.model);
  if (!image && config.model !== XAI_SPEECH_SELECTOR) return null;
  // Empty explicit overrides must win over discovered/effective modalities.
  const outputs = config.acceptedOutputOverride ?? config.capabilities?.outputs ?? config.acceptedOutput ?? config.discoveredOutput;
  if (outputs !== undefined && (!Array.isArray(outputs) || !outputs.includes(image ? 'image' : 'audio'))) return null;
  if (!image) return speechContract;
  const referenceImages = referenceInputEnabled(config);
  return { ...imageContract, referenceImages, ...(referenceImages ? { referenceImageLimit: XAI_IMAGE_REFERENCE_LIMIT } : {}) };
}
