import { randomUUID } from 'node:crypto';
import { readProviderError, sanitizeDiagnostic } from '../forge-diagnostics.mjs';
import { classifyModelFailure, markProviderTransportError, providerErrorSecrets, withProviderErrorScope } from '../model-failure.mjs';
import { mediaBudgets, mediaBytes, decodeMedia } from './generated-media-budgets.mjs';
import { fetchProviderMedia, providerMediaEnvelopeResult } from './provider-fetch.mjs';
import { fetchProviderImage } from './provider-image-url.mjs';
import { validatedSourceImages } from './reference-image-capability.mjs';
import { xaiMediaBase, xaiMediaContract, XAI_IMAGE_REFERENCE_LIMIT, XAI_IMAGE_OUTPUT_LIMIT, XAI_SPEECH_TEXT_LIMIT } from './xai-media-contract.mjs';

const imageExtensions = Object.freeze({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' });
const audioFormats = Object.freeze({
  mp3: { mimeType: 'audio/mpeg', extension: 'mp3' }, wav: { mimeType: 'audio/wav', extension: 'wav' },
  pcm: { mimeType: 'audio/pcm', extension: 'pcm' }, mulaw: { mimeType: 'audio/basic', extension: 'ulaw' },
  alaw: { mimeType: 'audio/alaw', extension: 'alaw' },
});
const aspectRatios = new Set(['1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '2:1', '1:2', '19.5:9', '9:19.5', '20:9', '9:20', '21:9', '5:2', 'auto']);
const languages = new Set(['auto', 'en', 'ar-eg', 'ar-sa', 'ar-ae', 'bn', 'zh', 'fr', 'de', 'hi', 'id', 'it', 'ja', 'ko', 'pt-br', 'pt-pt', 'ru', 'es-mx', 'es-es', 'tr', 'vi']);
const sampleRates = new Set([8000, 16000, 22050, 24000, 44100, 48000]);
const bitRates = new Set([32000, 64000, 96000, 128000, 192000]);
const object = value => value !== null && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const mime = value => typeof value === 'string' ? value.split(';', 1)[0].trim().toLowerCase() : '';
function keys(value, allowed, code) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new Error(code);
}

// Unsupported OpenAI controls must fail before dispatch, not disappear behind
// an allowlist. Only synchronous images and raw-audio unary TTS are implemented.
export function validateXaiMediaOptions(config = {}, value = config.generatedArtifactOptions) {
  const contract = xaiMediaContract(config);
  if (!contract) throw new Error('xai_media_contract_unsupported');
  const options = value === undefined ? {} : value;
  if (contract.kind === 'image') {
    keys(options, ['n', 'response_format', 'aspect_ratio', 'resolution', 'quality', 'user'], 'xai_image_options_unsupported');
    const result = { n: 1, response_format: 'b64_json', ...options };
    if (!Number.isSafeInteger(result.n) || result.n < 1 || result.n > XAI_IMAGE_OUTPUT_LIMIT) throw new Error('xai_image_count_invalid');
    if (!['url', 'b64_json'].includes(result.response_format)) throw new Error('xai_image_response_format_unsupported');
    if (result.aspect_ratio !== undefined && !aspectRatios.has(result.aspect_ratio)) throw new Error('xai_image_aspect_ratio_unsupported');
    // The guide and REST schema disagree about 1.5k. Support their intersection.
    if (result.resolution !== undefined && !['1k', '2k'].includes(result.resolution)) throw new Error('xai_image_resolution_unsupported');
    if (result.quality !== undefined && (config.model !== 'grok-imagine-image-2.0' || !['low', 'medium', 'auto'].includes(result.quality))) throw new Error('xai_image_quality_unsupported');
    if (result.user !== undefined && typeof result.user !== 'string') throw new Error('xai_image_user_invalid');
    return result;
  }
  keys(options, ['voice_id', 'language', 'output_format', 'speed', 'text_normalization'], 'xai_speech_options_unsupported');
  const result = { voice_id: 'eve', language: 'auto', ...options };
  if (typeof result.voice_id !== 'string' || !result.voice_id.trim() || result.voice_id.trim() !== result.voice_id || /[\u0000-\u001f\u007f]/.test(result.voice_id)) throw new Error('xai_speech_voice_id_invalid');
  if (typeof result.language !== 'string' || !languages.has(result.language.toLowerCase())) throw new Error('xai_speech_language_unsupported');
  if (result.speed !== undefined && (typeof result.speed !== 'number' || !Number.isFinite(result.speed) || result.speed < 0.7 || result.speed > 1.5)) throw new Error('xai_speech_speed_invalid');
  if (result.text_normalization !== undefined && typeof result.text_normalization !== 'boolean') throw new Error('xai_speech_text_normalization_invalid');
  const format = result.output_format === undefined ? { codec: 'mp3' } : result.output_format;
  keys(format, ['codec', 'sample_rate', 'bit_rate'], 'xai_speech_output_format_unsupported');
  if (!Object.hasOwn(audioFormats, format.codec)) throw new Error('xai_speech_codec_unsupported');
  if (format.sample_rate !== undefined && !sampleRates.has(format.sample_rate)) throw new Error('xai_speech_sample_rate_unsupported');
  if (format.bit_rate !== undefined && (format.codec !== 'mp3' || !bitRates.has(format.bit_rate))) throw new Error('xai_speech_bit_rate_unsupported');
  result.output_format = { ...format };
  return result;
}

function imageMime(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}
function audioBytesMatch(bytes, codec) {
  if (!bytes.length) return false;
  if (codec === 'mp3') return bytes.length >= 3 && (bytes.toString('ascii', 0, 3) === 'ID3' || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0));
  if (codec === 'wav') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WAVE';
  return codec !== 'pcm' || bytes.length % 2 === 0;
}
function decodeImage(encoded, limit) {
  if (typeof encoded !== 'string' || !encoded.length || encoded.length % 4 ) throw new Error('xai_image_base64_invalid');
  const bytes = decodeMedia(encoded, limit);
  if (bytes.toString('base64') !== encoded) throw new Error('xai_image_base64_invalid');
  return bytes;
}
function safeTransport(error, code, stage = 'fetch', secrets = []) {
  const upstreamCode = error?.code ?? error?.cause?.code;
  const details = { message: sanitizeDiagnostic(error?.message || code, secrets),
    ...(upstreamCode ? { code: sanitizeDiagnostic(String(upstreamCode), secrets) } : {}) };
  if (classifyModelFailure(error).origin !== 'upstream') return Object.assign(new Error(code), { errorDetails: details });
  // Preserve upstream provenance without retaining a signed URL, portrait, or
  // provider exception text. Fetch's known marker is captured before renaming.
  const safe = stage === 'fetch' ? new TypeError('fetch failed') : new Error(code);
  markProviderTransportError(safe, { stage });
  safe.message = code;
  safe.errorDetails = details;
  return safe;
}
async function readBytes(response, limit, signal, secrets) {
  try { return await mediaBytes(response, limit); }
  catch (error) {
    signal?.throwIfAborted();
    if (classifyModelFailure(error).origin === 'upstream') throw safeTransport(error, 'xai_media_response_read_failed', 'read', secrets);
    throw error;
  }
}
async function readJson(response, limit, signal, secrets) {
  const bytes = await readBytes(response, limit, signal, secrets);
  try { return JSON.parse(bytes.toString('utf8')); }
  catch { throw new Error('xai_media_response_json_invalid'); }
}
const cancel = async response => { try { await response.body?.cancel(); } catch { /* Preserve the original safe failure. */ } };
function envelopeFailure(payload, fields, secrets) {
  const result = providerMediaEnvelopeResult(payload, fields);
  if (!result) return null;
  return { ...result, error: sanitizeDiagnostic(result.error, secrets),
    modelFailure: { ...result.modelFailure, ...(result.modelFailure?.message ? { message: sanitizeDiagnostic(result.modelFailure.message, secrets) } : {}) } };
}

export function createXaiMediaAdapter({ config = {}, fetchImpl = globalThis.fetch, lookupImpl, idFactory = randomUUID } = {}) {
  const contract = xaiMediaContract(config);
  if (typeof fetchImpl !== 'function' || !contract) throw new Error('xai_media_contract_unsupported');
  const token = config.auth?.token || config.auth?.apiKey || config.apiKey;
  if (typeof token !== 'string' || !token.trim()) throw new Error('xai_media_api_key_required');
  const provider = 'xai', api = contract.id, model = config.model, budgets = mediaBudgets(config);
  const base = xaiMediaBase(config), url = `${base}/${contract.kind === 'image' ? 'images/generations' : 'tts'}`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const secrets = providerErrorSecrets(config, headers);
  return { provider, api, model, url, outputKind: contract.kind,
    async complete({ prompt, signal, sourceImages } = {}) {
      return withProviderErrorScope(secrets, async () => {
        signal?.throwIfAborted();
        if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('xai_media_prompt_required');
        const options = validateXaiMediaOptions(config);
        if (sourceImages !== undefined && !contract.referenceImages) throw new Error('agent_reference_image_unsupported');
        if (Array.isArray(sourceImages) && sourceImages.length > XAI_IMAGE_REFERENCE_LIMIT) throw new Error('xai_image_reference_image_limit_exceeded');
        if (Array.isArray(sourceImages) && sourceImages.some(image => image?.url !== undefined || image?.image_url !== undefined || image?.file_id !== undefined)) throw new Error('source_images_invalid');
        const images = validatedSourceImages(sourceImages);
        if (images?.some(image => imageMime(image.bytes) !== image.mimeType)) throw new Error('source_images_invalid');
        if (contract.kind === 'audio' && [...prompt].length > XAI_SPEECH_TEXT_LIMIT) throw new Error('xai_speech_text_limit_exceeded');
        if (contract.kind === 'image' && options.n > budgets.count) throw new Error('generated_media_artifact_count_exceeded');
        const refs = images?.map(({ bytes, mimeType }) => ({ url: `data:${mimeType};base64,${bytes.toString('base64')}` }));
        const protectedImages = refs?.flatMap(({ url }) => [url, url.slice(url.indexOf(',') + 1)]) || [];
        return withProviderErrorScope(protectedImages, async () => {
          const callSecrets = [...secrets, ...protectedImages];
          const fields = { requestId: idFactory(), provider, api, model };
          const failure = (status, error, errorDetails) => ({ ...fields, ok: false, status, error, outputArtifacts: [],
            ...(errorDetails ? { errorDetails, modelFailure: errorDetails.modelFailure } : {}) });
          const body = contract.kind === 'image'
            ? { model, prompt, ...options, ...(refs?.length === 1 ? { image: refs[0] } : refs ? { images: refs } : {}) }
            : { text: prompt, ...options };
          const target = refs ? `${base}/images/edits` : url;
          let response;
          try {
            // Exactly one paid POST; no redirect, fallback, retry, or splitting.
            response = await fetchProviderMedia(fetchImpl, target, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'manual', ...(signal ? { signal } : {}) });
          } catch (error) { signal?.throwIfAborted(); throw safeTransport(error, 'xai_media_submit_transport_failed', 'fetch', callSecrets); }
          if (!response.ok) {
            let details;
            try { details = await readProviderError(response, callSecrets); }
            catch (error) { signal?.throwIfAborted(); throw safeTransport(error, 'xai_media_error_response_read_failed', 'read', callSecrets); }
            if (details.modelFailure?.message) details = { ...details, modelFailure: { ...details.modelFailure, message: sanitizeDiagnostic(details.modelFailure.message, callSecrets) } };
            const providerRequestId = response.headers?.get?.('x-request-id');
            details = { ...details, httpStatus: response.status, ...(providerRequestId ? { requestId: sanitizeDiagnostic(providerRequestId, callSecrets) } : {}) };
            return failure(response.status, details.message, details);
          }
          if (contract.kind === 'audio') {
            const contentType = mime(response.headers?.get?.('content-type'));
            // JSON is only used for an error envelope here. Timestamp-enabled
            // responses are outside this raw-audio contract, never saved as MP3.
            if (contentType === 'application/json') {
              const payload = await readJson(response, budgets.metadata, signal, callSecrets);
              return envelopeFailure(payload, { ...fields, status: response.status }, callSecrets)
                || failure(response.status, 'xai_speech_response_mime_unsupported');
            }
            const codec = options.output_format.codec, format = audioFormats[codec];
            if (response.status !== 200 || (contentType && contentType !== 'application/octet-stream' && contentType !== format.mimeType)) {
              await cancel(response);
              return failure(response.status, 'xai_speech_response_mime_or_status_unsupported');
            }
            const bytes = await readBytes(response, Math.min(budgets.asset, budgets.total), signal, callSecrets);
            if (!audioBytesMatch(bytes, codec)) return failure(response.status, 'xai_speech_response_audio_invalid');
            return { ...fields, ok: true, status: response.status, error: null, outputArtifacts: [{ kind: 'audio',
              name: `xai-speech-${fields.requestId}.${format.extension}`, mimeType: format.mimeType, sizeBytes: bytes.length, source: { bytes } }] };
          }
          const payload = await readJson(response, budgets.metadata, signal, callSecrets);
          const failed = envelopeFailure(payload, { ...fields, status: response.status }, callSecrets);
          if (failed) return failed;
          if (!Array.isArray(payload?.data) || !payload.data.length) return failure(response.status, 'xai_returned_no_image');
          if (payload.data.length > Math.min(budgets.count, XAI_IMAGE_OUTPUT_LIMIT)) throw new Error('generated_media_artifact_count_exceeded');
          if (payload.data.length > options.n) throw new Error('xai_image_response_count_exceeded');
          const outputArtifacts = [];
          let remaining = budgets.total;
          for (const item of payload.data) {
            const limit = Math.min(budgets.asset, remaining);
            if (limit <= 0) throw new Error('generated_media_budget_exhausted');
            let bytes, contentType = '';
            if (item?.b64_json !== undefined && item.b64_json !== null) bytes = decodeImage(item.b64_json, limit);
            else {
              let assetUrl;
              try {
                assetUrl = new URL(item?.url);
                if (assetUrl.protocol !== 'https:' || assetUrl.username || assetUrl.password || assetUrl.hash) throw new Error();
              } catch { throw new Error('xai_image_response_url_invalid'); }
              let asset;
              try {
                asset = await fetchProviderImage(assetUrl.href, { fetchImpl, lookupImpl, signal });
              } catch (error) {
                signal?.throwIfAborted();
                markProviderTransportError(error, { stage: 'fetch' });
                throw safeTransport(error, 'xai_image_download_failed', 'fetch', callSecrets);
              }
              if (!asset.ok) { await cancel(asset); return failure(asset.status, `xai_image_download_http_${asset.status}`); }
              contentType = mime(asset.headers?.get?.('content-type'));
              if (asset.status !== 200 || (contentType && contentType !== 'application/octet-stream' && !Object.hasOwn(imageExtensions, contentType))) {
                await cancel(asset);
                return failure(asset.status, 'xai_image_download_mime_or_status_unsupported');
              }
              bytes = await readBytes(asset, limit, signal, callSecrets);
            }
            const mimeType = imageMime(bytes), declared = mime(item?.mime_type);
            if (!mimeType || (declared && declared !== mimeType) || (contentType && contentType !== 'application/octet-stream' && contentType !== mimeType)) throw new Error('xai_image_response_mime_invalid');
            remaining -= bytes.length;
            outputArtifacts.push({ kind: 'image', name: `xai-image-${fields.requestId}-${outputArtifacts.length + 1}.${imageExtensions[mimeType]}`,
              mimeType, sizeBytes: bytes.length, source: { bytes } });
          }
          return { ...fields, ok: true, status: response.status, error: null, outputArtifacts };
        });
      });
    },
  };
}
