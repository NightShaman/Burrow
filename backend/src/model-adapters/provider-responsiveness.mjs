// Provider responsiveness is an observation, not provider acceptance or a token
// estimate. These projections deliberately never copy error text or payloads.
const get = (value, key) => { try { return value?.[key]; } catch { return undefined; } };
const nonempty = value => typeof value === 'string' && value.length > 0;
export const hasProviderDelta = nonempty;
// Configured identities are not a credential channel. Reject recognizable key
// formats even when a malformed configuration places them in an ID or label.
const looksLikeCredential = value => /(?:^|[-_. ])(?:secret|password|credential|bearer|token|api[ _-]?key)(?:$|[-_. ])/i.test(value)
  || /^(?:sk-(?:proj-|test-|live-)?|xox[baprs]-|gh[opsu]_|AIza)[A-Za-z0-9_-]{8,}$/i.test(value);

export function configuredProviderId(value, limit = 160) {
  if (typeof value !== 'string' || value.length > limit || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/.test(value) || value.includes('://') || looksLikeCredential(value)) return null;
  return value;
}

export function configuredProviderName(value) {
  if (typeof value !== 'string') return null;
  const name = value.trim();
  // A readable configured label is trace-only. Do not export URLs, addresses,
  // control characters, or obvious credential material as a display name.
  return name.length > 0 && name.length <= 100 && /^[\p{L}\p{N} ._()\-]+$/u.test(name)
    && !looksLikeCredential(name) ? name : null;
}

export function providerIdentity(config = {}) {
  return {
    ...(configuredProviderId(config.connectionId) ? { accountId: configuredProviderId(config.connectionId) } : {}),
    ...(configuredProviderName(config.providerName || config.provider) ? { accountName: configuredProviderName(config.providerName || config.provider) } : {}),
  };
}

function timeoutEvidence(error, signal) {
  let current = error;
  for (let i = 0; current && i < 5; i++, current = get(current, 'cause')) {
    if (get(current, 'name') === 'TimeoutError' || ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'].includes(get(current, 'code'))) return true;
  }
  return get(signal, 'aborted') && get(get(signal, 'reason'), 'name') === 'TimeoutError';
}

export function providerCompletion(result, { error = null, signal = null, observedStatus = undefined } = {}) {
  // A status on a thrown exception is not an HTTP receipt. Actual fetch
  // headers can supply authoritative status even when later parsing throws.
  const candidate = observedStatus !== undefined ? observedStatus : error && !result?.requestId ? null : result?.status;
  const status = Number.isInteger(candidate) && candidate >= 100 && candidate <= 599 ? candidate : null;
  let outcome = 'failure', failureCategory = 'unknown';
  if (result?.timedOut === true || timeoutEvidence(error || get(result, 'cause'), signal)) { outcome = 'timeout'; failureCategory = 'timeout'; }
  else if (signal?.aborted || result?.cancelled === true || result?.modelFailure?.origin === 'cancelled' || get(error, 'name') === 'AbortError') { outcome = 'cancelled'; failureCategory = 'cancelled'; }
  else if (result?.ok === true && !error) { outcome = 'success'; failureCategory = null; }
  else if (status === 429) failureCategory = 'rate_limited';
  else if (status === 401) failureCategory = 'authentication';
  else if (status === 403) failureCategory = 'permission';
  else if (status === 408 || status === 504) failureCategory = 'timeout';
  else if (status >= 500) failureCategory = 'provider_5xx';
  else if (status >= 400) failureCategory = 'provider_4xx';
  else if (result?.modelFailure?.origin === 'burrow' || result?.recoveryFailure?.origin === 'burrow') failureCategory = 'local';
  else if (['provider_transport_failed', 'provider_read_failed', 'provider_stream_truncated'].includes(result?.modelFailure?.code)) failureCategory = 'transport';
  else if (result?.modelFailure?.origin === 'upstream') failureCategory = 'provider_generation';
  return { outcome, ...(status !== null ? { status } : {}), ...(failureCategory ? { failureCategory } : {}) };
}

// Provider-native usage is retained for protocol/debug compatibility. Consumers
// share this numeric-only projection instead of independently adding cache
// components (or treating an explicit unknown as an omitted field).
export function providerTokenCount(value) {
  if (value === null || value === undefined || typeof value === 'boolean' || (typeof value === 'string' && !value.trim())) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

const field = (value, names) => {
  for (const name of names) if (value && Object.hasOwn(value, name) && get(value, name) !== undefined) return { present:true, value:get(value, name) };
  return { present:false };
};
const sumTokens = values => values.every(value => value !== null) ? providerTokenCount(values.reduce((sum, value) => sum + value, 0)) : null;

export function providerUsageValues(usage, { provider = '', api = '' } = {}) {
  const inputField = field(usage, ['input_tokens', 'prompt_tokens', 'inputTokens', 'promptTokens']);
  const outputField = field(usage, ['output_tokens', 'completion_tokens', 'outputTokens', 'completionTokens']);
  const totalField = field(usage, ['total_tokens', 'totalTokens']);
  let input = providerTokenCount(inputField.value);
  const output = providerTokenCount(outputField.value);
  const nativeAnthropic = provider === 'anthropic' || api === 'anthropic-messages';
  if (nativeAnthropic) {
    // Native input_tokens excludes both cache reads and cache creation. Missing
    // optional components contribute nothing; supplied null/invalid components
    // make total input unknown. The cache_creation breakdown is not additional.
    const components = ['cache_read_input_tokens', 'cache_creation_input_tokens'].map(name => {
      const component = field(usage, [name]);
      return component.present ? providerTokenCount(component.value) : 0;
    });
    input = sumTokens([input, ...components]);
  }
  const nestedCache = field(get(usage, 'input_tokens_details'), ['cached_tokens']);
  const promptCache = field(get(usage, 'prompt_tokens_details'), ['cached_tokens']);
  const nativeCache = field(usage, ['cache_read_input_tokens']);
  const cache = nativeAnthropic && nativeCache.present ? nativeCache : nestedCache.present ? nestedCache : promptCache.present ? promptCache : nativeCache;
  let cached = providerTokenCount(cache.value);
  if (input !== null && cached !== null && cached > input) cached = null; // Never export an impossible subset.
  // An explicitly unknown total stays unknown; only an omitted total may be
  // derived. Anthropic's normalized total includes all input components once.
  const total = totalField.present
    ? providerTokenCount(totalField.value) === null ? null : nativeAnthropic ? sumTokens([input, output]) : providerTokenCount(totalField.value)
    : sumTokens([input, output]);
  return { input, output, total, cached };
}

// Project an already-normalized receipt without reinterpreting native fields.
// This allowlist is also the safe usage payload for physical completion events.
export function capturedProviderUsage(value) {
  return Object.fromEntries(['input', 'output', 'total', 'cached'].map(kind => [kind, providerTokenCount(get(value, kind))]));
}
