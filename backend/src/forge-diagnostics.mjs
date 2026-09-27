const DEFAULT_PROVIDER_ERROR_BYTES = 16 * 1024;
const PUBLIC_DIAGNOSTIC_KEYS = Object.freeze(['stage', 'message', 'code', 'httpStatus', 'requestId', 'truncated', 'observedBytes', 'maxBytes']);

function text(value) { return typeof value === 'string' ? value : ''; }

export function providerErrorByteBudget(env = process.env) {
  const value = Number(env.BURROW_PROVIDER_ERROR_MAX_BYTES || '');
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_PROVIDER_ERROR_BYTES;
}

function configSecrets(config) {
  const out = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && /(api[-_]?key|bearer|token|secret|password|credential|authorization)/i.test(key)) out.push(item);
      else if (item && typeof item === 'object') visit(item);
    }
  };
  visit(config);
  return [...new Set(out)].filter(Boolean).sort((a, b) => b.length - a.length);
}

export function sanitizeDiagnostic(value, secrets = []) {
  let result = text(value) || 'generation failed';
  for (const secret of [...new Set(secrets)].filter(Boolean)) result = result.split(secret).join('[redacted]');
  return result
    .replace(/\bBearer\s+[^\s,;]+/ig, 'Bearer [redacted]')
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/ig, '$1[redacted]')
    .replace(/((?:api[-_]?key|token|secret|password|credential)\s*[:=]\s*)[^\s,;&]+/ig, '$1[redacted]')
    .replace(/([?&](?:api[-_]?key|token|signature|sig|credential|access_token|x-amz-[^=]*)=)[^&#\s]+/ig, '$1[redacted]');
}

function removePartialSecret(value, secrets) {
  let result = value;
  for (const secret of [...new Set(secrets)].filter(Boolean)) {
    for (let length = Math.min(secret.length - 1, result.length); length > 0; length -= 1) {
      if (secret.startsWith(result.slice(-length))) { result = result.slice(0, -length); break; }
    }
  }
  return result;
}

/** Bounded error-body transport. Native fetch streams enforce the limit before copying. */
export async function readProviderError(response, secrets = [], { byteBudget = providerErrorByteBudget() } = {}) {
  const limit = Number.isSafeInteger(byteBudget) && byteBudget > 0 ? byteBudget : DEFAULT_PROVIDER_ERROR_BYTES;
  const reader = response?.body?.getReader?.();
  const decoder = new TextDecoder('utf-8');
  let decoded = '', copied = 0, observedBytes = 0, truncated = false;
  if (!reader) {
    // Compatibility for injected fetch mocks only; native Response always streams.
    const body = typeof response?.text === 'function' ? await response.text() : '';
    const bytes = Buffer.from(body, 'utf8');
    observedBytes = bytes.length;
    truncated = observedBytes > limit;
    decoded = decoder.decode(bytes.subarray(0, limit), { stream: truncated });
  } else {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        observedBytes += value.byteLength;
        const take = Math.min(limit - copied, value.byteLength);
        if (take > 0) decoded += decoder.decode(value.subarray(0, take), { stream: true });
        copied += take;
        if (observedBytes > limit) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
      // Do not flush an incomplete trailing UTF-8 codepoint after cancellation.
      if (!truncated) decoded += decoder.decode();
    } finally { reader.releaseLock?.(); }
  }
  let code;
  if (!truncated) {
    try {
      const parsed = JSON.parse(decoded);
      code = parsed?.error?.status ?? parsed?.error?.code ?? parsed?.status ?? parsed?.code;
      const message = parsed?.error?.message ?? parsed?.message;
      if (typeof message === 'string') decoded = message;
    } catch {}
  }
  const message = sanitizeDiagnostic(truncated ? removePartialSecret(decoded, secrets) : decoded, secrets);
  return { message, ...(typeof code === 'string' || typeof code === 'number' ? { code: sanitizeDiagnostic(String(code), secrets) } : {}),
    ...(truncated ? { truncated: true, observedBytes, maxBytes: limit } : {}) };
}

export function diagnostic(error, stage, config = {}, fallback = 'generation failed', { byteBudget = providerErrorByteBudget() } = {}) {
  const details = error?.errorDetails || {};
  const rawMessage = text(details.message || error?.message || fallback) || fallback;
  const configuredLimit = Number.isSafeInteger(byteBudget) && byteBudget > 0 ? byteBudget : DEFAULT_PROVIDER_ERROR_BYTES;
  const result = { stage: text(details.stage) || stage, message: sanitizeDiagnostic(rawMessage, configSecrets(config)) };
  if (details.code || error?.code || error?.cause?.code) result.code = sanitizeDiagnostic(details.code || error.code || error.cause.code, configSecrets(config));
  if (Number.isInteger(details.httpStatus)) result.httpStatus = details.httpStatus;
  if (details.requestId) result.requestId = sanitizeDiagnostic(details.requestId, configSecrets(config));
  if (details.truncated === true) Object.assign(result, { truncated: true, ...(Number.isSafeInteger(details.observedBytes) ? { observedBytes: details.observedBytes } : {}), ...(Number.isSafeInteger(details.maxBytes) ? { maxBytes: details.maxBytes } : { maxBytes: configuredLimit }) });
  return Object.fromEntries(PUBLIC_DIAGNOSTIC_KEYS.filter(key => result[key] !== undefined).map(key => [key, result[key]]));
}

export const __test__ = { configSecrets };

// Exact configured-secret replacement is deterministic. Patterns are best effort,
// not a guarantee that arbitrary unknown sensitive text can be recognized.
