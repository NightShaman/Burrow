import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { readProviderError } from '../forge-diagnostics.mjs';
import { classifyModelFailure, markProviderTransportError, providerErrorSecrets, withProviderErrorScope } from '../model-failure.mjs';
import { mediaBudgets, mediaBytes } from './generated-media-budgets.mjs';
import { fetchProviderMedia, providerMediaEnvelopeResult } from './provider-fetch.mjs';
import { validatedSourceImages } from './reference-image-capability.mjs';
import { videoContract, videoReferenceImagesSupported, xaiVideoBase } from './video-contract.mjs';
import { normalizeVideoOptions, validateVideoRequest } from './video-generation-options.mjs';

// https://docs.x.ai/developers/model-capabilities/video/generation
function downloadUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('xai_video_download_url_invalid'); }
  // Signed CDN URLs are ephemeral. Never attach API credentials, follow a
  // redirect, or persist the URL in a receipt or an error.
  if (url.origin !== 'https://vidgen.x.ai' || url.username || url.password || url.hash) throw new Error('xai_video_download_url_invalid');
  return url.href;
}

export function createXaiVideoAdapter({ config = {}, fetchImpl = globalThis.fetch, idFactory = randomUUID, timeoutMs = 600_000, pollIntervalMs = 5_000 } = {}) {
  if (typeof fetchImpl !== 'function' || videoContract(config) !== 'xai') throw new Error('xai_video_contract_unsupported');
  const token = config.auth?.token || config.auth?.apiKey || config.apiKey;
  if (typeof token !== 'string' || !token.trim()) throw new Error('xai_video_api_key_required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000
    || !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0) throw new Error('xai_video_timeout_settings_invalid');
  const base = xaiVideoBase(config), url = `${base}/videos/generations`;
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token}` };
  const model = config.model, provider = 'xai', api = 'xai-video', budgets = mediaBudgets(config);
  const secrets = providerErrorSecrets(config, headers);
  return { provider, api, model, outputKind: 'video', url,
    async complete({ prompt, signal: callerSignal, sourceImages, videoOptions = config.forgeVideoOptions } = {}) {
      return withProviderErrorScope(secrets, async () => {
        callerSignal?.throwIfAborted();
        if (sourceImages !== undefined && !videoReferenceImagesSupported(config)) throw new Error('agent_reference_image_unsupported');
        const images = validatedSourceImages(sourceImages);
        const options = normalizeVideoOptions(videoOptions, { config, referenceCount: images?.length ?? 0 });
        const workflow = validateVideoRequest(config, options, images?.length ?? 0);
        const fields = { requestId: idFactory(), provider, api, model };
        const controller = new AbortController();
        const signal = callerSignal ? AbortSignal.any([controller.signal, callerSignal]) : controller.signal;
        const timer = setTimeout(() => controller.abort(Object.assign(new Error('xai_video_timeout'), { name: 'TimeoutError' })), timeoutMs);
        const failure = (status, error, errorDetails) => ({ ...fields, ok: false, status, outputArtifacts: [], error, ...(errorDetails ? { errorDetails, modelFailure: errorDetails.modelFailure } : {}) });
        async function bounded(operation) {
          signal.throwIfAborted();
          let abort;
          try {
            return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => {
              abort = () => reject(signal.reason);
              signal.addEventListener('abort', abort, { once: true });
              if (signal.aborted) abort();
            })]);
          } finally { signal.removeEventListener('abort', abort); }
        }
        async function fetchStep(target, init, step) {
          try { return await bounded(() => fetchProviderMedia(fetchImpl, target, { ...init, signal, redirect: 'manual' })); }
          catch (error) {
            if (signal.aborted) throw signal.reason;
            // Underlying exceptions may include the signed download URL.
            const safe = new TypeError(`xai_video_${step}_transport_failed`);
            throw classifyModelFailure(error).origin === 'upstream' ? markProviderTransportError(safe, { stage: 'fetch' }) : safe;
          }
        }
        async function jsonStep(target, init, step) {
          const response = await fetchStep(target, init, step);
          if (!response.ok) {
            const details = await bounded(() => readProviderError(response, secrets));
            return { failure: failure(response.status, details.message, details) };
          }
          const bytes = await bounded(() => mediaBytes(response, budgets.metadata));
          let payload;
          try { payload = JSON.parse(bytes.toString('utf8')); }
          catch { throw new Error(`xai_video_${step}_json_invalid`); }
          return { payload, status: response.status, failure: providerMediaEnvelopeResult(payload, { ...fields, status: response.status }) };
        }
        try {
          // Exactly one paid POST. Pending state only triggers read-only GETs.
          const submit = await jsonStep(url, { method: 'POST', headers, body: JSON.stringify({ model, prompt: String(prompt || ''),
            ...(workflow.id === 'image-to-video' ? { image: { url: `data:${images[0].mimeType};base64,${images[0].bytes.toString('base64')}` } } : {}),
            ...(workflow.id === 'reference-to-video' ? { reference_images: images.map(({ bytes, mimeType }) => ({ url: `data:${mimeType};base64,${bytes.toString('base64')}` })) } : {}),
            ...(options?.durationSeconds !== undefined ? { duration: options.durationSeconds } : {}),
            ...(options?.aspectRatio !== undefined ? { aspect_ratio: options.aspectRatio } : {}),
            ...(options?.resolution !== undefined ? { resolution: options.resolution } : {}),
          }) }, 'submit');
          if (submit.failure) return submit.failure;
          const requestId = submit.payload?.request_id;
          if (typeof requestId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(requestId)) throw new Error('xai_video_request_id_invalid');
          let result;
          do {
            await delay(pollIntervalMs, undefined, { signal });
            result = await jsonStep(`${base}/videos/${requestId}`, { method: 'GET', headers }, 'poll');
            if (result.failure) return result.failure;
          } while (result.payload?.status === 'pending');
          if (result.payload?.status !== 'done') {
            const state = ['failed', 'expired'].includes(result.payload?.status) ? result.payload.status : 'invalid';
            return failure(result.status, `xai_video_status_${state}`);
          }
          const response = await fetchStep(downloadUrl(result.payload.video?.url), { method: 'GET' }, 'download');
          if (!response.ok) {
            // CDN errors can echo signed URL data; preserve the status, not the body.
            await bounded(() => response.body?.cancel());
            return failure(response.status, `xai_video_download_http_${response.status}`);
          }
          const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
          if (response.status !== 200 || (contentType && !['video/mp4', 'application/octet-stream'].includes(contentType))) {
            await bounded(() => response.body?.cancel());
            return failure(response.status, 'xai_video_download_mime_or_status_unsupported');
          }
          let bytes;
          try { bytes = await bounded(() => mediaBytes(response, Math.min(budgets.asset, budgets.total))); }
          catch (error) {
            if (signal.aborted) throw signal.reason;
            if (classifyModelFailure(error).origin === 'upstream') throw markProviderTransportError(new Error('xai_video_download_read_failed'), { stage: 'read' });
            throw error;
          }
          if (bytes.length < 12 || bytes.toString('ascii', 4, 8) !== 'ftyp') return failure(response.status, 'xai_video_download_not_mp4');
          return { ...fields, ok: true, status: response.status, outputArtifacts: [{ kind: 'video', name: `xai-${fields.requestId}.mp4`,
            mimeType: 'video/mp4', sizeBytes: bytes.length, source: { bytes } }] };
        } finally { clearTimeout(timer); }
      });
    },
  };
}
