import { mediaBudgets, mediaBytes, decodeMedia } from './generated-media-budgets.mjs';
import { randomUUID } from 'node:crypto';
import { readProviderError } from '../forge-diagnostics.mjs';

const text = (v) => typeof v === 'string' ? v.trim() : '';
const supportedModels = new Set(['lyria-3-clip-preview', 'lyria-3.5', 'lyria-3-pro-preview']);
const canonicalModel = (value) => text(value).replace(/^models\//i, '');

export function googleLyriaSupported(config = {}) {
  const api = text(config.api || config.apiType).toLowerCase();
  const provider = text(config.provider || config.providerName).toLowerCase();
  let hostname = ''; try { hostname = new URL(config.baseUrl).hostname; } catch {}
  const googleEndpoint = hostname === 'generativelanguage.googleapis.com';
  return (googleEndpoint || (['google-generative-language', 'google-gemini', 'gemini'].includes(api)
    && ['google', 'google-ai', 'google-gemini'].includes(provider)))
    && supportedModels.has(canonicalModel(config.model));
}
function endpoint(baseUrl) {
  const base = (text(baseUrl) || 'https://generativelanguage.googleapis.com').replace(/\/+$/, '');
  return /\/v1beta(?:\/openai)?$/i.test(base) ? `${base.replace(/\/openai$/i, '')}/interactions` : `${base}/v1beta/interactions`;
}
function audioData(data) {
  const steps = Array.isArray(data?.steps) ? data.steps : [];
  for (const step of steps) for (const content of (Array.isArray(step?.content) ? step.content : [])) {
    if (String(step?.type || '').toLowerCase() === 'model_output' && String(content?.type || '').toLowerCase() === 'audio' && text(content?.data)) return text(content.data);
  }
  // Keep compatibility with the SDK-shaped response while preferring documented REST.
  return text(data?.output_audio?.data);
}
export function createGoogleLyriaAdapter({ config = {}, fetchImpl = globalThis.fetch, idFactory = randomUUID } = {}) {
  if (!fetchImpl || !googleLyriaSupported(config)) throw new Error('google_lyria_contract_unsupported');
  const budgets = mediaBudgets(config);
  const url = endpoint(config.baseUrl);
  const model = canonicalModel(config.model);
  return { provider: config.provider || 'google', api: 'google-interactions', model, url, outputKind: 'audio', complete: async ({ prompt, signal } = {}) => {
    const requestId = idFactory();
    const body = { model, input: text(prompt) };
    const headers = { 'content-type': 'application/json', 'x-goog-api-key': text(config.apiKey) };
    const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    if (!response.ok) {
      const bounded = await readProviderError(response, [config.apiKey]);
      const providerRequestId = text(response.headers?.get?.('x-request-id'));
      const details = { ...bounded, httpStatus: response.status, ...(providerRequestId ? { requestId: providerRequestId } : {}) };
      return { ok: false, requestId, provider: 'google', api: 'google-interactions', model, status: response.status, outputArtifacts: [], error: details.message, errorDetails: details };
    }
    let data; try { data = JSON.parse((await mediaBytes(response, budgets.metadata)).toString('utf8')); } catch { return { ok: false, requestId, provider: 'google', api: 'google-interactions', model, status: response.status, outputArtifacts: [], error: 'Google returned invalid JSON' }; }
    const encoded = audioData(data);
    if (!encoded || !/^[A-Za-z0-9+/]+=*$/.test(encoded)) return { ok: false, requestId, provider: 'google', api: 'google-interactions', model, status: response.status, outputArtifacts: [], error: 'Google returned no audio data' };
    const bytes = decodeMedia(encoded, Math.min(budgets.asset, budgets.total));
    return { ok: true, requestId, provider: 'google', api: 'google-interactions', model, status: response.status, outputArtifacts: [{ kind: 'audio', name: `lyria-${requestId}.mp3`, mimeType: 'audio/mpeg', sizeBytes: bytes.length, source: { bytes } }] };
  } };
}

export { canonicalModel };
