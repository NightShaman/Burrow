function normalize(value) { return String(value ?? '').trim().toLowerCase(); }

/**
 * Claude 4.6 and earlier accept configurable sampling parameters when thinking
 * is off. Opus 4.7 onward (including 4.8 and Claude 5) rejects non-default
 * `temperature`, `top_p`, and `top_k`. Unknown future IDs default off.
 */
export function anthropicSupportsSamplingParameters(modelId = '') {
  return /^claude-(?:opus|sonnet|haiku)-4-(?:5|6)(?:-|$)/.test(normalize(modelId));
}

export function anthropicSupportsTemperature(modelId = '') {
  return anthropicSupportsSamplingParameters(modelId);
}

export function isAnthropicMessagesConnection({ provider = '', apiType = '', api = '' } = {}) {
  return normalize(provider).includes('anthropic') || normalize(apiType || api) === 'anthropic-messages';
}
