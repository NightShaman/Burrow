import { googleNativeBase, GOOGLE_SPEECH_MODELS } from './google-native-catalog.mjs';

// Verified native unary WAV contracts, not audio-modality or TTS-name inference.
// https://aistudio.google.com/docs/speech-generation#single-speaker
// https://aistudio.google.com/docs/speech-generation#audio-output-formats
// Earlier preview TTS models default to raw PCM and are deliberately excluded.
export { GOOGLE_SPEECH_MODELS } from './google-native-catalog.mjs';
export const GOOGLE_SPEECH_METHOD = 'interactions.create';
// An adapter choice from Google's documented prebuilt voices, not a claimed
// provider-side default. Single-speaker only; no voice creation/replication.
export const GOOGLE_SPEECH_DEFAULT_VOICE = 'Kore';

const models = new Set(GOOGLE_SPEECH_MODELS);
const nativeApis = new Set(['google-generative-language', 'google-gemini', 'gemini']);
const compatibleApis = new Set(['openai-chat-completions', 'openai-responses', 'openai-completions']);
const contract = Object.freeze({ id: 'google-speech', provider: 'google', mode: 'speech', kind: 'audio', referenceImages: false });
const text = value => typeof value === 'string' ? value.trim() : '';
export const googleSpeechModel = value => text(value).replace(/^models\//, '');

export function googleSpeechContract(config = {}) {
  if (!config || typeof config !== 'object' || config.enabled === false || config.disabled === true || config.selected === false) return null;
  const api = text(config.api || config.apiType).toLowerCase();
  if (!nativeApis.has(api) && !compatibleApis.has(api)) return null;
  if (config.baseUrl !== undefined && typeof config.baseUrl !== 'string') return null;
  // A compatible connection may carry this documented native model, but a
  // Google display name alone must never redirect credentials to Google.
  if (compatibleApis.has(api) && !text(config.baseUrl)) return null;
  try {
    if (!googleNativeBase(config).endsWith('/v1beta')) return null;
    if (config.baseUrl && !['', '/v1beta', '/v1beta/openai'].includes(new URL(config.baseUrl).pathname.replace(/\/+$/, ''))) return null;
  } catch { return null; }
  if (config.authConfigured === false || config.apiKeyConfigured === false || config.auth?.configured === false) return null;
  if (config.auth?.type && config.auth.type !== 'api_key') return null;
  if (!models.has(googleSpeechModel(config.model))) return null;
  // Preserve explicit disables, including an empty override and malformed
  // modality declarations; missing discovery metadata is not a disable.
  const outputs = [config.acceptedOutputOverride, config.capabilities?.outputs, config.acceptedOutput, config.discoveredOutput]
    .find(value => value !== undefined);
  if (outputs !== undefined && (!Array.isArray(outputs) || !outputs.includes('audio'))) return null;
  const methods = config.supportedGenerationMethods;
  // These exact models document both native APIs. Models discovery commonly
  // names generateContent rather than the separate Interactions SDK method.
  // Neither method metadata nor audio output alone authorizes any other ID.
  if (methods !== undefined && (!Array.isArray(methods)
    || !methods.some(method => method === GOOGLE_SPEECH_METHOD || method === 'generateContent'))) return null;
  return contract;
}
