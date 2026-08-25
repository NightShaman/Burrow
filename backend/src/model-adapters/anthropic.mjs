import { redactText } from '../redaction.mjs';
import { anthropicSupportsSamplingParameters } from '../anthropic-model-capabilities.mjs';
import {
  CLAUDE_CODE_VERSION,
  CLAUDE_CODE_BILLING_SYSTEM_BLOCK,
  DEFAULT_MAX_RESPONSE_BYTES,
  MAX_MODEL_TEXT_CHARS,
  MAX_STREAM_TOOL_CALLS,
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
      if (part?.type === 'thinking') return { type: 'thinking', thinking: String(part.thinking || ''), ...(part.signature ? { signature: String(part.signature) } : {}) };
      if (part?.type === 'redacted_thinking') return { type: 'redacted_thinking', ...(part.data ? { data: String(part.data) } : {}), ...(part.signature ? { signature: String(part.signature) } : {}) };
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
      converted.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: String(message.tool_call_id || message.id || 'tool-call'), content: String(message.content || '') }] });
      continue;
    }
    const content = anthropicContentParts(message?.content);
    if (Array.isArray(message?.tool_calls) && message.tool_calls.length) {
      for (const call of message.tool_calls.slice(0, MAX_STREAM_TOOL_CALLS)) {
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
  const effort = String(config.extra?.reasoning?.effort || '').trim().toLowerCase();
  return ['minimal', 'low', 'medium', 'high', 'xhigh', 'ultra'].includes(effort) ? effort : null;
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

function anthropicThinkingConfig({ model, config = {}, maxTokens = 4096 } = {}) {
  const effort = anthropicReasoningEffort(config);
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
  const budgetTokens = ANTHROPIC_THINKING_BUDGETS[effort] || ANTHROPIC_THINKING_BUDGETS.medium;
  return {
    enabled: true,
    mode: 'manual',
    effort,
    budgetTokens,
    thinking: { type: 'enabled', budget_tokens: budgetTokens },
    maxTokens: Math.max(Number(maxTokens) || 4096, budgetTokens + 4096),
    extra: anthropicExtraWithoutGenericReasoning(config.extra, model),
  };
}

function safeAnthropicAssistantBlocks(content = []) {
  if (!Array.isArray(content)) return [];
  return content.slice(0, 64).map((part) => {
    if (!part || typeof part !== 'object') return null;
    if (part.type === 'text') return { type: 'text', text: boundedText(part.text || '', MAX_MODEL_TEXT_CHARS) };
    if (part.type === 'tool_use') return { type: 'tool_use', id: boundedText(part.id || '', 256), name: boundedText(part.name || '', 256), input: parseArguments(part.input || {}) };
    if (part.type === 'thinking') return { type: 'thinking', thinking: boundedText(part.thinking || '', MAX_MODEL_TEXT_CHARS), ...(part.signature ? { signature: boundedText(part.signature, 8192) } : {}) };
    if (part.type === 'redacted_thinking') return { type: 'redacted_thinking', ...(part.data ? { data: boundedText(part.data, MAX_MODEL_TEXT_CHARS) } : {}), ...(part.signature ? { signature: boundedText(part.signature, 8192) } : {}) };
    return null;
  }).filter(Boolean);
}

function anthropicContinuationBlocksForToolCalls(previousModel = null, toolCalls = []) {
  const blocks = previousModel?.anthropicContinuation?.assistantBlocks;
  if (!Array.isArray(blocks) || !blocks.length) return null;
  const expectedIds = new Set((toolCalls || []).map((call, index) => String(call?.id || `tool-call-${index}`)));
  const blockIds = blocks.filter((part) => part?.type === 'tool_use').map((part) => String(part.id || ''));
  if (!expectedIds.size || blockIds.length !== expectedIds.size || !blockIds.every((id) => expectedIds.has(id))) return null;
  return blocks;
}

function anthropicErrorLooksLikeSignedThinking(error = '') {
  return /thinking|signature|redacted/i.test(String(error || ''));
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
  const toolCalls = content.filter((part) => part?.type === 'tool_use').slice(0, MAX_STREAM_TOOL_CALLS).map((part, index) => normalizeToolCall({ id: part.id || `tool-call-${index}`, name: part.name, arguments: part.input || {} }, index));
  const assistantBlocks = safeAnthropicAssistantBlocks(content);
  return { index: 0, finishReason: data.stop_reason || null, message: { role: 'assistant', content: text }, text, toolCalls, anthropic: assistantBlocks.length ? { assistantBlocks } : null };
}

function mergeAnthropicStreamEvent(state, event) {
  const type = event?.type;
  if (type === 'message_start') state.message = event.message || state.message || {};
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
    try {
      const event = JSON.parse(payload);
      if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') await onTextDelta?.(event.delta.text || '');
      if (event?.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') await onThoughtDelta?.(event.delta.thinking || '');
      mergeAnthropicStreamEvent(state, event);
    } catch {}
  }
  return { ok: true, text: textResult.text, bytes: textResult.bytes, data: { ...(state.message || {}), content: state.blocks.filter(Boolean) }, event: currentEvent };
}

export function createAnthropicMessagesModelAdapter({ config = {}, fetchImpl = globalThis.fetch, clock = () => new Date().toISOString(), idFactory = randomUUID } = {}) {
  if (!fetchImpl) throw new Error('fetch implementation is required');
  const url = anthropicUrl(config);
  const model = config.model;
  if (!model) throw new Error('model is required');

  const imageCountFor = (messages = []) => (Array.isArray(messages) ? messages : []).reduce((count, message) => count + (Array.isArray(message?.content) ? message.content.filter((part) => part?.type === 'image_url' || part?.type === 'input_image' || part?.image_url || part?.input_image).length : 0), 0);
  const textPromptCharsFor = (messages = []) => (Array.isArray(messages) ? messages : []).reduce((total, message) => total + (typeof message?.content === 'string' ? message.content.length : (Array.isArray(message?.content) ? message.content.reduce((chars, part) => chars + String(part?.text || '').length, 0) : 0)), 0);

  const buildRequest = ({ prompt, messages, temperature = config.temperature ?? 0.2, maxTokens = config.maxTokens || 4096, tools = null, streaming = false } = {}) => {
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
      ...(thinking.enabled ? { thinking: thinking.thinking } : {}),
      ...(thinking.outputConfig ? { output_config: thinking.outputConfig } : {}),
      ...(streaming ? { stream: true } : {}),
    };
    const serializedBody = JSON.stringify(body);
    return { body, serializedBody, promptChars: textPromptCharsFor(sourceTranscript), imageCount: imageCountFor(sourceTranscript), sourceTranscript, resolvedTools, promptCaching, thinking };
  };

  const estimateRequest = (options = {}) => {
    const request = buildRequest(options);
    return contextUsageFromRequest({ promptChars: request.promptChars, bodyChars: request.serializedBody.length, imageCount: request.imageCount, model, api: 'anthropic-messages', modelCall: options.modelCall, clock });
  };

  const complete = async ({ prompt, messages, temperature = config.temperature ?? 0.2, maxTokens = config.maxTokens || 4096, tools = null, traceLogger, signal = null, onTextDelta = null, onThoughtDelta = null, onContextUsage = null, modelCall = null } = {}) => {
    const requestId = idFactory();
    const streaming = typeof onTextDelta === 'function' || typeof onThoughtDelta === 'function';
    const { body, serializedBody, promptChars, imageCount, sourceTranscript, resolvedTools, promptCaching, thinking } = buildRequest({ prompt, messages, temperature, maxTokens, tools, streaming });
    const headers = anthropicHeaders(config);
    // Keep trace inspection useful without retaining raw operator secrets.
    const providerRequestArtifact = await traceLogger?.artifact?.(`provider-request-${requestId}.json`, redactText(serializedBody)) || null;
    const requestContextUsage = contextUsageFromRequest({ promptChars, bodyChars: serializedBody.length, imageCount, model, api: 'anthropic-messages', modelCall, clock });
    await onContextUsage?.(requestContextUsage);
    const stablePrefixHash = serializedMessageHash({ system: body.system || null, tools: body.tools || [] });
    await traceLogger?.model?.({ stage: 'model-request', requestId, provider: 'anthropic', api: 'anthropic-messages', model, url, headers: redactHeaders(headers), messageCount: body.messages.length, promptChars, bodyChars: serializedBody.length, continuation: false, toolCount: resolvedTools?.length || 0, toolNames: resolvedTools?.map((tool) => tool.name).filter(Boolean) || [], stablePrefixHash, promptCaching, thinking: thinking.enabled ? { mode: thinking.mode, effort: thinking.effort || null, budgetTokens: thinking.budgetTokens || null } : null, providerRequestArtifact, ts: clock() });
    const response = await fetchImpl(url, { method: 'POST', headers, body: serializedBody, ...(signal ? { signal } : {}) });
    const responseBody = streaming ? await readAnthropicSse(response, { maxBytes: config.maxResponseBytes, onTextDelta, onThoughtDelta }) : await readResponseTextBounded(response, config.maxResponseBytes);
    let data = streaming ? responseBody.data : null;
    if (!streaming) {
      try { data = responseBody.ok ? (responseBody.text ? JSON.parse(responseBody.text) : {}) : { error: { message: responseBody.error } }; }
      catch { data = { raw: responseBody.text }; }
    }
    const ok = Boolean(response.ok) && responseBody.ok;
    const choice = ok ? normalizeAnthropicChoice(data) : null;
    const assistantMessage = choice && !(choice.toolCalls || []).length ? anthropicAssistantMessageFromChoice(choice) : null;
    // If the model returned tool_use blocks, keep them out of nativeTranscript:
    // runtime passes the pending toolCalls separately to continueWithToolResults,
    // which appends the assistant/tool pair atomically. Including pending calls
    // here duplicates Anthropic tool_use ids on the next continuation.
    const nativeTranscript = assistantMessage ? normalizeProviderMessages([...sourceTranscript, assistantMessage]) : sourceTranscript;
    const result = { ok, requestId, provider: 'anthropic', api: 'anthropic-messages', model, status: response.status, choice, responseId: ok && typeof data?.id === 'string' ? boundedText(data.id, 256) : null, usage: data?.usage || null, contextUsage: contextUsageFromResponse(requestContextUsage, data?.usage || null, clock), error: ok ? null : (responseBody.error || data?.error?.message || data?.message || responseBody.text?.slice?.(0, 500) || `HTTP ${response.status}`), raw: ok ? { responseBytes: responseBody.bytes, ...(streaming ? { streamedTextChars: choice?.text?.length || 0 } : {}) } : { error: { message: responseBody.error || data?.error?.message || data?.message || `HTTP ${response.status}` } }, nativeTranscript, ...(choice?.anthropic?.assistantBlocks?.length ? { anthropicContinuation: { assistantBlocks: choice.anthropic.assistantBlocks } } : {}) };
    await onContextUsage?.(result.contextUsage);
    await traceLogger?.model?.({ stage: 'model-response', requestId, provider: 'anthropic', api: 'anthropic-messages', model, status: response.status, ok, usage: result.usage, cachedTokens: anthropicCachedTokens(result.usage), stablePrefixHash, finishReason: result.choice?.finishReason || null, responseChars: result.choice?.text?.length || 0, responseBytes: responseBody.bytes, streamed: streaming, error: result.error, ts: clock() });
    return result;
  };

  return { provider: 'anthropic', api: 'anthropic-messages', model, url, supportsVision: true, estimateRequest, complete, async continueWithToolResults({ previousModel = null, baseMessages = [], toolCalls = [], toolResults = [], ...options } = {}) {
    const transcript = [...baseMessages];
    const preservedBlocks = anthropicContinuationBlocksForToolCalls(previousModel, toolCalls);
    if (toolCalls.length) {
      transcript.push(preservedBlocks
        ? { role: 'assistant', content: preservedBlocks }
        : { role: 'assistant', content: '', tool_calls: toolCalls.map((call, index) => ({ id: call.id || `tool-call-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) } })) });
    }
    for (let index = 0; index < toolResults.length; index += 1) transcript.push({ role: 'tool', tool_call_id: toolCalls[index]?.id || `tool-call-${index}`, content: toolOutputText(toolResults[index]) });
    const result = await complete({ ...options, messages: transcript });
    if (result.ok || !preservedBlocks || !anthropicErrorLooksLikeSignedThinking(result.error)) return result;
    await options.traceLogger?.model?.({ stage: 'model-request-repair', requestId: result.requestId, provider: 'anthropic', api: 'anthropic-messages', model, reason: 'signed_thinking_rejected', error: result.error, ts: clock() });
    const repairedTranscript = [...baseMessages];
    if (toolCalls.length) repairedTranscript.push({ role: 'assistant', content: '', tool_calls: toolCalls.map((call, index) => ({ id: call.id || `tool-call-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments || {}) } })) });
    for (let index = 0; index < toolResults.length; index += 1) repairedTranscript.push({ role: 'tool', tool_call_id: toolCalls[index]?.id || `tool-call-${index}`, content: toolOutputText(toolResults[index]) });
    const repaired = await complete({ ...options, messages: repairedTranscript });
    if (repaired && typeof repaired === 'object') repaired.repairedContinuation = { reason: 'signed_thinking_rejected', originalRequestId: result.requestId };
    return repaired;
  } };
}

export const __test__ = { anthropicUrl, normalizeAnthropicChoice, anthropicCachedTokens, anthropicThinkingConfig, supportsAnthropicThinking, supportsAdaptiveAnthropicThinking };

