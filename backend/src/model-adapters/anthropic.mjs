import { redactText } from '../redaction.mjs';
import { DEFAULT_MODEL_OUTPUT_TOKENS } from '../config.mjs';
import { anthropicSupportsSamplingParameters } from '../anthropic-model-capabilities.mjs';
import {
  CLAUDE_CODE_VERSION,
  CLAUDE_CODE_BILLING_SYSTEM_BLOCK,
  DEFAULT_MAX_RESPONSE_BYTES,
  MAX_MODEL_TEXT_CHARS,
  boundedText,
  contextUsageFromRequest,
  contextUsageFromResponse,
  normalizeProviderMessage,
  normalizeProviderMessages,
  normalizeToolCall,
  parseArguments,
  randomUUID,
  redactHeaders,
  serializedMessageHash,
  toolOutputText,
  attachmentViewUserMessage,
  trimSlash,
  readResponseTextBounded,
} from './shared.mjs';

function anthropicUrl(config = {}) {
  const baseUrl = trimSlash(config.baseUrl || config.apiBaseUrl || config.url || 'https://api.anthropic.com');
  if (config.messagesPath) return `${baseUrl}/${String(config.messagesPath).replace(/^\/+/, '')}`;
  if (baseUrl.endsWith('/messages')) return baseUrl;
  if (baseUrl.endsWith('/v1')) return `${baseUrl}/messages`;
  return `${baseUrl}/v1/messages`;
}

function anthropicHeaders(config = {}) {
  const token = config.auth?.token || config.apiKey || '';
  const authType = String(config.auth?.type || 'api_key').toLowerCase();
  const oauthLike = authType === 'oauth' || authType === 'token' || authType === 'bearer_token';
  return {
    'content-type': 'application/json',
    accept: 'application/json',
    'anthropic-version': config.anthropicVersion || '2023-06-01',
    ...(oauthLike ? { 'anthropic-beta': config.auth?.beta || config.anthropicBeta || 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14' } : {}),
    ...(oauthLike
      ? { authorization: `Bearer ${token}`, 'x-app': config.auth?.xApp || 'cli', 'user-agent': config.auth?.userAgent || config.userAgent || `claude-cli/${CLAUDE_CODE_VERSION}` }
      : token ? { 'x-api-key': token } : {}),
    ...(config.headers || {}),
  };
}

function compactAnthropicContentParts(parts = []) {
  return parts.filter((part) => {
    if (!part || typeof part !== 'object') return false;
    if (part.type === 'text') return String(part.text || '').trim().length > 0;
    return true;
  });
}

function anthropicContentParts(content) {
  if (Array.isArray(content)) {
    return compactAnthropicContentParts(content.map((part) => {
      if (typeof part === 'string') return { type: 'text', text: part };
      if (part?.type === 'text') return { type: 'text', text: String(part.text || '') };
      if (part?.type === 'tool_use') return { type: 'tool_use', id: String(part.id || randomUUID()), name: String(part.name || ''), input: parseArguments(part.input || {}) };
      if (part?.type === 'thinking') return { type: 'thinking', thinking: String(part.thinking || ''), ...('signature' in part ? { signature: String(part.signature ?? '') } : {}) };
      if (part?.type === 'redacted_thinking') return { type: 'redacted_thinking', ...('data' in part ? { data: String(part.data ?? '') } : {}), ...('signature' in part ? { signature: String(part.signature ?? '') } : {}) };
      if (part?.type === 'image_url') {
        const url = part.image_url?.url || part.url || '';
        const m = /^data:([^;]+);base64,(.*)$/i.exec(url);
        if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
      }
      if (part?.type === 'image' && part.source) return part;
      return { type: 'text', text: boundedText(typeof part === 'string' ? part : JSON.stringify(part || {}), MAX_MODEL_TEXT_CHARS) };
    }));
  }
  return compactAnthropicContentParts([{ type: 'text', text: String(content || '') }]);
}

function anthropicMessages(messages = [], prompt = '') {
  const source = messages?.length ? messages : [{ role: 'user', content: String(prompt || '') }];
  const system = [];
  const converted = [];
  for (const message of source) {
    const role = message?.role === 'assistant' ? 'assistant' : message?.role === 'system' ? 'system' : 'user';
    if (role === 'system') { system.push(String(message.content || '')); continue; }
    if (message?.role === 'tool') {
      const resultContent = Array.isArray(message.content)
        ? message.content.map((part) => {
          if (part?.type === 'image_url') {
            const url = part.image_url?.url || part.url || '';
            const m = /^data:([^;]+);base64,(.*)$/i.exec(url);
            if (m) return { type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } };
          }
          if (part?.type === 'text') return { type: 'text', text: String(part.text || '') };
          return { type: 'text', text: typeof part === 'string' ? part : JSON.stringify(part || {}) };
        })
        : String(message.content || '');
      converted.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: String(message.tool_call_id || message.id || 'tool-call'), content: resultContent }] });
      continue;
    }
    const content = anthropicContentParts(message?.content);
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length) {
      for (const call of message.tool_calls) {
        const fn = call.function || call;
        content.push({ type: 'tool_use', id: String(call.id || call.call_id || randomUUID()), name: String(fn.name || call.name || ''), input: parseArguments(fn.arguments ?? call.arguments ?? {}) });
      }
    }
    converted.push({ role, content });
  }
  return { system: system.filter(Boolean), messages: converted };
}

function anthropicPromptCachingEnabled(config = {}) {
  return config.anthropicPromptCaching !== false && config.promptCaching !== false;
}

function anthropicCacheControl() {
  return { type: 'ephemeral' };
}

function anthropicCacheableSystem(system = '') {
  const blocks = (Array.isArray(system) ? system : [system])
    .map((text) => String(text || '').trim())
    .filter(Boolean)
    .map((text) => ({ type: 'text', text }));
  if (!blocks.length) return undefined;
  blocks[blocks.length - 1].cache_control = anthropicCacheControl();
  return blocks;
}

function anthropicTool(tool = {}) {
  const fn = tool.function || tool;
  return { name: fn.name || tool.name, description: fn.description || tool.description || '', input_schema: fn.parameters || tool.input_schema || tool.inputSchema || { type: 'object', properties: {} } };
}

function anthropicCacheableTools(tools = []) {
  if (!Array.isArray(tools) || !tools.length) return tools;
  return tools.map((tool, index) => index === tools.length - 1 ? { ...tool, cache_control: anthropicCacheControl() } : tool);
}

function anthropicCachedTokens(usage = {}) {
  const value = Number(usage?.cache_read_input_tokens ?? usage?.prompt_tokens_details?.cached_tokens ?? usage?.input_tokens_details?.cached_tokens);
  return Number.isFinite(value) ? value : null;
}

const ANTHROPIC_THINKING_BUDGETS = Object.freeze({ minimal: 1024, low: 4000, medium: 8000, high: 16000, xhigh: 32000, ultra: 32000 });
const ANTHROPIC_ADAPTIVE_EFFORTS = Object.freeze({ minimal: 'low', low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', ultra: 'max' });

function normalizeAnthropicModelId(model = '') {
  return String(model || '').trim().toLowerCase().replace(/^anthropic\//, '').replace(/[._\s]+/g, '-');
}

function supportsAnthropicThinking(model = '') {
  const normalized = normalizeAnthropicModelId(model);
  if (!normalized || normalized.includes('haiku')) return false;
  return /(^|-)claude-/.test(normalized);
}

function supportsAdaptiveAnthropicThinking(model = '') {
  const normalized = normalizeAnthropicModelId(model);
  return /(^|-)claude-(?:fable-5|mythos-(?:5|preview)|opus-4-(?:6|7|8)|sonnet-(?:5|4-6))($|[^a-z0-9])/.test(normalized);
}

function supportsAnthropicXhighEffort(model = '') {
  const normalized = normalizeAnthropicModelId(model);
  return /(^|-)claude-(?:fable-5|mythos-5|opus-4-(?:7|8)|sonnet-5)($|[^a-z0-9])/.test(normalized);
}

function anthropicReasoningEffort(config = {}) {
  const effort = String(config.reasoningEffort ?? config.extra?.reasoning?.effort ?? '').trim().toLowerCase();
  return ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'ultra'].includes(effort) ? effort : null;
}

function anthropicExtraWithoutGenericReasoning(extra = {}, model = '') {
  if (!extra || typeof extra !== 'object') return undefined;
  const { reasoning: _reasoning, ...rest } = extra;
  // Opus 4.7+ rejects these knobs; do not let arbitrary connection extras
  // reintroduce provider-deprecated sampling parameters for newer models.
  if (!anthropicSupportsSamplingParameters(model)) {
    delete rest.top_p;
    delete rest.top_k;
  }
  return Object.keys(rest).length ? rest : undefined;
}

function anthropicThinkingConfig({ model, config = {}, maxTokens = DEFAULT_MODEL_OUTPUT_TOKENS } = {}) {
  const effort = anthropicReasoningEffort(config);
  if (effort === 'off' && supportsAnthropicThinking(model)) {
    const extra = { ...anthropicExtraWithoutGenericReasoning(config.extra, model) };
    // Explicit off must override inherited native thinking and effort, while
    // preserving unrelated output configuration (for example JSON schemas).
    delete extra.thinking;
    if (extra.output_config && typeof extra.output_config === 'object') {
      extra.output_config = { ...extra.output_config };
      delete extra.output_config.effort;
      if (!Object.keys(extra.output_config).length) delete extra.output_config;
    }
    return { enabled: false, thinking: { type: 'disabled' }, maxTokens, extra };
  }
  if (!effort || !supportsAnthropicThinking(model)) return { enabled: false, maxTokens, extra: anthropicExtraWithoutGenericReasoning(config.extra, model) };
  if (supportsAdaptiveAnthropicThinking(model)) {
    const mappedEffort = ANTHROPIC_ADAPTIVE_EFFORTS[effort] || 'medium';
    const finalEffort = mappedEffort === 'xhigh' && !supportsAnthropicXhighEffort(model) ? 'max' : mappedEffort;
    return {
      enabled: true,
      mode: 'adaptive',
      effort: finalEffort,
      thinking: { type: 'adaptive', display: config.anthropicThinkingDisplay || 'summarized' },
      outputConfig: { effort: finalEffort },
      maxTokens,
      extra: anthropicExtraWithoutGenericReasoning(config.extra, model),
    };
  }
  const totalMaxTokens = Number(maxTokens) || DEFAULT_MODEL_OUTPUT_TOKENS;
  if (totalMaxTokens <= ANTHROPIC_THINKING_BUDGETS.minimal) {
    throw new Error(`Anthropic manual thinking requires max_tokens greater than ${ANTHROPIC_THINKING_BUDGETS.minimal}; received ${totalMaxTokens}`);
  }
  const requestedBudgetTokens = ANTHROPIC_THINKING_BUDGETS[effort] || ANTHROPIC_THINKING_BUDGETS.medium;
  // Anthropic manual thinking budgets are part of the total max_tokens allowance,
  // and the protocol requires budget_tokens to be strictly less than max_tokens.
  // Preserve the caller/provider total and clamp only the mapped effort budget.
  const budgetTokens = Math.min(requestedBudgetTokens, totalMaxTokens - 1);
  return {
    enabled: true,
    mode: 'manual',
    effort,
    budgetTokens,
    thinking: { type: 'enabled', budget_tokens: budgetTokens },
    maxTokens: totalMaxTokens,
    extra: anthropicExtraWithoutGenericReasoning(config.extra, model),
  };
}

function safeAnthropicAssistantBlocks(content = []) {
  if (!Array.isArray(content)) return [];
  return content.map((part) => {
    if (!part || typeof part !== 'object') return null;
    if (part.type === 'text') return { type: 'text', text: boundedText(part.text || '', MAX_MODEL_TEXT_CHARS) };
    if (part.type === 'tool_use') return { type: 'tool_use', id: boundedText(part.id || '', 256), name: boundedText(part.name || '', 256), input: parseArguments(part.input || {}) };
    // Anthropic signs the complete opaque thinking block. These fields are
    // protocol material, not display text: changing even one byte makes a
    // valid tool-use continuation unverifiable.
    if (part.type === 'thinking') return { type: 'thinking', thinking: String(part.thinking ?? ''), ...('signature' in part ? { signature: String(part.signature ?? '') } : {}) };
    if (part.type === 'redacted_thinking') return { type: 'redacted_thinking', ...('data' in part ? { data: String(part.data ?? '') } : {}), ...('signature' in part ? { signature: String(part.signature ?? '') } : {}) };
    return null;
  }).filter(Boolean);
}

function anthropicMessageManifest(messages = []) {
  return (Array.isArray(messages) ? messages : []).map((message, index) => {
    const blocks = Array.isArray(message?.content) ? message.content : [];
    return {
      index,
      role: String(message?.role || 'unknown'),
      blockTypes: blocks.map((block) => String(block?.type || 'unknown')),
      blocks: blocks.map((block, blockIndex) => {
        const value = block?.type === 'thinking' ? block.thinking
          : block?.type === 'redacted_thinking' ? block.data
            : block?.type === 'tool_use' ? JSON.stringify(block.input ?? {})
              : block?.type === 'tool_result' ? JSON.stringify(block.content ?? '')
                : block?.text ?? '';
        return { index: blockIndex, type: String(block?.type || 'unknown'), chars: String(value ?? '').length, contentHash: serializedMessageHash(value ?? '') };
      }),
      contentHash: serializedMessageHash(message?.content ?? ''),
    };
  });
}

function toolCallIds(toolCalls = []) {
  return (toolCalls || []).map((call, index) => String(call?.id || `tool-call-${index}`));
}

function assistantToolUseIds(message = {}) {
  if (message?.role !== 'assistant') return [];
  if (Array.isArray(message.content)) return message.content.filter((part) => part?.type === 'tool_use').map((part) => String(part.id || ''));
  return (message.tool_calls || []).map((call) => String(call?.id || call?.call_id || ''));
}

function sameProtocolCallIdentity(message, toolCalls = []) {
  const expected = toolCallIds(toolCalls);
  const actual = assistantToolUseIds(message);
  return expected.length > 0 && actual.length === expected.length && actual.every((id, index) => id === expected[index]);
}

function anthropicContinuationBlocksForToolCalls(previousModel = null, toolCalls = [], baseMessages = []) {
  const persisted = [...(Array.isArray(baseMessages) ? baseMessages : [])].reverse()
    .find((message) => sameProtocolCallIdentity(message, toolCalls) && Array.isArray(message.content))?.content;
  const blocks = previousModel?.anthropicContinuation?.assistantBlocks || persisted;
  if (!Array.isArray(blocks) || !blocks.length) return null;
  return sameProtocolCallIdentity({ role: 'assistant', content: blocks }, toolCalls) ? blocks : null;
}

function preparedAnthropicContinuation(preparedMessages = [], toolCalls = [], preservedBlocks = null) {
  const transcript = normalizeProviderMessages(preparedMessages);
  const matching = transcript.map((message, index) => sameProtocolCallIdentity(message, toolCalls) ? index : -1).filter((index) => index >= 0);
  if (!matching.length) return transcript;
  const opaque = matching.find((index) => Array.isArray(transcript[index]?.content)
    && transcript[index].content.some((part) => part?.type === 'thinking' || part?.type === 'redacted_thinking'));
  const keep = opaque ?? matching[0];
  const result = transcript.filter((_message, index) => !matching.includes(index) || index === keep);
  const kept = result.find((message) => sameProtocolCallIdentity(message, toolCalls));
  if (preservedBlocks && kept && !Array.isArray(kept.content)) {
    const index = result.indexOf(kept);
    result[index] = { role: 'assistant', content: preservedBlocks };
  }
  const expectedIds = toolCallIds(toolCalls);
  const resultIds = result.filter((message) => message?.role === 'tool').map((message) => String(message.tool_call_id || ''));
  const paired = result.some((message) => sameProtocolCallIdentity(message, toolCalls))
    && expectedIds.every((id) => resultIds.filter((resultId) => resultId === id).length === 1);
  if (!paired) throw new Error('native_continuation_preparation_invalid');
  return result;
}

function anthropicErrorLooksLikeSignedThinking(result = {}) {
  if (Number(result?.status) !== 400) return false;
  const type = String(result?.raw?.error?.details?.type || '');
  const message = String(result?.error || '');
  return (!type || type === 'invalid_request_error')
    && /(?:invalid|mismatch|verification|verify|corrupt(?:ed)?)\s+(?:thinking\s+)?signature|thinking\s+signature\s+(?:is\s+)?(?:invalid|mismatch|corrupt(?:ed)?)/i.test(message);
}

function anthropicAssistantMessageFromChoice(choice = {}) {
  const toolCalls = (choice.toolCalls || []).map((call, index) => ({
    id: call.id || `tool-call-${index}`,
    type: 'function',
    function: { name: call.name || '', arguments: call.rawArguments || JSON.stringify(call.arguments || {}) },
  }));
  return normalizeProviderMessage({ role: 'assistant', content: choice.text || '', ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
}

function normalizeAnthropicChoice(data = {}) {
  const content = Array.isArray(data.content) ? data.content : [];
  const text = boundedText(content.filter((part) => part?.type === 'text').map((part) => part.text || '').join(''), MAX_MODEL_TEXT_CHARS);
  const toolCalls = content.filter((part) => part?.type === 'tool_use').map((part, index) => normalizeToolCall({ id: part.id || `tool-call-${index}`, name: part.name, arguments: part.input || {} }, index));
  const assistantBlocks = safeAnthropicAssistantBlocks(content);
  return { index: 0, finishReason: data.stop_reason || null, message: { role: 'assistant', content: text }, text, toolCalls, anthropic: assistantBlocks.length ? { assistantBlocks } : null };
}

function mergeAnthropicStreamEvent(state, event) {
  const type = event?.type;
  if (type === 'error') {
    state.error = event.error || { message: event.message || 'model_stream_failed' };
    state.errorEventType = type;
  } else if (type === 'message_start') state.message = event.message || state.message || {};
  else if (type === 'content_block_start') state.blocks[event.index || 0] = event.content_block || {};
  else if (type === 'content_block_delta') {
    const block = state.blocks[event.index || 0] || (state.blocks[event.index || 0] = {});
    if (event.delta?.type === 'text_delta') block.text = `${block.text || ''}${event.delta.text || ''}`;
    if (event.delta?.type === 'thinking_delta') block.thinking = `${block.thinking || ''}${event.delta.thinking || ''}`;
    if (event.delta?.type === 'signature_delta') block.signature = `${block.signature || ''}${event.delta.signature || ''}`;
    if (event.delta?.type === 'input_json_delta') block.partial_json = `${block.partial_json || ''}${event.delta.partial_json || ''}`;
  } else if (type === 'content_block_stop') {
    const block = state.blocks[event.index || 0];
    if (block?.type === 'tool_use' && block.partial_json) block.input = parseArguments(block.partial_json);
  } else if (type === 'message_delta') {
    state.message = { ...(state.message || {}), stop_reason: event.delta?.stop_reason || state.message?.stop_reason, usage: event.usage || state.message?.usage };
  }
}

async function readAnthropicSse(response, { maxBytes = DEFAULT_MAX_RESPONSE_BYTES, onTextDelta = null, onThoughtDelta = null } = {}) {
  const textResult = await readResponseTextBounded(response, maxBytes);
  if (!textResult.ok) return { ...textResult, data: null };
  const state = { message: {}, blocks: [] };
  let currentEvent = null;
  for (const rawLine of textResult.text.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (line.startsWith('event:')) currentEvent = line.slice(6).trim();
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let event;
    try { event = JSON.parse(payload); }
    catch (error) {
      return { ok: false, text: textResult.text, bytes: textResult.bytes, data: null, error: 'model_stream_malformed_event', errorDetails: { eventType: boundedText(currentEvent || 'unknown', 64), message: boundedText(error?.message || 'invalid JSON event payload', 500) }, event: currentEvent };
    }
    if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') await onTextDelta?.(event.delta.text || '');
    if (event?.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') await onThoughtDelta?.(event.delta.thinking || '');
    mergeAnthropicStreamEvent(state, event);
  }
  if (state.error) {
    const details = {
      eventType: boundedText(state.errorEventType || currentEvent || 'error', 64),
      ...(state.error.type ? { type: boundedText(state.error.type, 128) } : {}),
      ...(state.error.code ? { code: boundedText(state.error.code, 128) } : {}),
      ...(state.error.message ? { message: boundedText(state.error.message, 500) } : {}),
    };
    return { ok: false, text: textResult.text, bytes: textResult.bytes, data: null, error: boundedText(state.error.message || 'model_stream_failed', 500), errorDetails: details, event: currentEvent };
  }
  const data = { ...(state.message || {}), content: state.blocks.filter(Boolean) };
  const stopReason = String(data.stop_reason || '');
  const hasContent = Array.isArray(data.content) && data.content.length > 0;
  if (stopReason === 'max_tokens' && !hasContent) return { ok: false, text: textResult.text, bytes: textResult.bytes, data, error: 'model_stream_max_tokens_empty', event: currentEvent };
  if (textResult.text && currentEvent !== 'message_stop') return { ok: false, text: textResult.text, bytes: textResult.bytes, data, error: 'model_stream_truncated', event: currentEvent };
  return { ok: true, text: textResult.text, bytes: textResult.bytes, data, event: currentEvent };
}

export function createAnthropicMessagesModelAdapter({ config = {}, fetchImpl = globalThis.fetch, clock = () => new Date().toISOString(), idFactory = randomUUID } = {}) {
  if (!fetchImpl) throw new Error('fetch implementation is required');
  const url = anthropicUrl(config);
  const model = config.model;
  if (!model) throw new Error('model is required');

  const imageCountFor = (messages = []) => (Array.isArray(messages) ? messages : []).reduce((count, message) => count + (Array.isArray(message?.content) ? message.content.filter((part) => part?.type === 'image_url' || part?.type === 'input_image' || part?.image_url || part?.input_image).length : 0), 0);
  const textPromptCharsFor = (messages = []) => (Array.isArray(messages) ? messages : []).reduce((total, message) => total + (typeof message?.content === 'string' ? message.content.length : (Array.isArray(message?.content) ? message.content.reduce((chars, part) => chars + String(part?.text || '').length, 0) : 0)), 0);

  const buildRequest = ({ prompt, messages, temperature = config.temperature ?? 0.2, maxTokens = config.maxTokens ?? config.outputTokens ?? DEFAULT_MODEL_OUTPUT_TOKENS, tools = null, streaming = false } = {}) => {
    const sourceTranscript = normalizeProviderMessages(messages?.length ? messages : [{ role: 'user', content: String(prompt || '') }]);
    const converted = anthropicMessages(sourceTranscript);
    if (!converted.messages.length || !converted.messages.some((message) => Array.isArray(message.content) && message.content.length)) throw new Error('prompt or messages are required');
    const resolvedTools = Array.isArray(tools) && tools.length ? tools.map(anthropicTool) : null;
    const oauthLike = ['oauth', 'token', 'bearer_token'].includes(String(config.auth?.type || '').toLowerCase());
    const system = [oauthLike ? CLAUDE_CODE_BILLING_SYSTEM_BLOCK : null, ...converted.system].filter(Boolean);
    const promptCaching = anthropicPromptCachingEnabled(config);
    const thinking = anthropicThinkingConfig({ model, config, maxTokens });
    const body = {
      model,
      messages: converted.messages,
      ...(system.length ? { system: promptCaching ? anthropicCacheableSystem(system) : system.join('\n\n') } : {}),
      ...(thinking.enabled || config.supportsTemperature === false || !anthropicSupportsSamplingParameters(model) ? {} : { temperature }),
      max_tokens: thinking.maxTokens,
      ...(resolvedTools ? { tools: promptCaching ? anthropicCacheableTools(resolvedTools) : resolvedTools } : {}),
      ...(thinking.extra || {}),
      ...(thinking.thinking ? { thinking: thinking.thinking } : {}),
      ...(thinking.outputConfig ? { output_config: thinking.outputConfig } : {}),
      ...(streaming ? { stream: true } : {}),
    };
    const serializedBody = JSON.stringify(body);
    return { body, serializedBody, promptChars: textPromptCharsFor(sourceTranscript), imageCount: imageCountFor(sourceTranscript), sourceTranscript, resolvedTools, promptCaching, thinking, providerMessageManifest: anthropicMessageManifest(body.messages) };
  };

  const estimateRequest = (options = {}) => {
    const request = buildRequest(options);
    return contextUsageFromRequest({ promptChars: request.promptChars, bodyChars: request.serializedBody.length, imageCount: request.imageCount, model, api: 'anthropic-messages', modelCall: options.modelCall, clock });
  };

  const complete = async ({ prompt, messages, temperature = config.temperature ?? 0.2, maxTokens = config.maxTokens ?? config.outputTokens ?? DEFAULT_MODEL_OUTPUT_TOKENS, tools = null, traceLogger, signal = null, onTextDelta = null, onThoughtDelta = null, onContextUsage = null, modelCall = null } = {}) => {
    const requestId = idFactory();
    const streaming = typeof onTextDelta === 'function' || typeof onThoughtDelta === 'function';
    const { body, serializedBody, promptChars, imageCount, sourceTranscript, resolvedTools, promptCaching, thinking, providerMessageManifest } = buildRequest({ prompt, messages, temperature, maxTokens, tools, streaming });
    const headers = anthropicHeaders(config);
    // Keep trace inspection useful without retaining raw operator secrets.
    const diagnosticBody = { ...body, messages: body.messages.map((message) => ({
      ...message,
      content: message.content.map((block) => block?.type === 'thinking'
        ? { ...block, thinking: '[redacted]', ...('signature' in block ? { signature: '[redacted]' } : {}) }
        : block?.type === 'redacted_thinking'
          ? { ...block, ...('data' in block ? { data: '[redacted]' } : {}), ...('signature' in block ? { signature: '[redacted]' } : {}) }
          : block),
    })) };
    const providerRequestArtifact = await traceLogger?.artifact?.(`provider-request-${requestId}.json`, redactText(JSON.stringify(diagnosticBody))) || null;
    const requestContextUsage = contextUsageFromRequest({ promptChars, bodyChars: serializedBody.length, imageCount, model, api: 'anthropic-messages', modelCall, clock });
    await onContextUsage?.(requestContextUsage);
    const stablePrefixHash = serializedMessageHash({ system: body.system || null, tools: body.tools || [] });
    await traceLogger?.model?.({ stage: 'model-request', requestId, provider: 'anthropic', api: 'anthropic-messages', model, url, headers: redactHeaders(headers), messageCount: body.messages.length, promptChars, bodyChars: serializedBody.length, continuation: false, toolCount: resolvedTools?.length || 0, toolNames: resolvedTools?.map((tool) => tool.name).filter(Boolean) || [], providerMessageManifest, stablePrefixHash, promptCaching, thinking: thinking.enabled ? { mode: thinking.mode, effort: thinking.effort || null, budgetTokens: thinking.budgetTokens || null } : null, providerRequestArtifact, ts: clock() });
    const response = await fetchImpl(url, { method: 'POST', headers, body: serializedBody, ...(signal ? { signal } : {}) });
    const responseBody = streaming ? await readAnthropicSse(response, { maxBytes: config.maxResponseBytes, onTextDelta, onThoughtDelta }) : await readResponseTextBounded(response, config.maxResponseBytes);
    let data = streaming ? responseBody.data : null;
    if (!streaming) {
      try { data = responseBody.ok ? (responseBody.text ? JSON.parse(responseBody.text) : {}) : { error: { message: responseBody.error } }; }
      catch { data = { raw: responseBody.text }; }
    }
    const ok = Boolean(response.ok) && responseBody.ok;
    const candidateChoice = ok ? normalizeAnthropicChoice(data) : null;
    const maxTokensIncomplete = ok && candidateChoice?.finishReason === 'max_tokens';
    const success = ok && !maxTokensIncomplete;
    // An incomplete generation is still a failed call, but its bounded partial
    // text and protocol blocks remain available for diagnostics and recovery.
    const choice = candidateChoice;
    const assistantMessage = choice && !(choice.toolCalls || []).length ? anthropicAssistantMessageFromChoice(choice) : null;
    // Persist the exact provider assistant block sequence, including opaque
    // signed thinking, so continuation replay does not depend on an in-memory
    // side channel. continueWithToolResults recognizes this pending assistant
    // turn and appends only its matching tool results.
    const assistantBlocks = choice?.anthropic?.assistantBlocks;
    const pendingAssistantMessage = choice && (choice.toolCalls || []).length && assistantBlocks?.length
      ? { role: 'assistant', content: assistantBlocks }
      : null;
    const nativeTranscript = normalizeProviderMessages([...sourceTranscript, ...(pendingAssistantMessage ? [pendingAssistantMessage] : assistantMessage ? [assistantMessage] : [])]);
    const failureMessage = maxTokensIncomplete ? (candidateChoice?.text || (candidateChoice?.toolCalls || []).length ? 'model_max_tokens_incomplete' : 'model_max_tokens_empty') : (responseBody.error || data?.error?.message || data?.message || responseBody.text?.slice?.(0, 500) || `HTTP ${response.status}`);
    const failureDetails = responseBody.errorDetails || ((data?.error || data?.type) ? { ...(data?.error?.type ? { type: boundedText(data.error.type, 128) } : data?.type ? { type: boundedText(data.type, 128) } : {}), ...(data?.error?.code ? { code: boundedText(data.error.code, 128) } : {}), status: response.status } : null);
    const result = { ok: success, requestId, provider: 'anthropic', api: 'anthropic-messages', model, status: response.status, choice, responseId: success && typeof data?.id === 'string' ? boundedText(data.id, 256) : null, usage: data?.usage || null, contextUsage: contextUsageFromResponse(requestContextUsage, data?.usage || null, clock), error: success ? null : failureMessage, raw: success ? { responseBytes: responseBody.bytes, ...(streaming ? { streamedTextChars: choice?.text?.length || 0 } : {}) } : { error: { message: failureMessage, ...(failureDetails ? { details: failureDetails } : {}) } }, nativeTranscript, ...(choice?.anthropic?.assistantBlocks?.length ? { anthropicContinuation: { assistantBlocks: choice.anthropic.assistantBlocks } } : {}) };
    await onContextUsage?.(result.contextUsage);
    await traceLogger?.model?.({ stage: 'model-response', requestId, provider: 'anthropic', api: 'anthropic-messages', model, status: response.status, ok: success, usage: result.usage, cachedTokens: anthropicCachedTokens(result.usage), stablePrefixHash, finishReason: result.choice?.finishReason || candidateChoice?.finishReason || null, responseChars: result.choice?.text?.length || 0, responseBytes: responseBody.bytes, streamed: streaming, error: result.error, ...(responseBody.errorDetails ? { errorDetails: responseBody.errorDetails } : {}), ts: clock() });
    return result;
  };

  return { provider: 'anthropic', api: 'anthropic-messages', model, url, supportsVision: true, estimateRequest, complete, async continueWithToolResults({ previousModel = null, baseMessages = [], toolCalls = [], toolResults = [], preparedMessages = null, ...options } = {}) {
    const preservedBlocks = anthropicContinuationBlocksForToolCalls(previousModel, toolCalls, baseMessages);
    const hasPreparedMessages = Array.isArray(preparedMessages) && preparedMessages.length > 0;
    const transcript = hasPreparedMessages
      ? preparedAnthropicContinuation(preparedMessages, toolCalls, preservedBlocks)
      : [...baseMessages];
    const persistedPendingAssistant = transcript.some((message) => sameProtocolCallIdentity(message, toolCalls));
    if (toolCalls.length && !persistedPendingAssistant) {
      transcript.push(preservedBlocks
        ? { role: 'assistant', content: preservedBlocks }
        : { role: 'assistant', content: '', tool_calls: toolCalls.map((call, index) => ({ id: call.id || `tool-call-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) } })) });
    }
    if (!hasPreparedMessages) for (let index = 0; index < toolResults.length; index += 1) {
      transcript.push({ role: 'tool', tool_call_id: toolCalls[index]?.id || `tool-call-${index}`, content: toolOutputText(toolResults[index]) });
      const imageMessage = attachmentViewUserMessage(toolResults[index], toolCalls[index], index);
      if (imageMessage) transcript.push(imageMessage);
    }
    const result = await complete({ ...options, messages: transcript });
    if (result.ok || !preservedBlocks || !anthropicErrorLooksLikeSignedThinking(result)) return result;
    await options.traceLogger?.model?.({ stage: 'model-request-repair', requestId: result.requestId, provider: 'anthropic', api: 'anthropic-messages', model, reason: 'signed_thinking_rejected', error: result.error, ts: clock() });
    const repairedTranscript = transcript.map((message) => {
      if (!sameProtocolCallIdentity(message, toolCalls) || !Array.isArray(message.content)) return message;
      return { ...message, content: message.content.filter((part) => part?.type !== 'thinking' && part?.type !== 'redacted_thinking') };
    });
    const repaired = await complete({ ...options, messages: repairedTranscript });
    if (repaired && typeof repaired === 'object') repaired.repairedContinuation = { reason: 'signed_thinking_rejected', originalRequestId: result.requestId };
    return repaired;
  } };
}

export const __test__ = { anthropicUrl, normalizeAnthropicChoice, anthropicCachedTokens, anthropicThinkingConfig, supportsAnthropicThinking, supportsAdaptiveAnthropicThinking };

