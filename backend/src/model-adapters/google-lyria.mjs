import { googleNativeBase, googleNativeHeaders, GOOGLE_MUSIC_MODELS } from './google-native-catalog.mjs';
import { mediaBudgets, mediaBytes, decodeMedia } from './generated-media-budgets.mjs';
import { randomUUID } from 'node:crypto';
import { readProviderError } from '../forge-diagnostics.mjs';

const text = (v) => typeof v === 'string' ? v.trim() : '';
const supportedModels = GOOGLE_MUSIC_MODELS;
const canonicalModel = (value) => text(value).replace(/^models\//i, '');

export function googleLyriaSupported(config = {}) {
  const api = text(config.api || config.apiType).toLowerCase();
  const provider = text(config.provider || config.providerName).toLowerCase();
  let hostname = ''; try { hostname = new URL(config.baseUrl).hostname; } catch {}
  const googleEndpoint = hostname === 'generativelanguage.googleapis.com';
  try { if (!googleNativeBase(config).endsWith('/v1beta')) return false; } catch { return false; }
  if (config.auth?.type && config.auth.type !== 'api_key') return false;
  return (googleEndpoint || (['google-generative-language', 'google-gemini', 'gemini'].includes(api)
    && ['google', 'google-ai', 'google-gemini'].includes(provider)))
    && supportedModels.has(canonicalModel(config.model));
}
function endpoint(baseUrl) {
  const base = googleNativeBase({ baseUrl });
  if (!base.endsWith('/v1beta')) throw new Error('google_interactions_version_unsupported');
  return `${base}/interactions`;
}
function audioData(data) {
  const steps = Array.isArray(data?.steps) ? data.steps : [];
  for (const step of steps) for (const content of (Array.isArray(step?.content) ? step.content : [])) {
    if (String(step?.type || '').toLowerCase() === 'model_output' && String(content?.type || '').toLowerCase() === 'audio' && text(content?.data)) return { data: text(content.data), mimeType: text(content.mime_type) };
  }
  // Keep compatibility with the SDK-shaped response while preferring documented REST.
  return { data: text(data?.output_audio?.data), mimeType: text(data?.output_audio?.mime_type) };
}
export function createGoogleLyriaAdapter({ config = {}, fetchImpl = globalThis.fetch, idFactory = randomUUID } = {}) {
  if (!fetchImpl || !googleLyriaSupported(config)) throw new Error('google_lyria_contract_unsupported');
  const budgets = mediaBudgets(config);
  const url = endpoint(config.baseUrl);
  const model = canonicalModel(config.model);
  return { provider: config.provider || 'google', api: 'google-interactions', model, url, outputKind: 'audio', complete: async ({ prompt, signal } = {}) => {
    const requestId = idFactory();
    const body = { model, input: text(prompt) };
    const headers = googleNativeHeaders(config);
    const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    if (!response.ok) {
      const bounded = await readProviderError(response, [config.apiKey, config.auth?.token, config.auth?.apiKey].filter(Boolean));
      const providerRequestId = text(response.headers?.get?.('x-request-id'));
      const details = { ...bounded, httpStatus: response.status, ...(providerRequestId ? { requestId: providerRequestId } : {}) };
      return { ok: false, requestId, provider: 'google', api: 'google-interactions', model, status: response.status, outputArtifacts: [], error: details.message, errorDetails: details };
    }
    let data; try { data = JSON.parse((await mediaBytes(response, budgets.metadata)).toString('utf8')); } catch { return { ok: false, requestId, provider: 'google', api: 'google-interactions', model, status: response.status, outputArtifacts: [], error: 'Google returned invalid JSON' }; }
    const audio = audioData(data);
    const encoded = audio.data;
    const mimeType = audio.mimeType || 'audio/mpeg';
    const extension = { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3', 'audio/wav': 'wav', 'audio/ogg': 'ogg', 'audio/flac': 'flac' }[mimeType];
    if (!extension) throw new Error('google_audio_mime_unsupported');
    if (!encoded || !/^[A-Za-z0-9+/]+=*$/.test(encoded)) return { ok: false, requestId, provider: 'google', api: 'google-interactions', model, status: response.status, outputArtifacts: [], error: 'Google returned no audio data' };
    const bytes = decodeMedia(encoded, Math.min(budgets.asset, budgets.total));
    return { ok: true, requestId, provider: 'google', api: 'google-interactions', model, status: response.status, outputArtifacts: [{ kind: 'audio', name: `lyria-${requestId}.${extension}`, mimeType, sizeBytes: bytes.length, source: { bytes } }] };
  } };
}

export { canonicalModel };
