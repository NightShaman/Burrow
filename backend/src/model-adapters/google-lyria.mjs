import { randomUUID } from 'node:crypto';

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
function errorText(body, secret) {
  let value = body;
  try { const parsed = JSON.parse(body); value = parsed?.error?.message || parsed?.message || body; } catch {}
  return text(value).split(secret || '\0').join('[redacted]').slice(0, 500);
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
  const url = endpoint(config.baseUrl);
  const model = canonicalModel(config.model);
  return { provider: config.provider || 'google', api: 'google-interactions', model, url, outputKind: 'audio', complete: async ({ prompt, signal } = {}) => {
    const requestId = idFactory();
    const body = { model, input: text(prompt) };
    const headers = { 'content-type': 'application/json', 'x-goog-api-key': text(config.apiKey) };
    const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) });
    if (!response.ok) return { ok: false, requestId, provider: 'google', api: 'google-interactions', model, status: response.status, outputArtifacts: [], error: errorText(await response.text(), config.apiKey) };
    let data; try { data = await response.json(); } catch { return { ok: false, requestId, provider: 'google', api: 'google-interactions', model, status: response.status, outputArtifacts: [], error: 'Google returned invalid JSON' }; }
    const encoded = audioData(data);
    if (!encoded || !/^[A-Za-z0-9+/]+=*$/.test(encoded)) return { ok: false, requestId, provider: 'google', api: 'google-interactions', model, status: response.status, outputArtifacts: [], error: 'Google returned no audio data' };
    const bytes = Buffer.from(encoded, 'base64');
    return { ok: true, requestId, provider: 'google', api: 'google-interactions', model, status: response.status, outputArtifacts: [{ kind: 'audio', name: `lyria-${requestId}.mp3`, mimeType: 'audio/mpeg', sizeBytes: bytes.length, source: { bytes } }] };
  } };
}

export { canonicalModel };
