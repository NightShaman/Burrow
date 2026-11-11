import { randomUUID } from 'node:crypto';
import { googleNativeApi, googleNativeBase, googleNativeHeaders, googleModelId } from './google-native-catalog.mjs';
import { mediaBudgets, mediaBytes, decodeMedia } from './generated-media-budgets.mjs';
import { validatedSourceImages } from './reference-image-capability.mjs';
import { fetchProviderMedia, providerMediaEnvelopeResult } from './provider-fetch.mjs';
import { providerErrorSecrets, withProviderErrorScope, markProviderTransportError, classifyModelFailure } from '../model-failure.mjs';
import { readProviderError } from '../forge-diagnostics.mjs';

// https://aistudio.google.com/docs/omni#rest-response-schema
// https://aistudio.google.com/docs/omni#subject-reference
// https://aistudio.google.com/api-reference/interactions-api/create-interaction
// REST uses steps[].content[].data, NOT the SDK-only output_video convenience field.
// Default synchronous Interactions calls need no LRO/poll. The reference images
// are content items, not Veo's retired predictLongRunning referenceImages.
export function googleVideoSupported(config = {}) {
  const outputs = config.capabilities?.outputs ?? config.acceptedOutput;
  const methods = config.supportedGenerationMethods;
  try {
    return googleNativeApi(config) && googleNativeBase(config).endsWith('/v1beta')
      && (!config.auth?.type || config.auth.type === 'api_key')
      && Array.isArray(outputs) && outputs.includes('video')
      && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(googleModelId(config.model))
      // Discovery methods for legacy-only Veo cannot authorize Interactions.
      && (!Array.isArray(methods) || !methods.includes('predictLongRunning') || methods.includes('interactions.create'));
  } catch { return false; }
}

const abortError = () => Object.assign(new Error('google_video_cancelled'), { name: 'AbortError' });
const timeoutError = () => Object.assign(new Error('google_video_timeout'), { name: 'TimeoutError' });
// Buffer.from(base64) tolerates junk, so validate the wire encoding first.
// Scan iteratively: payload-sized repeating regexes exhaust V8's regexp stack.
function validVideoBase64(value) {
  if (typeof value !== 'string' || !value.length || value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const end = value.length - padding;
  for (let index = 0; index < end; index++) {
    const code = value.charCodeAt(index);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57) || code === 43 || code === 47)) return false;
  }
  return true;
}

export function createGoogleVideoAdapter({ config = {}, fetchImpl = globalThis.fetch, idFactory = randomUUID, timeoutMs = 600_000 } = {}) {
  if (typeof fetchImpl !== 'function' || !googleVideoSupported(config)) throw new Error('google_video_contract_unsupported');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 1_800_000) throw new Error('google_video_timeout_settings_invalid');
  const base = googleNativeBase(config), model = googleModelId(config.model), headers = googleNativeHeaders(config);
  const budgets = mediaBudgets(config), secrets = providerErrorSecrets(config, headers);
  const url = `${base}/interactions`;
  return { provider: 'google', api: 'google-interactions', model, outputKind: 'video', url,
    async complete({ prompt, signal: callerSignal, sourceImages: inputImages } = {}) {
      return withProviderErrorScope(secrets, async () => {
        if (callerSignal?.aborted) throw abortError();
        if (Array.isArray(inputImages) && inputImages.length > 6) throw new Error('google_video_reference_image_limit_exceeded');
        const images = validatedSourceImages(inputImages);
        const inputs = config.capabilities?.inputs ?? config.acceptedInput;
        const flags = [config.capabilities?.images, config.capabilities?.vision, config.supportsVision, config.vision];
        if (images && (Array.isArray(inputs) ? !inputs.includes('image') : flags.some(v => typeof v === 'boolean') && !flags.includes(true))) {
          throw new Error('agent_reference_image_unsupported');
        }
        // Saved portraits are subject references rather than an initial frame.
        // Omni documents reference_to_video versus image_to_video (first-frame)
        // in generation_config.video_config.task; never send Veo asset wrappers.
        const input = images ? [...images.map(({ bytes, mimeType }) => ({ type: 'image', data: bytes.toString('base64'), mime_type: mimeType })),
          { type: 'text', text: String(prompt || '') }] : String(prompt || '');
        const fields = { requestId: idFactory(), provider: 'google', api: 'google-interactions', model };
        const controller = new AbortController();
        const cancel = () => controller.abort(abortError());
        callerSignal?.addEventListener('abort', cancel, { once: true });
        const timer = setTimeout(() => controller.abort(timeoutError()), timeoutMs);
        const signal = controller.signal;
        // Bound injected transports and response readers that ignore AbortSignal.
        async function bounded(action) {
          signal.throwIfAborted();
          let onAbort;
          try {
            return await Promise.race([Promise.resolve().then(action), new Promise((_, reject) => {
              onAbort = () => reject(signal.reason);
              signal.addEventListener('abort', onAbort, { once: true });
              if (signal.aborted) onAbort();
            })]);
          } finally { signal.removeEventListener('abort', onAbort); }
        }
        try {
          let response;
          try {
            // Exactly one paid POST. Never automatically follow a credentialed redirect.
            response = await bounded(() => fetchProviderMedia(fetchImpl, url, { method: 'POST', headers,
              body: JSON.stringify({ model, input, ...(images ? { generation_config: { video_config: { task: 'reference_to_video' } } } : {}) }), signal, redirect: 'manual' }));
          } catch (error) {
            if (signal.aborted) throw signal.reason;
            const safe = classifyModelFailure(error).origin === 'upstream'
              ? markProviderTransportError(new TypeError('google_video_transport_failed'), { stage: 'fetch' })
              : new Error('google_video_transport_failed');
            throw safe;
          }
          if (!response.ok) {
            let details;
            try { details = await bounded(() => readProviderError(response, secrets)); }
            catch {
              if (signal.aborted) throw signal.reason;
              throw markProviderTransportError(new Error('google_video_response_read_failed'), { stage: 'read' });
            }
            return { ...fields, ok: false, status: response.status, outputArtifacts: [], error: details.message,
              errorDetails: details, modelFailure: details.modelFailure };
          }
          let bytes;
          try { bytes = await bounded(() => mediaBytes(response, budgets.metadata)); }
          catch (error) {
            if (signal.aborted) throw signal.reason;
            if (classifyModelFailure(error).origin === 'upstream') throw markProviderTransportError(new Error('google_video_response_read_failed'), { stage: 'read' });
            throw error;
          }
          let data;
          try { data = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('google_video_response_json_invalid'); }
          const failure = providerMediaEnvelopeResult(data, { ...fields, status: response.status });
          if (failure) return failure;
          if (data?.status !== 'completed') {
            // Synchronous calls must finish. An unexpected background state cannot
            // be treated as a successful generation or trigger another paid POST.
            const status = ['in_progress', 'failed', 'cancelled', 'incomplete', 'requires_action', 'requires_continuation'].includes(data?.status)
              ? data.status : 'invalid';
            return { ...fields, ok: false, status: response.status, outputArtifacts: [], error: `google_video_interaction_${status}` };
          }
          const videos = (Array.isArray(data.steps) ? data.steps : [])
            .filter(step => step?.type === 'model_output')
            .flatMap(step => Array.isArray(step.content) ? step.content.filter(content => content?.type === 'video') : []);
          if (!videos.length) return { ...fields, ok: false, status: response.status, outputArtifacts: [], error: 'google_returned_no_video' };
          if (videos.length > budgets.count) throw new Error('generated_media_artifact_count_exceeded');
          const outputArtifacts = [];
          let remaining = budgets.total;
          for (const video of videos) {
            if (video.mime_type !== 'video/mp4') throw new Error('google_video_mime_unsupported');
            if (!validVideoBase64(video.data)) throw new Error('google_video_payload_unsupported');
            const decoded = decodeMedia(video.data, Math.min(remaining, budgets.asset));
            if (!decoded.length) throw new Error('google_video_payload_unsupported');
            remaining -= decoded.length;
            outputArtifacts.push({ kind: 'video', name: `google-${fields.requestId}-${outputArtifacts.length}.mp4`,
              mimeType: 'video/mp4', sizeBytes: decoded.length, source: { bytes: decoded } });
          }
          return { ...fields, ok: true, status: response.status, outputArtifacts };
        } finally {
          clearTimeout(timer);
          callerSignal?.removeEventListener('abort', cancel);
        }
      });
    },
  };
}
