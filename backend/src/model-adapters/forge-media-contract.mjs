import { googleNativeApi, googleNativeBase, googleMediaKind } from './google-native-catalog.mjs';
import { googleSpeechContract } from './google-speech-contract.mjs';
import { xaiMediaContract, XAI_SPEECH_SELECTOR } from './xai-media-contract.mjs';
import { videoContract, videoReferenceImagesSupported, VIDEO_REFERENCE_LIMIT } from './video-contract.mjs';

const compatibleApis = new Set(['openai-chat-completions', 'openai-responses', 'openai-completions']);
const outputsOf = config => config.acceptedOutputOverride ?? config.capabilities?.outputs ?? config.acceptedOutput ?? config.discoveredOutput;
const inputsOf = config => config.acceptedInputOverride ?? config.capabilities?.inputs ?? config.acceptedInput ?? config.discoveredInput;
function imageInput(config, nativeDefault = false) {
  const inputs = inputsOf(config);
  if (inputs !== undefined) return Array.isArray(inputs) && inputs.includes('image');
  const flags = [config.capabilities?.images, config.capabilities?.vision, config.supportsVision, config.vision];
  return flags.some(value => typeof value === 'boolean') ? flags.includes(true) : nativeDefault;
}

/** These providers document the Images and Speech endpoints. Chat compatibility
 * or discovered media outputs on an arbitrary server do not establish them.
 * Azure deployment IDs and operator-owned labels are deliberately not gates. */
export function openaiMediaContract(config = {}) {
  if (!compatibleApis.has(config.api || config.apiType)) return null;
  let url;
  try { url = new URL(config.baseUrl); } catch { return null; }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
  if (['api.x.ai', 'generativelanguage.googleapis.com'].includes(url.hostname)) return null;
  const path = url.pathname.replace(/\/+$/, '');
  const official = url.protocol === 'https:' && !url.port;
  const openai = official && url.hostname === 'api.openai.com' && path === '/v1';
  const azure = official && (url.hostname.endsWith('.openai.azure.com') || url.hostname.endsWith('.services.ai.azure.com')) && path === '/openai/v1';
  // A saved full resource endpoint explicitly declares a compatible media
  // transport for a custom/internal provider without adding a settings knob.
  const imageEndpoint = path.endsWith('/images/generations') || path.endsWith('/images/edits');
  const speechEndpoint = path.endsWith('/audio/speech');
  if (!openai && !azure && !imageEndpoint && !speechEndpoint) return null;
  // ChatGPT/Claude OAuth and logical pools are not media API credentials.
  if (config.auth?.type && !['api_key', 'token', 'bearer_token'].includes(config.auth.type)) return null;
  const outputs = outputsOf(config);
  if (!Array.isArray(outputs)) return null;
  if ((openai || azure || imageEndpoint) && (outputs.includes('image') || outputs.includes('gif'))) return { id: 'openai-image', provider: 'openai', kind: 'image', mode: 'image', referenceImages: imageInput(config) };
  // Mixed/realtime audio does not establish a unary speech contract.
  if ((openai || azure || speechEndpoint) && outputs.includes('audio') && !outputs.includes('text')) return { id: 'openai-speech', provider: 'openai', kind: 'audio', mode: 'speech', referenceImages: false };
  return null;
}

/** One pure selector for catalog, references, options and worker dispatch.
 * A known native contract may fill absent discovery metadata, never override a
 * deliberate disable. Unsupported providers/pools remain inspectable, not usable. */
export function forgeMediaContract(config = {}) {
  if (!config || config.enabled === false || config.disabled === true || config.selected === false
    || config.providerPool || ['openai-lb', 'anthropic-lb'].includes(config.api || config.apiType)
    || config.authConfigured === false || config.apiKeyConfigured === false || config.auth?.configured === false) return null;
  const outputs = outputsOf(config);
  if (Array.isArray(outputs) && !outputs.length) return null;
  const video = videoContract(config);
  if (video) return { id: `${video}-video`, provider: video, kind: 'video', mode: 'video',
    referenceImages: videoReferenceImagesSupported(config), referenceImageLimit: VIDEO_REFERENCE_LIMIT };
  const xai = xaiMediaContract(config);
  if (xai) return xai;
  const speech = googleSpeechContract(config);
  if (speech) return speech;
  let googleBase = false;
  try { googleNativeBase(config); googleBase = googleNativeApi(config) || (Boolean(config.baseUrl) && compatibleApis.has(config.api || config.apiType)); } catch { /* Not Google's Developer API. */ }
  if (googleBase) {
    const native = { ...config, api: 'google-generative-language' };
    const kind = googleMediaKind(native);
    if (kind) return { id: kind === 'image' ? 'google-image' : 'google-music', provider: 'google', kind,
      mode: kind === 'image' ? 'image' : 'music', referenceImages: kind === 'image' && imageInput(config, true) };
    return null;
  }
  return openaiMediaContract(config);
}

/** Normalize the same saved modality precedence for catalog and execution. */
export function forgeModelConfig(connection, model) {
  const inputs = model.acceptedInputOverride ?? model.acceptedInput ?? model.discoveredInput ?? connection.acceptedInput;
  const outputs = model.acceptedOutputOverride ?? model.acceptedOutput ?? model.discoveredOutput;
  return { ...connection, model: model.id, selected: model.selected,
    acceptedInput: inputs, acceptedOutput: outputs,
    capabilities: { inputs, outputs }, supportedGenerationMethods: model.supportedGenerationMethods };
}

/** /tts is a connection capability; this local selector is never a provider model. */
export function forgeConnectionModels(connection) {
  const models = connection.models || [];
  if (models.some(model => model.id === XAI_SPEECH_SELECTOR)) return models;
  const speech = { id: XAI_SPEECH_SELECTOR, name: 'xAI Text to Speech', selected: true };
  return forgeMediaContract(forgeModelConfig(connection, speech))?.id === 'xai-speech' ? [...models, speech] : models;
}

export function declaredForgeKind(config) {
  const outputs = outputsOf(config);
  if (!Array.isArray(outputs)) return null;
  if (outputs.includes('video')) return 'video';
  if (outputs.includes('image') || outputs.includes('gif')) return 'image';
  return outputs.includes('audio') ? 'audio' : null;
}
