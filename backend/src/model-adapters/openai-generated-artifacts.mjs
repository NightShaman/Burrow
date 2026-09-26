import { randomUUID } from 'node:crypto';
import { redactHeaders } from './shared.mjs';

const AUDIO_FORMATS = Object.freeze({
  mp3: { mimeType: 'audio/mpeg', extension: 'mp3' },
  opus: { mimeType: 'audio/opus', extension: 'opus' },
  aac: { mimeType: 'audio/aac', extension: 'aac' },
  flac: { mimeType: 'audio/flac', extension: 'flac' },
  wav: { mimeType: 'audio/wav', extension: 'wav' },
  pcm: { mimeType: 'audio/pcm', extension: 'pcm' },
});

function text(value) { return typeof value === 'string' ? value.trim() : ''; }

function endpoint(baseUrl, resourcePath) {
  const base = text(baseUrl).replace(/\/+$/, '');
  if (!base) throw new Error('baseUrl is required');
  const suffix = resourcePath.replace(/^\/+/, '');
  if (base.endsWith(`/${suffix}`)) return base;
  return `${base}/${suffix}`;
}

function azureHost(baseUrl) {
  try {
    const hostname = new URL(baseUrl).hostname.toLowerCase();
    return hostname.endsWith('.openai.azure.com') || hostname.endsWith('.services.ai.azure.com');
  } catch {
    return false;
  }
}

function requestHeaders(config = {}) {
  const token = text(config.apiKey);
  const authType = text(config.auth?.type).toLowerCase();
  const explicitBearer = ['oauth', 'token', 'bearer_token'].includes(authType);
  // Azure OpenAI and Foundry use api-key for stored API keys. Older/direct
  // adapter callers may not carry the structured auth preview, so the Azure
  // hostname is the stable protocol boundary unless auth explicitly says the
  // credential is a bearer token.
  const isAzureApiKey = azureHost(config.baseUrl || config.apiBaseUrl || config.url) && !explicitBearer;
  return {
    'content-type': 'application/json',
    ...(token ? (isAzureApiKey ? { 'api-key': token } : { authorization: `Bearer ${token}` }) : {}),
    ...(config.headers || {}),
  };
}

function safeError(value, secrets = []) {
  let result = text(value) || 'provider request failed';
  for (const secret of secrets.map(text).filter(Boolean)) result = result.split(secret).join('[redacted]');
  return result.slice(0, 500);
}

async function providerError(response, secrets = []) {
  const body = await response.text();
  let message = body;
  try {
    const parsed = body ? JSON.parse(body) : {};
    message = parsed?.error?.message || parsed?.message || body;
  } catch {}
  return safeError(message || `HTTP ${response.status}`, secrets);
}

function promptFrom(options = {}) {
  if (text(options.prompt)) return text(options.prompt);
  const messages = Array.isArray(options.messages) ? options.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role !== 'user') continue;
    const content = messages[index]?.content;
    if (typeof content === 'string' && text(content)) return text(content);
    if (Array.isArray(content)) {
      const joined = content.map((part) => text(part?.text)).filter(Boolean).join('\n');
      if (joined) return joined;
    }
  }
  throw new Error('current user generation instruction is required');
}

const ARTIFACT_OPTION_KEYS = Object.freeze({
  image: Object.freeze(['background', 'moderation', 'n', 'output_compression', 'output_format', 'quality', 'response_format', 'size', 'style', 'user']),
  audio: Object.freeze(['instructions', 'response_format', 'speed', 'stream_format', 'voice']),
});

function supportedArtifactOptions(kind, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(ARTIFACT_OPTION_KEYS[kind]
    .filter((key) => value[key] !== undefined)
    // The runtime owns routing and the current instruction. Configured options
    // may tune generation, but can never replace model/prompt/input.
    .map((key) => [key, value[key]]));
}

function imageMime(bytes, fallback = '') {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return text(fallback).split(';', 1)[0].toLowerCase() || 'application/octet-stream';
}

function imageExtension(mimeType) {
  return ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' })[mimeType] || 'bin';
}

function validBase64(value) {
  const normalized = text(value).replace(/\s/g, '');
  return normalized && normalized.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(normalized) ? normalized : null;
}

async function imageBytes(item, { fetchImpl, signal, secrets }) {
  const encoded = validBase64(item?.b64_json);
  if (encoded) return { bytes: Buffer.from(encoded, 'base64'), contentType: '' };
  const url = text(item?.url);
  if (!url) throw new Error('image response item did not contain b64_json or url');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('image response contained an invalid URL'); }
  if (!['https:', 'http:'].includes(parsed.protocol)) throw new Error('image response URL protocol is unsupported');
  // Provider asset URLs are fetched without model credentials. Signed URLs carry
  // their own authorization and must never inherit an API key or bearer token.
  const response = await fetchImpl(parsed.href, { method: 'GET', ...(signal ? { signal } : {}) });
  if (!response.ok) throw new Error(`image URL retrieval failed: ${await providerError(response, secrets)}`);
  return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers?.get?.('content-type') || '' };
}

async function traceRequest(traceLogger, { requestId, provider, model, url, headers, body, clock }) {
  const providerRequestArtifact = await traceLogger?.artifact?.(`provider-request-${requestId}.json`, JSON.stringify(body)) || null;
  await traceLogger?.model?.({ stage: 'model-request', requestId, provider, api: 'openai-generated-artifact', model, url, headers: redactHeaders(headers), providerRequestArtifact, ts: clock() });
}

export function generatedArtifactKind(config = {}) {
  const outputs = Array.isArray(config.capabilities?.outputs) ? config.capabilities.outputs.map((value) => text(value).toLowerCase()) : [];
  if (outputs.includes('text')) return null;
  if (outputs.includes('image')) return 'image';
  if (outputs.includes('audio')) return 'audio';
  return null;
}

export function createOpenAIGeneratedArtifactAdapter({ config = {}, fetchImpl = globalThis.fetch, clock = () => new Date().toISOString(), idFactory = randomUUID } = {}) {
  if (!fetchImpl) throw new Error('fetch implementation is required');
  const kind = generatedArtifactKind(config);
  if (!kind) throw new Error('generated artifact output capability is required');
  const model = text(config.model);
  if (!model) throw new Error('model is required');
  const provider = text(config.provider || config.providerName) || 'openai-compatible';
  const baseUrl = config.baseUrl || config.apiBaseUrl || config.url;
  const url = endpoint(baseUrl, kind === 'image' ? 'images/generations' : 'audio/speech');

  const complete = async (options = {}) => {
    const requestId = idFactory();
    const prompt = promptFrom(options);
    const headers = requestHeaders(config);
    const artifactOptions = supportedArtifactOptions(kind, config.generatedArtifactOptions);
    const body = kind === 'image'
      ? { model, prompt, n: 1, ...artifactOptions }
      : { model, input: prompt, voice: 'alloy', response_format: 'mp3', ...artifactOptions };
    await traceRequest(options.traceLogger, { requestId, provider, model, url, headers, body, clock });
    const response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), ...(options.signal ? { signal: options.signal } : {}) });
    if (!response.ok) {
      const error = await providerError(response, [config.apiKey]);
      await options.traceLogger?.model?.({ stage: 'model-response', requestId, provider, api: 'openai-generated-artifact', model, status: response.status, ok: false, error, ts: clock() });
      return { ok: false, requestId, provider, api: 'openai-generated-artifact', model, status: response.status, choice: null, outputArtifacts: [], error };
    }

    let outputArtifacts;
    let responseId = text(response.headers?.get?.('x-request-id')) || null;
    let usage = null;
    if (kind === 'audio') {
      const bytes = Buffer.from(await response.arrayBuffer());
      const requestedFormat = text(body.response_format).toLowerCase() || 'mp3';
      const format = AUDIO_FORMATS[requestedFormat] || { mimeType: text(response.headers?.get?.('content-type')).split(';', 1)[0].toLowerCase() || 'application/octet-stream', extension: requestedFormat || 'bin' };
      const providerMimeType = text(response.headers?.get?.('content-type')).split(';', 1)[0].toLowerCase();
      // The OpenAI contract advertises application/octet-stream for speech;
      // response_format is the authoritative media subtype in that case.
      const mimeType = providerMimeType && providerMimeType !== 'application/octet-stream' ? providerMimeType : format.mimeType;
      outputArtifacts = [{ kind: 'audio', name: `speech-${requestId}.${format.extension}`, mimeType, sizeBytes: bytes.length, source: { bytes } }];
    } else {
      let data;
      try { data = await response.json(); } catch { return { ok: false, requestId, provider, api: 'openai-generated-artifact', model, status: response.status, choice: null, outputArtifacts: [], error: 'image provider returned invalid JSON' }; }
      responseId ||= text(data?.id) || null;
      usage = data?.usage || null;
      if (!Array.isArray(data?.data) || !data.data.length) return { ok: false, requestId, responseId, provider, api: 'openai-generated-artifact', model, status: response.status, choice: null, usage, outputArtifacts: [], error: 'image provider returned no images' };
      outputArtifacts = [];
      for (let index = 0; index < data.data.length; index += 1) {
        const resolved = await imageBytes(data.data[index], { fetchImpl, signal: options.signal, secrets: [config.apiKey] });
        const mimeType = imageMime(resolved.bytes, resolved.contentType);
        outputArtifacts.push({ kind: 'image', name: `image-${requestId}-${index + 1}.${imageExtension(mimeType)}`, mimeType, sizeBytes: resolved.bytes.length, source: { bytes: resolved.bytes } });
      }
    }
    const result = { ok: true, requestId, responseId, provider, api: 'openai-generated-artifact', model, status: response.status, choice: { text: '', finishReason: 'stop', toolCalls: [] }, usage, outputArtifacts, error: null };
    await options.traceLogger?.model?.({ stage: 'model-response', requestId, provider, api: 'openai-generated-artifact', model, status: response.status, ok: true, artifactCount: outputArtifacts.length, responseBytes: outputArtifacts.reduce((sum, item) => sum + item.sizeBytes, 0), ts: clock() });
    return result;
  };

  return { provider, api: 'openai-generated-artifact', model, url, outputKind: kind, supportsVision: false, complete };
}

export const __test__ = { endpoint, requestHeaders, imageMime };
