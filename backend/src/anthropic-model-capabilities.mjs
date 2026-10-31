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
  return normalize(provider).includes('anthropic') || ['anthropic-messages', 'anthropic-lb'].includes(normalize(apiType || api));
}

// Models API metadata is descriptive, not an instruction to select a thinking
// mode, enable server tools, or spend the model's entire output allowance.
// Keep explicit false/null distinct from an omitted (unknown) capability.
const ANTHROPIC_CAPABILITY_FIELDS = Object.freeze({
  batch: null, citations: null, code_execution: null, image_input: null,
  pdf_input: null, structured_outputs: null,
  effort: { low: null, medium: null, high: null, xhigh: null, max: null },
  thinking: { types: { disabled: null, enabled: null, adaptive: null, between_tools: null } },
  context_management: { clear_thinking_20251015: null, clear_tool_uses_20250919: null, compact_20260112: null },
  server_tools: { code_execution: null, web_search: null },
});

function capabilityObject(value, fields = {}) {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  if (typeof value.supported === 'boolean') result.supported = value.supported;
  for (const [key, nested] of Object.entries(fields)) {
    const normalized = capabilityObject(value[key], nested || {});
    if (normalized !== undefined) result[key] = normalized;
  }
  return Object.keys(result).length ? result : undefined;
}

export function normalizeAnthropicModelMetadata(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const result = {};
  // These are bounded public catalogue fields, never arbitrary provider payloads.
  for (const key of ['line', 'lifecycle', 'created_at', 'deprecated_at', 'retires_at']) {
    if (value[key] === null || (typeof value[key] === 'string' && value[key].length <= 128)) result[key] = value[key];
  }
  for (const key of ['max_input_tokens', 'max_tokens']) {
    if (value[key] === null || (Number.isSafeInteger(value[key]) && value[key] > 0)) result[key] = value[key];
  }
  if (value.capabilities === null) result.capabilities = null;
  else if (value.capabilities && typeof value.capabilities === 'object' && !Array.isArray(value.capabilities)) {
    const capabilities = {};
    for (const [key, fields] of Object.entries(ANTHROPIC_CAPABILITY_FIELDS)) {
      const normalized = capabilityObject(value.capabilities[key], fields || {});
      if (normalized !== undefined) capabilities[key] = normalized;
    }
    if (Object.keys(capabilities).length) result.capabilities = capabilities;
  }
  return Object.keys(result).length ? result : null;
}

export function anthropicDiscoveredReasoningEfforts(metadata) {
  const effort = metadata?.capabilities?.effort;
  if (effort?.supported === false) return [];
  if (effort?.supported !== true) return undefined;
  // Preserve the native names. In particular, max and xhigh are not aliases.
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
  const supported = levels.filter(level => effort[level]?.supported === true);
  return supported.length || levels.every(level => effort[level]?.supported === false) ? supported : undefined;
}
