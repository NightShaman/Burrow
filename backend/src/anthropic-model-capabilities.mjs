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
  if (effort?.supported !== true && !['low','medium','high','xhigh','max'].some(level => effort?.[level]?.supported === true)) return undefined;
  // Preserve the native names. In particular, max and xhigh are not aliases.
  const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
  const supported = levels.filter(level => effort[level]?.supported === true);
  return supported.length || levels.every(level => effort[level]?.supported === false) ? supported : undefined;
}

export const ANTHROPIC_THINKING_MODES = Object.freeze(['default', 'disabled', 'adaptive', 'enabled', 'between_tools']);
export const ANTHROPIC_NATIVE_EFFORTS = Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']);
export const ANTHROPIC_MANUAL_BUDGETS = Object.freeze({ minimal: 1024, low: 4000, medium: 8000, high: 16000, xhigh: 32000, max: 32000, ultra: 32000 });

export function normalizeAnthropicThinkingMode(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !ANTHROPIC_THINKING_MODES.includes(value)) throw new Error('model_thinking_mode_invalid');
  return value;
}

function claudeModelId(model) {
  return normalize(model).replace(/^anthropic\//, '').replace(/[._\s]+/g, '-');
}

// Conservative documented fallbacks for older catalogues and compatible proxies.
// Exact native booleans take precedence, including explicit unsupported values.
function documentedThinking(model) {
  const id = claudeModelId(model);
  const match = pattern => pattern.test(id);
  const all = ['low', 'medium', 'high', 'xhigh', 'max'];
  const regular = ['low', 'medium', 'high', 'max'];
  if (match(/^claude-(?:opus-5-5|fable-5(?:-1)?|mythos-5(?:-1)?)(?:-|$)/)) return { modes: ['adaptive'], efforts: all, onByDefault: true };
  if (match(/^claude-sonnet-5-5(?:-|$)/)) return { modes: ['adaptive', 'between_tools'], efforts: all, onByDefault: true, limited: 'between_tools' };
  if (match(/^claude-(?:haiku-5-5|opus-5)(?:-|$)/)) return { modes: ['disabled', 'adaptive'], efforts: all, onByDefault: true, limited: 'disabled' };
  if (match(/^claude-sonnet-5(?:-|$)/)) return { modes: ['disabled', 'adaptive'], efforts: all, onByDefault: true };
  if (match(/^claude-mythos-preview(?:-|$)/)) return { modes: ['adaptive', 'enabled'], efforts: regular, onByDefault: true };
  if (match(/^claude-opus-4-(?:7|8)(?:-|$)/)) return { modes: ['disabled', 'adaptive'], efforts: all };
  if (match(/^claude-(?:opus|sonnet)-4-6(?:-|$)/)) return { modes: ['disabled', 'adaptive', 'enabled'], efforts: regular };
  if (match(/^claude-opus-4-5(?:-|$)/)) return { modes: ['disabled', 'enabled'], efforts: ['low', 'medium', 'high'] };
  if (match(/^claude-(?:(?:sonnet|haiku)-4-5|(?:opus|sonnet)-4(?:-0|-1)?|3-7-sonnet)(?:-|$)/)) return { modes: ['disabled', 'enabled'], efforts: [] };
  if (match(/^claude-(?:3(?:-5)?-(?:haiku|sonnet|opus)|(?:haiku|sonnet|opus)-3)(?:-|$)/)) return { modes: ['disabled'], efforts: [] };
  return { modes: [], efforts: undefined };
}

export function anthropicThinkingCapabilities({ model = '', anthropicMetadata = null, reasoningEfforts } = {}) {
  const fallback = documentedThinking(model);
  const thinking = anthropicMetadata?.capabilities?.thinking;
  const modes = ['disabled', 'adaptive', 'enabled', 'between_tools'].filter(mode => {
    const native = thinking?.types?.[mode]?.supported;
    if (typeof native === 'boolean') return native;
    if (thinking?.supported === false) return mode === 'disabled';
    return fallback.modes.includes(mode);
  });
  const effortMetadata = anthropicMetadata?.capabilities?.effort;
  const nativeEfforts = anthropicDiscoveredReasoningEfforts(anthropicMetadata);
  const declaredEfforts = Array.isArray(reasoningEfforts) ? reasoningEfforts.filter(level => ANTHROPIC_NATIVE_EFFORTS.includes(level)) : [];
  const inferredEfforts = fallback.efforts ?? (declaredEfforts.length ? declaredEfforts : undefined);
  // A partially populated effort snapshot must still honor explicit false.
  const efforts = (nativeEfforts ?? inferredEfforts ?? [])
    .filter(level => effortMetadata?.[level]?.supported !== false);
  const thinkingEfforts = Object.fromEntries(['default', ...modes].map(mode => [mode,
    mode === fallback.limited || mode === 'between_tools' ? efforts.filter(level => ['low', 'medium', 'high'].includes(level)) : [...efforts],
  ]));
  return { thinkingModes: ['default', ...modes], thinkingEfforts, thinkingDefault: fallback.onByDefault ? 'adaptive' : (fallback.modes.length ? 'disabled' : null) };
}

export function validateAnthropicThinkingSelection({ model = '', anthropicMetadata = null, reasoningEfforts, thinkingMode, reasoningEffort = 'off' } = {}) {
  const mode = normalizeAnthropicThinkingMode(thinkingMode);
  if (mode === null) return;
  const caps = anthropicThinkingCapabilities({ model, anthropicMetadata, reasoningEfforts });
  if (!caps.thinkingModes.includes(mode)) throw new Error('model_thinking_mode_not_supported');
  const effort = String(reasoningEffort ?? 'off');
  if (effort !== 'off' && !caps.thinkingEfforts[mode]?.includes(effort)) throw new Error('model_reasoning_effort_not_supported');
}

// Legacy records remain distinguishable from explicit provider defaults. Resolve
// their historical intent without rewriting stored values or substituting a
// different native mode when that intent is unsupported by a selected model.
export function anthropicLegacyThinkingMode({ model = '', anthropicMetadata = null, reasoningEfforts, reasoningEffort } = {}) {
  if (reasoningEffort === undefined || reasoningEffort === null || reasoningEffort === '') return 'default';
  if (reasoningEffort === 'off') return 'disabled';
  const { thinkingModes } = anthropicThinkingCapabilities({ model, anthropicMetadata, reasoningEfforts });
  return thinkingModes.includes('adaptive') ? 'adaptive' : 'enabled';
}
