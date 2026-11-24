import { randomUUID } from 'node:crypto';
import { googleNativeBase, googleNativeHeaders } from './google-native-catalog.mjs';
import { googleSpeechContract, googleSpeechModel, GOOGLE_SPEECH_DEFAULT_VOICE } from './google-speech-contract.mjs';
import { fetchProviderMedia, providerMediaEnvelopeResult } from './provider-fetch.mjs';
import { mediaBudgets, mediaBytes, decodeMedia } from './generated-media-budgets.mjs';
import { classifyModelFailure, providerErrorSecrets, sanitizeProviderMessage, withProviderErrorScope } from '../model-failure.mjs';
import { readProviderError, sanitizeDiagnostic } from '../forge-diagnostics.mjs';

// Native single-speaker, unary Interactions only. The official speech guide's
// REST example uses generation_config.speech_config (the generic API reference
// currently calls it structured_speech_config; see google-speech-sources.md).
// https://aistudio.google.com/docs/speech-generation#single-speaker
// https://aistudio.google.com/docs/speech-generation#audio-output-formats
// No legacy generateContent/PCM parser, streaming, asset fetch, retry or fallback.
export { googleSpeechContract } from './google-speech-contract.mjs';

const cancelled = () => Object.assign(new Error('google_speech_cancelled'), { name: 'AbortError' });
function safeTransportError(error, code, secrets) {
  // Keep the shared fetch/read provenance without retaining the raw exception
  // or cause. Error results are recognized by the shared failure classifier.
  const upstreamCode = error?.code ?? error?.cause?.code;
  return Object.assign(new Error(code), { ok: false, modelFailure: classifyModelFailure(error),
    errorDetails: { message: sanitizeDiagnostic(error?.message || code, secrets),
      ...(upstreamCode ? { code: sanitizeDiagnostic(String(upstreamCode), secrets) } : {}) } });
}

// Buffer.from(base64) silently tolerates junk. Iterative scanning also avoids
// the regexp stack overflow possible on multi-megabyte generated audio.
function validBase64(value) {
  if (typeof value !== 'string' || !value.length || value.length % 4 !== 0) return false;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const end = value.length - padding;
  for (let index = 0; index < end; index++) {
    const code = value.charCodeAt(index);
    if (!((code >= 65 && code <= 90) || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57) || code === 43 || code === 47)) return false;
  }
  // Reject non-canonical unused bits as well as invalid characters/padding.
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  return !padding || (alphabet.indexOf(value[end - 1]) & (padding === 2 ? 15 : 3)) === 0;
}

function completeWave(bytes) {
  if (bytes.length < 44 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE'
    || bytes.readUInt32LE(4) + 8 !== bytes.length) return false;
  let offset = 12, format = false, audio = false;
  while (offset + 8 <= bytes.length) {
    const size = bytes.readUInt32LE(offset + 4), end = offset + 8 + size;
    if (end > bytes.length) return false;
    const type = bytes.toString('ascii', offset, offset + 4);
    if (type === 'fmt ') format ||= size >= 16;
    if (type === 'data') audio ||= size > 0;
    offset = end + (size % 2); // RIFF chunks are word-aligned.
  }
  return offset === bytes.length && format && audio;
}

export function createGoogleSpeechAdapter({ config = {}, fetchImpl = globalThis.fetch, idFactory = randomUUID } = {}) {
  if (typeof fetchImpl !== 'function' || !googleSpeechContract(config)) throw new Error('google_speech_contract_unsupported');
  const model = googleSpeechModel(config.model), headers = googleNativeHeaders(config);
  if (typeof headers['x-goog-api-key'] !== 'string' || !headers['x-goog-api-key'].trim()
    || /[\r\n]/.test(headers['x-goog-api-key'])) throw new Error('google_developer_api_key_required');
  const budgets = mediaBudgets(config), secrets = providerErrorSecrets(config, headers);
  const url = `${googleNativeBase(config)}/interactions`;
  return { provider: 'google', api: 'google-interactions', model, url, outputKind: 'audio', supportsVision: false,
    async complete({ prompt, signal: callerSignal, sourceImages } = {}) {
      return withProviderErrorScope(secrets, async () => {
        // Reject even an explicitly empty reference list: no image-input wire
        // contract exists here, and no paid POST may precede this guard.
        if (config.generatedArtifactOptions != null && (typeof config.generatedArtifactOptions !== 'object' || Array.isArray(config.generatedArtifactOptions) || Object.keys(config.generatedArtifactOptions).length)) throw new Error('google_speech_options_unsupported');
        if (sourceImages !== undefined) throw new Error('agent_reference_image_unsupported');
        if (callerSignal?.aborted) throw cancelled();
        if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('google_speech_prompt_required');
        const fields = { requestId: idFactory(), provider: 'google', api: 'google-interactions', model };
        const controller = new AbortController();
        const cancel = () => controller.abort(cancelled());
        callerSignal?.addEventListener('abort', cancel, { once: true });
        if (callerSignal?.aborted) cancel();
        const signal = controller.signal;
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
          const body = {
            model,
            // The new model treats text as a verbatim transcript. Do not trim,
            // add spoken instructions, or infer speaker/style from the prompt.
            input: [{ type: 'user_input', content: [{ type: 'text', text: prompt }] }],
            response_format: { type: 'audio', mime_type: 'audio/wav' },
            generation_config: { speech_config: [{ voice: GOOGLE_SPEECH_DEFAULT_VOICE }] },
            stream: false,
            store: false,
          };
          let response;
          try {
            response = await bounded(() => fetchProviderMedia(fetchImpl, url, { method: 'POST', headers,
              body: JSON.stringify(body), signal, redirect: 'manual' }));
          } catch (error) {
            if (signal.aborted) throw signal.reason;
            throw safeTransportError(error, 'google_speech_transport_failed', secrets);
          }
          const resultFields = { ...fields, status: response.status };
          if (!response.ok) {
            let details;
            try { details = await bounded(() => readProviderError(response, secrets)); }
            catch (error) {
              if (signal.aborted) throw signal.reason;
              throw safeTransportError(error, 'google_speech_response_read_failed', secrets);
            }
            const providerRequestId = sanitizeProviderMessage(response.headers?.get?.('x-request-id'), secrets);
            details = { ...details, httpStatus: response.status, ...(providerRequestId ? { requestId: providerRequestId } : {}) };
            return { ...resultFields, ok: false, outputArtifacts: [], error: details.message, errorDetails: details, modelFailure: details.modelFailure };
          }
          let bytes;
          try { bytes = await bounded(() => mediaBytes(response, budgets.metadata)); }
          catch (error) {
            if (signal.aborted) throw signal.reason;
            if (classifyModelFailure(error).origin === 'upstream') throw safeTransportError(error, 'google_speech_response_read_failed', secrets);
            throw error;
          }
          let data;
          try { data = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('google_speech_response_json_invalid'); }
          const failure = providerMediaEnvelopeResult(data, resultFields);
          if (failure) return failure;
          if (data?.status !== 'completed') {
            const status = ['in_progress', 'failed', 'cancelled', 'incomplete', 'requires_action', 'requires_continuation'].includes(data?.status) ? data.status : 'invalid';
            return { ...resultFields, ok: false, outputArtifacts: [], error: `google_speech_interaction_${status}` };
          }
          // REST steps are authoritative; output_audio is an SDK convenience
          // property, not an alternate response contract to guess or retry.
          const audio = (Array.isArray(data.steps) ? data.steps : [])
            .filter(step => step?.type === 'model_output')
            .flatMap(step => Array.isArray(step.content) ? step.content.filter(item => item?.type === 'audio') : []);
          if (!audio.length) return { ...resultFields, ok: false, outputArtifacts: [], error: 'google_returned_no_speech' };
          if (audio.length > budgets.count) throw new Error('generated_media_artifact_count_exceeded');
          const outputArtifacts = [];
          let remaining = budgets.total;
          for (const item of audio) {
            if (item.mime_type !== undefined && item.mime_type !== 'audio/wav') throw new Error('google_speech_mime_unsupported');
            if (!validBase64(item.data)) throw new Error('google_speech_payload_unsupported');
            const decoded = decodeMedia(item.data, Math.min(budgets.asset, remaining));
            if (!completeWave(decoded)) throw new Error('google_speech_wav_invalid');
            remaining -= decoded.length;
            outputArtifacts.push({ kind: 'audio', name: `google-speech-${fields.requestId}-${outputArtifacts.length}.wav`,
              mimeType: 'audio/wav', sizeBytes: decoded.length, source: { bytes: decoded } });
          }
          return { ...resultFields, ok: true, outputArtifacts };
        } finally {
          callerSignal?.removeEventListener('abort', cancel);
        }
      });
    },
  };
}
