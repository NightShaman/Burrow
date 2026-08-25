import { createHash, randomUUID } from 'node:crypto';
import { normalizeProviderMessage, normalizeProviderMessages, providerMessageManifest as buildProviderMessageManifest, providerToolRound, pruneProviderToolResults } from '../provider-messages.mjs';

// The model envelope is transient transport data. Keep it comfortably below
// normal tool evidence limits: callers retain the normalized choice, not the
// provider's entire response object.
// A provider response is transport data, not retained runtime state. Do not
// turn a valid long/verbose response into a failed turn merely because its wire
// envelope exceeds the compact normalized-answer budget below. Keep a generous
// transport guard for genuinely pathological upstreams; normalized text,
// thought, tool arguments, and continuation receipts remain bounded.
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const CLAUDE_CODE_VERSION = '2.1.226';
const CLAUDE_CODE_BILLING_SYSTEM_BLOCK = `x-anthropic-billing-header: cc_version=${CLAUDE_CODE_VERSION}; cc_entrypoint=sdk-cli;`;
const MAX_MODEL_TEXT_CHARS = 64 * 1024;
const MAX_TOOL_ARGUMENT_CHARS = 16 * 1024;
// A native tool call is protocol data, not answer prose. Its full SSE envelope
// must stay small enough that malformed arguments cannot become live loop state.
const MAX_TOOL_CALL_STREAM_BYTES = 128 * 1024;
const MAX_STREAM_TOOL_CALLS = 32;
// SSE needs only a short unfinished line/event carry. Provider events are
// normalized immediately; never build a response-sized string just to parse it.
const MAX_SSE_CARRY_CHARS = 1024 * 1024;
const MAX_SSE_EVENT_CHARS = 1024 * 1024;
// Tool results are already persisted as trace artifacts. Native continuation
// messages need enough evidence for the next decision, not another full copy
// of every raw result in the live provider transcript.

const DEFAULT_IMAGE_INPUT_TOKEN_ESTIMATE = 1_024;

function contextUsageFromRequest({ promptChars = 0, bodyChars = 0, imageCount = 0, model = null, api = null, continuation = false, modelCall = null, clock = () => new Date().toISOString() } = {}) {
  // Data-URI image bytes inflate the wire body but are not text tokens. Keep
  // transport size diagnostic-only and budget vision input explicitly.
  const normalizedImageCount = Math.max(0, Number(imageCount) || 0);
  const textEstimatedTokens = Math.ceil(Math.max(0, Number(promptChars) || 0) / 4);
  const imageEstimatedTokens = normalizedImageCount * DEFAULT_IMAGE_INPUT_TOKEN_ESTIMATE;
  return {
    source: 'provider-request-estimate',
    estimatedTokens: textEstimatedTokens + imageEstimatedTokens,
    estimatedChars: Math.max(0, Number(promptChars) || 0),
    transportChars: Math.max(0, Number(bodyChars) || 0),
    promptChars: Math.max(0, Number(promptChars) || 0),
    imageCount: normalizedImageCount,
    imageEstimatedTokens,
    model: model || null,
    api: api || null,
    continuation: Boolean(continuation),
    ...(Number.isFinite(Number(modelCall)) ? { modelCall: Number(modelCall) } : {}),
    updatedAt: clock(),
  };
}

function contextUsageFromResponse(requestUsage = {}, usage = null, clock = () => new Date().toISOString()) {
  const providerInputTokens = Number(usage?.prompt_tokens ?? usage?.input_tokens);
  if (!Number.isFinite(providerInputTokens) || providerInputTokens < 0) return requestUsage;
  const requestEstimatedTokens = Number(requestUsage?.estimatedTokens);
  const providerIsConservative = !Number.isFinite(requestEstimatedTokens) || providerInputTokens >= requestEstimatedTokens;
  // Provider token telemetry is valuable, but for the context meter a lower
  // provider-input count can be a narrower accounting ruler than the full
  // serialized request estimate (for example tool schemas/body overhead). Do
  // not let a response event make the visible active-context meter shrink
  // within the same normal request; keep the conservative full-request
  // baseline and carry providerInputTokens separately.
  return {
    ...requestUsage,
    source: providerIsConservative ? 'provider-input-tokens' : (requestUsage.source || 'provider-request-estimate'),
    estimatedTokens: providerIsConservative ? providerInputTokens : requestUsage.estimatedTokens,
    providerInputTokens,
    updatedAt: clock(),
  };
}

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function serializedMessageHash(message) {
  if (!message) return null;
  return createHash('sha256').update(JSON.stringify(message)).digest('hex');
}

function isChatGptBackendBaseUrl(value) {
  const raw = trimSlash(value);
  if (!raw) return false;
  try {
    const url = new URL(raw);
    const pathname = url.pathname.replace(/\/+$/, '');
    return url.hostname.toLowerCase() === 'chatgpt.com' && ['/backend-api', '/backend-api/v1', '/backend-api/codex', '/backend-api/codex/v1'].includes(pathname);
  } catch {
    return false;
  }
}

function codexResponsesUrl(baseUrl) {
  const url = new URL(trimSlash(baseUrl));
  url.pathname = '/backend-api/codex/responses';
  url.search = '';
  url.hash = '';
  return url.toString();
}

function completionUrl(config = {}) {
  const baseUrl = trimSlash(config.baseUrl || config.apiBaseUrl || config.url);
  if (!baseUrl) throw new Error('model baseUrl is required');
  if (isChatGptBackendBaseUrl(baseUrl)) return codexResponsesUrl(baseUrl);
  if (config.chatCompletionsPath) return `${baseUrl}/${String(config.chatCompletionsPath).replace(/^\/+/, '')}`;
  if (baseUrl.endsWith('/chat/completions')) return baseUrl;
  if (baseUrl.endsWith('/v1')) return `${baseUrl}/chat/completions`;
  return `${baseUrl}/v1/chat/completions`;
}

function responsesUrl(config = {}) {
  const baseUrl = trimSlash(config.baseUrl || config.apiBaseUrl || config.url);
  if (!baseUrl) throw new Error('model baseUrl is required');
  if (isChatGptBackendBaseUrl(baseUrl)) return codexResponsesUrl(baseUrl);
  if (config.responsesPath) return `${baseUrl}/${String(config.responsesPath).replace(/^\/+/, '')}`;
  if (baseUrl.endsWith('/responses')) return baseUrl;
  if (baseUrl.endsWith('/v1')) return `${baseUrl}/responses`;
  return `${baseUrl}/v1/responses`;
}

function apiMode(config = {}) {
  const requested = config.api || config.mode || 'openai-chat-completions';
  if (isChatGptBackendBaseUrl(config.baseUrl || config.apiBaseUrl || config.url)) return 'openai-responses';
  return requested;
}

function redactHeaders(headers = {}) {
  const redacted = { ...headers };
  for (const key of Object.keys(redacted)) {
    if (/authorization|api-key|token|secret/i.test(key)) redacted[key] = '[redacted]';
  }
  return redacted;
}

function boundedText(value, maxChars) {
  const text = String(value || '');
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

// Provider tool-call arguments can be arbitrary JSON-like graphs. Do not
// stringify a whole graph and only then cap it: that creates the very large
// transient string this boundary is meant to prevent.
function boundedJsonText(value, { maxChars = MAX_TOOL_ARGUMENT_CHARS, maxDepth = 12, maxItems = 64, maxKeys = 64 } = {}) {
  const seen = new WeakSet();
  // Keep the sanitized graph itself small enough that one normal JSON.stringify
  // is bounded and always produces valid provider argument JSON.
  const itemLimit = Math.min(Math.max(1, maxItems), 32);
  const keyLimit = Math.min(Math.max(1, maxKeys), 32);
  const stringLimit = Math.min(256, Math.max(32, Math.floor(maxChars / Math.max(1, keyLimit * 2))));
  const visit = (item, depth = 0) => {
    if (item === null || typeof item === 'boolean' || typeof item === 'number') return item;
    if (typeof item === 'string') return item.length > stringLimit ? `${item.slice(0, stringLimit)}… [truncated]` : item;
    if (typeof item !== 'object') return String(item);
    if (depth >= maxDepth || seen.has(item)) return '[truncated]';
    seen.add(item);
    if (Array.isArray(item)) {
      const result = [];
      const count = Math.min(item.length, itemLimit);
      for (let index = 0; index < count; index += 1) result.push(visit(item[index], depth + 1));
      if (item.length > count) result.push('[truncated]');
      return result;
    }
    const result = {};
    let count = 0;
    for (const key in item) {
      if (!Object.hasOwn(item, key)) continue;
      if (count >= keyLimit) { result.__truncated = '[truncated]'; break; }
      count += 1;
      result[key] = visit(item[key], depth + 1);
    }
    return result;
  };
  const text = JSON.stringify(visit(value));
  // The graph limits above keep ordinary provider argument JSON well below the
  // boundary. A tiny caller-supplied cap still gets valid JSON rather than a
  // sliced invalid fragment.
  return text.length <= maxChars ? text : JSON.stringify({ __truncated: '[truncated]' });
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  if (!value || typeof value !== 'string' || value.length > MAX_TOOL_ARGUMENT_CHARS) return {};
  try { return JSON.parse(value); } catch { return {}; }
}

function normalizeToolCall(call = {}, index = 0) {
  const fn = call.function || call;
  const name = fn.name || call.name || null;
  const rawArguments = fn.arguments ?? call.arguments ?? {};
  const rawArgumentText = typeof rawArguments === 'string'
    ? rawArguments
    : boundedJsonText(rawArguments);
  return {
    id: boundedText(call.id || call.call_id || `tool-call-${index}`, 256),
    type: boundedText(call.type || 'function', 64),
    name: boundedText(name, 256) || null,
    ...(call.providerItemId ? { providerItemId: boundedText(call.providerItemId, 256) } : {}),
    arguments: parseArguments(rawArguments),
    rawArguments: boundedText(rawArgumentText, MAX_TOOL_ARGUMENT_CHARS),
    argumentsTruncated: rawArgumentText.length > MAX_TOOL_ARGUMENT_CHARS,
  };
}

function normalizeChoice(data = {}) {
  const choice = data.choices?.[0] || null;
  const text = boundedText(choice?.message?.content ?? choice?.text ?? '', MAX_MODEL_TEXT_CHARS);
  return {
    index: choice?.index ?? 0,
    finishReason: choice?.finish_reason ?? choice?.finishReason ?? null,
    // Do not retain the provider's message object: compatible servers often
    // add reasoning/debug fields here that the runtime never consumes.
    message: { role: boundedText(choice?.message?.role || 'assistant', 64), content: text },
    text,
    toolCalls: (choice?.message?.tool_calls || []).slice(0, 32).map(normalizeToolCall),
  };
}

function textFromResponses(data = {}) {
  if (typeof data.output_text === 'string') return boundedText(data.output_text, MAX_MODEL_TEXT_CHARS);
  const chunks = [];
  let remaining = MAX_MODEL_TEXT_CHARS;
  for (const item of (data.output || []).slice(0, 32)) {
    for (const part of (item.content || []).slice(0, 64)) {
      if (typeof part.text !== 'string' || remaining <= 0) continue;
      const text = part.text.slice(0, remaining);
      chunks.push(text);
      remaining -= text.length;
    }
  }
  return chunks.join('');
}

function normalizeResponseToolCalls(data = {}) {
  return (data.output || [])
    .filter((item) => item?.type === 'function_call' || item?.type === 'tool_call')
    .slice(0, 32)
    .map(normalizeToolCall);
}

function compactResponseToolOutput(output = []) {
  if (!Array.isArray(output)) return [];
  return output
    .filter((item) => item?.type === 'function_call' || item?.type === 'tool_call')
    .slice(0, 32)
    .map((item, index) => ({
      type: item.type === 'tool_call' ? 'tool_call' : 'function_call',
      id: boundedText(item.call_id || item.id || `tool-call-${index}`, 256),
      call_id: boundedText(item.call_id || item.id || `tool-call-${index}`, 256),
      providerItemId: boundedText(item.id || item.call_id || `tool-call-${index}`, 256),
      name: boundedText(item.name || item.function?.name, 256),
      arguments: boundedText(typeof item.arguments === 'string' ? item.arguments : boundedJsonText(item.arguments || item.function?.arguments || {}), MAX_TOOL_ARGUMENT_CHARS),
    }));
}

function mergeResponseFunctionCall(calls, fragment = {}) {
  const outputIndex = Number.isInteger(fragment.output_index) ? fragment.output_index : Number.isInteger(fragment.index) ? fragment.index : calls.length;
  if (outputIndex < 0 || outputIndex >= MAX_STREAM_TOOL_CALLS) return false;
  const callId = fragment.call_id || fragment.item?.call_id || fragment.item?.id || fragment.id || `tool-call-${outputIndex}`;
  const providerItemId = fragment.item?.id || fragment.id || callId;
  const prior = calls[outputIndex] || { type: 'function_call', id: callId, call_id: callId, providerItemId, name: null, arguments: '' };
  const name = fragment.name || fragment.item?.name || fragment.function?.name || prior.name;
  const argumentFragment = typeof fragment.delta === 'string'
    ? fragment.delta
    : typeof fragment.arguments === 'string'
      ? fragment.arguments
      : typeof fragment.item?.arguments === 'string'
        ? fragment.item.arguments
        : typeof fragment.function?.arguments === 'string'
          ? fragment.function.arguments
          : '';
  const replaceArguments = typeof fragment.arguments === 'string' || typeof fragment.item?.arguments === 'string' || typeof fragment.function?.arguments === 'string';
  const nextArguments = replaceArguments ? argumentFragment : `${prior.arguments || ''}${argumentFragment}`;
  if (nextArguments.length > MAX_TOOL_ARGUMENT_CHARS) return false;
  calls[outputIndex] = {
    type: 'function_call',
    id: boundedText(prior.call_id || callId, 256),
    call_id: boundedText(prior.call_id || callId, 256),
    providerItemId: boundedText(prior.providerItemId || providerItemId, 256),
    name: boundedText(name, 256),
    arguments: nextArguments,
  };
  return true;
}

function normalizeResponseChoice(data = {}) {
  const text = textFromResponses(data);
  return {
    index: 0,
    finishReason: boundedText(data.status, 128) || null,
    message: { role: 'assistant', content: text },
    text,
    toolCalls: normalizeResponseToolCalls(data),
  };
}

function truncatedNativeText(value, maxChars) {
  if (typeof value !== 'string') return null;
  if (value.length <= maxChars) return value;
  return `${value.slice(0, maxChars)}\n[truncated in native continuation; full receipt remains in trace artifacts]`;
}

function nativeToolReceipt(result = {}) {
  const receipt = {};
  // Identity and outcome fields let the model reason about all results without
  // retaining arbitrary result graphs in the provider-native transcript.
  for (const key of ['tool', 'ok', 'error', 'filePath', 'path', 'dirPath', 'command', 'query', 'pattern', 'id', 'resultCount', 'contentHash', 'resultFingerprint', 'truncated', 'durationMs']) {
    const value = result?.[key];
    if (value === null || typeof value === 'boolean' || typeof value === 'number') receipt[key] = value;
    else if (typeof value === 'string') receipt[key] = truncatedNativeText(value, 1_000);
  }
  // Preserve complete result fields here. Native continuation preparation is
  // the only authority allowed to project them for a provider budget.
  for (const key of ['content', 'stdout', 'stderr', 'summary', 'output']) {
    const value = result?.[key];
    if (typeof value === 'string') receipt[key] = value;
  }
  // Explicit recall is evidence, not a three-field status stub. Preserve the
  // selected results through the native protocol so preparation can apply the
  // real provider budget with coverage metadata if it must compact them.
  if (result?.tool === 'session_search' && Array.isArray(result.results)) {
    receipt.scope = typeof result.scope === 'string' ? result.scope : null;
    receipt.searchedSessionCount = Number.isFinite(result.searchedSessionCount) ? result.searchedSessionCount : null;
    receipt.count = Number.isFinite(result.count) ? result.count : result.results.length;
    receipt.totalMatches = Number.isFinite(result.totalMatches) ? result.totalMatches : result.results.length;
    receipt.results = result.results;
  }
  // MCP output is external evidence. Preserve a bounded JSON rendering so a
  // provider-native continuation can reason about the actual response rather
  // than a misleading transport-only { ok: true } receipt.
  if (result?.tool === 'mcp_call' && result?.output !== undefined) {
    receipt.output = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
    if (Array.isArray(result.protectedValues) && result.protectedValues.length) {
      receipt.protectedValues = result.protectedValues.map((item) => ({ ref: item?.ref || null, field: item?.field || null }));
      receipt.protectedValueGuidance = 'Protected values are available only by passing their protected:// reference through a later tool’s protectedBindings. Never place credentials in command text.';
    }
  }
  // Agent-to-agent replies are a bounded, attributed result of this tool call.
  // Keep the actual reply visible to the initiating model on native provider
  // continuations; arbitrary nested tool output remains excluded.
  if (result?.tool === 'agent_send_message' && result?.reply && typeof result.reply === 'object') {
    receipt.recipientReply = {
      ok: result.reply.ok === true,
      content: typeof result.reply.content === 'string' ? result.reply.content : null,
      error: typeof result.reply.error === 'string' ? result.reply.error : null,
    };
  }
  // These are explicit tool-returned evidence collections. Preserve them whole
  // until provider-budget preparation projects them with truthful coverage.
  if (Array.isArray(result?.paths)) receipt.paths = result.paths;
  if (Array.isArray(result?.entries)) receipt.entries = result.entries;
  if (Array.isArray(result?.matches)) receipt.matches = result.matches;
  if (Array.isArray(result?.tasks)) receipt.tasks = result.tasks.slice(0, 12).map((task) => ({
    id: task?.id || null, projectId: task?.projectId || null,
    title: truncatedNativeText(task?.title, 500), description: truncatedNativeText(task?.description, 1_200),
    status: task?.status || null, priority: task?.priority || null,
    assignedAgentId: task?.assignedAgentId || null, updatedAt: task?.updatedAt || null,
  }));
  if (Array.isArray(result?.providers)) receipt.providers = result.providers.slice(0, 20).map((provider) => ({
    id: provider?.id || null, name: truncatedNativeText(provider?.name, 120), transport: provider?.transport || null,
    catalogToolCount: Number(provider?.catalogToolCount) || 0, grantedToolCount: Number(provider?.grantedToolCount) || 0,
    available: provider?.available === true,
  }));
  if (Array.isArray(result?.tools) && result?.tool === 'mcp_capabilities') receipt.tools = result.tools.slice(0, 20).map((tool) => ({
    name: truncatedNativeText(tool?.name, 240), description: truncatedNativeText(tool?.description, 2_000),
    inputSchema: tool?.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
    granted: tool?.granted === true,
  }));
  for (const key of ['provider', 'nextCursor']) if (typeof result?.[key] === 'string') receipt[key] = truncatedNativeText(result[key], 500);
  for (const key of ['totalCount']) if (typeof result?.[key] === 'number') receipt[key] = result[key];
  if (result?.task && typeof result.task === 'object') receipt.task = {
    id: result.task.id || null, projectId: result.task.projectId || null,
    title: truncatedNativeText(result.task.title, 500), status: result.task.status || null,
    priority: result.task.priority || null, assignedAgentId: result.task.assignedAgentId || null,
    updatedAt: result.task.updatedAt || null,
  };
  if (result?.artifacts && typeof result.artifacts === 'object') {
    receipt.artifacts = Object.fromEntries(Object.entries(result.artifacts).slice(0, 12).map(([key, value]) => [key, typeof value === 'string' ? value.slice(0, 800) : null]));
  }
  return receipt;
}

function toolOutputText(result = {}) {
  return JSON.stringify(nativeToolReceipt(result));
}

function truncatedNativeTailText(value, maxChars) {
  if (typeof value !== 'string') return null;
  if (value.length <= maxChars) return value;
  const marker = '[earlier volatile context truncated in native continuation]\n';
  return `${marker}${value.slice(-(maxChars - marker.length))}`;
}

function nativeTextFromStructuredContent(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(nativeTextFromStructuredContent).filter(Boolean).join('\n');
  if (typeof value !== 'object') return '';
  const type = String(value.type || '').toLowerCase();
  if (type === 'image_url' || type === 'input_image' || value.image_url || value.input_image) return '';
  return nativeTextFromStructuredContent(value.text ?? value.content ?? value.message ?? value.output ?? value.value);
}

function nativeMessageContent(content, maxChars = MAX_NATIVE_BASE_MESSAGE_CHARS, { preserveTail = false } = {}) {
  if (maxChars <= 0) return '';
  if (typeof content === 'string') return (preserveTail ? truncatedNativeTailText(content, maxChars) : truncatedNativeText(content, maxChars)) || '';
  if (Array.isArray(content)) {
    let remaining = maxChars;
    const parts = [];
    for (const part of content) {
      if (!part || typeof part !== 'object') {
        const text = nativeTextFromStructuredContent(part);
        if (!text) continue;
        const bounded = (preserveTail ? truncatedNativeTailText(text, remaining) : truncatedNativeText(text, remaining)) || '';
        if (bounded) parts.push({ type: 'text', text: bounded });
        remaining = Math.max(0, remaining - bounded.length);
        continue;
      }
      const type = String(part.type || '').toLowerCase();
      if ((type === 'image_url' || part.image_url) && part.image_url?.url) {
        parts.push({ type: 'image_url', image_url: { url: String(part.image_url.url) } });
        continue;
      }
      if ((type === 'input_image' || part.input_image) && part.input_image) {
        parts.push({ type: 'input_image', input_image: part.input_image });
        continue;
      }
      const text = nativeTextFromStructuredContent(part);
      if (!text || remaining <= 0) continue;
      const bounded = (preserveTail ? truncatedNativeTailText(text, remaining) : truncatedNativeText(text, remaining)) || '';
      if (bounded) parts.push({ type: 'text', text: bounded });
      remaining = Math.max(0, remaining - bounded.length);
    }
    return parts;
  }
  const text = nativeTextFromStructuredContent(content);
  return (preserveTail ? truncatedNativeTailText(text, maxChars) : truncatedNativeText(text, maxChars)) || '';
}

function nativeBaseMessage(message = {}, maxChars = Infinity, { preserveTail = false } = {}) {
  const role = ['system', 'developer', 'user', 'assistant'].includes(message?.role) ? message.role : 'user';
  return { role, content: nativeMessageContent(message?.content, maxChars, { preserveTail }) };
}

function boundedNativeBaseMessages(messages = []) {
  // A continuation must retain the exact static prefix accepted by the initial
  // provider request. It is an ordered semantic unit, not a pool where an
  // earlier profile block may starve later operating instructions. Context
  // preparation owns model-window fitting before the first call; silently
  // changing system/developer content here creates a different agent mid-turn.
  const stableIndexes = [];
  const dialogueIndexes = [];
  for (const [index, message] of messages.entries()) {
    if (message?.role === 'system' || message?.role === 'developer') stableIndexes.push(index);
    else if (message?.role === 'user' || message?.role === 'assistant') dialogueIndexes.push(index);
  }
  const retained = new Map();
  for (const index of stableIndexes) {
    const next = nativeBaseMessage(messages[index]);
    if (next.content) retained.set(index, next);
  }
  // Select newest dialogue first, but restore natural conversation order for
  // the provider. The latest user turn is therefore guaranteed first claim on
  // the dialogue budget without flattening or inventing a synthetic summary.
  let dialogueRemaining = MAX_NATIVE_RECENT_DIALOGUE_CHARS;
  for (const index of [...dialogueIndexes].reverse()) {
    if (dialogueRemaining <= 0) break;
    const next = nativeBaseMessage(messages[index], dialogueRemaining, { preserveTail: true });
    dialogueRemaining = Math.max(0, dialogueRemaining - messageContentChars(next.content));
    if (next.content) retained.set(index, next);
  }
  return [...retained.entries()].sort(([left], [right]) => left - right).map(([, message]) => message);
}

function nativeToolCall(call = {}, index = 0) {
  const rawArguments = typeof call?.rawArguments === 'string'
    ? boundedText(call.rawArguments, MAX_TOOL_ARGUMENT_CHARS)
    : boundedJsonText(call?.arguments || {});
  return {
    id: boundedText(call?.id || `tool-call-${index}`, 256),
    type: 'function',
    function: {
      name: boundedText(call?.name, 256),
      arguments: boundedText(rawArguments, MAX_TOOL_ARGUMENT_CHARS),
    },
  };
}

function nativeToolRound({ toolCalls = [], toolResults = [] } = {}) {
  return providerToolRound({
    toolCalls: (toolCalls || []).map(nativeToolCall).map((call) => ({
      id: call.id,
      name: call.function.name,
      rawArguments: call.function.arguments,
    })),
    toolResults,
    toolResultContent: toolOutputText,
  });
}

function nativeMessageChars(message = {}) {
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  return messageContentChars(message.content) + calls.reduce((sum, call) => sum + String(call?.function?.name || '').length + String(call?.function?.arguments || '').length, 0);
}

function chatToolContinuationMessages({ baseMessages = [], toolCalls = [], toolResults = [] } = {}) {
  // Structure only: normalize roles and preserve every complete assistant call
  // ↔ tool-result pair. Context preparation owns every semantic reduction.
  return normalizeProviderMessages([...baseMessages, ...nativeToolRound({ toolCalls, toolResults })]);
}

function messageContentChars(content) {
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return String(content || '').length;
  return content.reduce((sum, part) => sum + String(part?.text || part?.image_url?.url || part?.input_image?.image_url || '').length, 0);
}

function contentPartToResponses(part = {}) {
  if (part.type === 'text') return { type: 'input_text', text: String(part.text || '') };
  if (part.type === 'image_url') return { type: 'input_image', image_url: part.image_url?.url || part.image_url || part.url || '' };
  return part;
}

function messageContentToResponses(content) {
  if (!Array.isArray(content)) return String(content || '');
  return content.map(contentPartToResponses);
}

function messagesToResponsesInput(messages, prompt) {
  if (!messages?.length) return String(prompt || '');
  const input = [];
  for (const message of messages) {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      for (const call of message.tool_calls.slice(0, MAX_STREAM_TOOL_CALLS)) {
        const fn = call.function || call;
        input.push({
          type: 'function_call',
          call_id: String(call.id || call.call_id || `tool-call-${input.length}`).slice(0, 256),
          name: String(fn.name || call.name || '').slice(0, 256),
          arguments: typeof fn.arguments === 'string' ? boundedText(fn.arguments, MAX_TOOL_ARGUMENT_CHARS) : boundedJsonText(fn.arguments ?? call.arguments ?? {}),
        });
      }
      continue;
    }
    if (message?.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: String(message.tool_call_id || message.id || `tool-call-${input.length}`).slice(0, 256),
        output: String(message.content || ''),
      });
      continue;
    }
    const item = { role: message.role || 'user', content: messageContentToResponses(message.content) };
    if (message?.metadata?.providerMessageSource) {
      Object.defineProperty(item, 'metadata', {
        value: { providerMessageSource: message.metadata.providerMessageSource },
        enumerable: false,
      });
    }
    input.push(item);
  }
  return input;
}

function responseApiTool(tool = {}) {
  const fn = tool.function || tool;
  return {
    type: 'function',
    name: fn.name,
    description: fn.description || '',
    parameters: fn.parameters || { type: 'object', properties: {} },
  };
}

function toolNames(tools = []) {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => tool?.function?.name || tool?.name).filter(Boolean);
}

function boundedAppend(current, value, maxChars = MAX_MODEL_TEXT_CHARS) {
  const remaining = Math.max(0, maxChars - String(current || '').length);
  return remaining ? String(value || '').slice(0, remaining) : '';
}

async function notifyStreamDelta(callback, delta, totalChars) {
  if (!delta || typeof callback !== 'function') return;
  // Delivery is advisory. A client transport failure must not invalidate a
  // provider response or the authoritative final transcript.
  try { await callback({ delta, totalChars }); } catch {}
}

function streamToolCallFailure(calls, fragment = {}) {
  const index = Number.isInteger(fragment.index) ? fragment.index : calls.length;
  if (index < 0 || index >= MAX_STREAM_TOOL_CALLS) return `model_tool_call_index_invalid:${index}`;
  const priorArguments = String(calls[index]?.function?.arguments || '');
  const argumentFragment = String(fragment.function?.arguments || '');
  const argumentChars = priorArguments.length + argumentFragment.length;
  return argumentChars > MAX_TOOL_ARGUMENT_CHARS
    ? `model_tool_arguments_too_large:${argumentChars}>${MAX_TOOL_ARGUMENT_CHARS}`
    : null;
}

function responseFunctionCallFailure(calls, fragment = {}) {
  const outputIndex = Number.isInteger(fragment.output_index) ? fragment.output_index : Number.isInteger(fragment.index) ? fragment.index : calls.length;
  if (outputIndex < 0 || outputIndex >= MAX_STREAM_TOOL_CALLS) return `model_tool_call_index_invalid:${outputIndex}`;
  const priorArguments = String(calls[outputIndex]?.arguments || '');
  const argumentFragment = typeof fragment.delta === 'string'
    ? fragment.delta
    : typeof fragment.arguments === 'string'
      ? fragment.arguments
      : typeof fragment.item?.arguments === 'string'
        ? fragment.item.arguments
        : typeof fragment.function?.arguments === 'string'
          ? fragment.function.arguments
          : '';
  const replaceArguments = typeof fragment.arguments === 'string' || typeof fragment.item?.arguments === 'string' || typeof fragment.function?.arguments === 'string';
  const argumentChars = replaceArguments ? argumentFragment.length : priorArguments.length + argumentFragment.length;
  return argumentChars > MAX_TOOL_ARGUMENT_CHARS
    ? `model_tool_arguments_too_large:${argumentChars}>${MAX_TOOL_ARGUMENT_CHARS}`
    : null;
}

function mergeStreamToolCall(calls, fragment = {}) {
  const index = Number.isInteger(fragment.index) ? fragment.index : calls.length;
  if (index < 0 || index >= MAX_STREAM_TOOL_CALLS) return false;
  const prior = calls[index] || { id: null, type: 'function', function: { name: null, arguments: '' } };
  const argumentFragment = String(fragment.function?.arguments || '');
  const priorArguments = String(prior.function?.arguments || '');
  // Refuse an over-limit call before concatenating it into a new large string.
  if (priorArguments.length + argumentFragment.length > MAX_TOOL_ARGUMENT_CHARS) return false;
  calls[index] = {
    ...prior,
    id: boundedText(fragment.id || prior.id, 256),
    type: boundedText(fragment.type || prior.type || 'function', 64),
    function: {
      ...prior.function,
      ...(fragment.function?.name ? { name: boundedText(fragment.function.name, 256) } : {}),
      arguments: priorArguments + argumentFragment,
    },
  };
  return true;
}

// OpenAI-compatible servers commonly use SSE for both Chat Completions and
// Responses. Output text becomes the persisted assistant answer. Provider
// reasoning is a separate, transient work stream for the active chat only;
// neither it nor raw vendor events enter the transcript or retained response.
function compactResponseCompletion(response = {}) {
  // `response.completed` can contain vendor reasoning, annotations, and output
  // graphs. The streaming adapter already owns bounded deltas; keep only the
  // terminal identifiers and usage telemetry it actually needs.
  const usage = response?.usage && typeof response.usage === 'object'
    ? {
        prompt_tokens: Number.isFinite(Number(response.usage.prompt_tokens)) ? Number(response.usage.prompt_tokens) : undefined,
        input_tokens: Number.isFinite(Number(response.usage.input_tokens)) ? Number(response.usage.input_tokens) : undefined,
        completion_tokens: Number.isFinite(Number(response.usage.completion_tokens)) ? Number(response.usage.completion_tokens) : undefined,
        output_tokens: Number.isFinite(Number(response.usage.output_tokens)) ? Number(response.usage.output_tokens) : undefined,
        total_tokens: Number.isFinite(Number(response.usage.total_tokens)) ? Number(response.usage.total_tokens) : undefined,
      }
    : null;
  const outputText = typeof response?.output_text === 'string'
    ? boundedText(response.output_text, MAX_MODEL_TEXT_CHARS)
    : '';
  const toolOutput = compactResponseToolOutput(response?.output);
  return {
    ...(typeof response?.id === 'string' ? { id: boundedText(response.id, 256) } : {}),
    ...(typeof response?.status === 'string' ? { status: boundedText(response.status, 64) } : {}),
    ...(outputText ? { output_text: outputText } : {}),
    ...(toolOutput.length ? { output: toolOutput } : {}),
    ...(usage ? { usage: Object.fromEntries(Object.entries(usage).filter(([, value]) => value !== undefined)) } : {}),
  };
}

async function readResponseSseBounded(response, { mode, maxBytes = DEFAULT_MAX_RESPONSE_BYTES, onTextDelta = null, onThoughtDelta = null } = {}) {
  const limit = Math.max(1, Math.floor(Number(maxBytes) || DEFAULT_MAX_RESPONSE_BYTES));
  const contentLength = Number(response?.headers?.get?.('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    await response?.body?.cancel?.();
    return { ok: false, bytes: contentLength, error: `model_response_too_large:${contentLength}>${limit}`, data: null, streamedTextChars: 0 };
  }
  const reader = response?.body?.getReader?.();
  if (!reader) return { ok: false, bytes: 0, error: 'model_stream_unavailable', data: null, streamedTextChars: 0 };
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  let text = '';
  let thoughtChars = 0;
  let finalData = null;
  let streamError = null;
  let streamErrorDetails = null;
  let finishReason = null;
  let usage = null;
  const toolCalls = [];
  const responseToolCalls = [];
  let toolCallStreamBytes = 0;
  let toolCallFailure = null;
  const recordToolCallFailure = (failure) => {
    if (!toolCallFailure && failure) toolCallFailure = failure;
  };
  let dataLines = [];
  let dataChars = 0;
  const emit = async (delta) => {
    const safe = boundedAppend(text, delta);
    if (!safe) return;
    text += safe;
    await notifyStreamDelta(onTextDelta, safe, text.length);
  };
  const emitThought = async (delta) => {
    const remaining = Math.max(0, MAX_MODEL_TEXT_CHARS - thoughtChars);
    const safe = remaining ? String(delta || '').slice(0, remaining) : '';
    if (!safe) return;
    thoughtChars += safe.length;
    await notifyStreamDelta(onThoughtDelta, safe, thoughtChars);
  };
  const consumeEvent = async () => {
    if (!dataLines.length) return;
    const raw = dataLines.join('\n');
    dataLines = [];
    dataChars = 0;
    if (!raw || raw === '[DONE]') return;
    let event;
    try { event = JSON.parse(raw); } catch { return; }
    if (mode === 'openai-responses') {
      if (event?.type === 'response.output_text.delta' && typeof event.delta === 'string') await emit(event.delta);
      if ((event?.type === 'response.reasoning.delta' || event?.type === 'response.reasoning_summary_text.delta') && typeof event.delta === 'string') await emitThought(event.delta);
      if ((event?.type === 'response.output_item.added' || event?.type === 'response.output_item.done') && (event.item?.type === 'function_call' || event.item?.type === 'tool_call')) {
        const fragmentBytes = Buffer.byteLength(String(event.item?.arguments || '')) + Buffer.byteLength(String(event.item?.name || '')) + Buffer.byteLength(String(event.item?.call_id || event.item?.id || ''));
        toolCallStreamBytes += fragmentBytes;
        recordToolCallFailure(responseFunctionCallFailure(responseToolCalls, event));
        if (!toolCallFailure && !mergeResponseFunctionCall(responseToolCalls, event)) recordToolCallFailure('model_tool_call_invalid');
        if (toolCallStreamBytes > MAX_TOOL_CALL_STREAM_BYTES) recordToolCallFailure(`model_tool_call_too_large:${toolCallStreamBytes}>${MAX_TOOL_CALL_STREAM_BYTES}`);
      }
      if (event?.type === 'response.function_call_arguments.delta') {
        const fragmentBytes = Buffer.byteLength(String(event.delta || ''));
        toolCallStreamBytes += fragmentBytes;
        recordToolCallFailure(responseFunctionCallFailure(responseToolCalls, event));
        if (!toolCallFailure && !mergeResponseFunctionCall(responseToolCalls, event)) recordToolCallFailure('model_tool_call_invalid');
        if (toolCallStreamBytes > MAX_TOOL_CALL_STREAM_BYTES) recordToolCallFailure(`model_tool_call_too_large:${toolCallStreamBytes}>${MAX_TOOL_CALL_STREAM_BYTES}`);
      }
      if (event?.type === 'response.function_call_arguments.done') {
        const fragmentBytes = Buffer.byteLength(String(event.arguments || ''));
        toolCallStreamBytes += fragmentBytes;
        recordToolCallFailure(responseFunctionCallFailure(responseToolCalls, event));
        if (!toolCallFailure && !mergeResponseFunctionCall(responseToolCalls, event)) recordToolCallFailure('model_tool_call_invalid');
        if (toolCallStreamBytes > MAX_TOOL_CALL_STREAM_BYTES) recordToolCallFailure(`model_tool_call_too_large:${toolCallStreamBytes}>${MAX_TOOL_CALL_STREAM_BYTES}`);
      }
      if (event?.type === 'response.completed' && event.response && typeof event.response === 'object') {
        finalData = compactResponseCompletion(event.response);
        usage = finalData.usage || usage;
        if (!text && finalData.output_text) await emit(finalData.output_text);
        for (const call of (finalData.output || [])) {
          const outputIndex = responseToolCalls.length;
          if (outputIndex < MAX_STREAM_TOOL_CALLS) responseToolCalls[outputIndex] ||= call;
        }
      }
      if (event?.type === 'response.failed' || event?.type === 'error') {
        const responseError = event.response?.error && typeof event.response.error === 'object' ? event.response.error : {};
        const eventError = event.error && typeof event.error === 'object' ? event.error : {};
        const providerError = Object.keys(eventError).length ? eventError : responseError;
        const fallbackMessage = typeof event.error === 'string' ? event.error : null;
        streamError = boundedText(providerError.message || event.message || fallbackMessage || 'model_stream_failed', 500);
        streamErrorDetails = {
          eventType: boundedText(event.type, 64),
          ...(providerError.type ? { type: boundedText(providerError.type, 128) } : {}),
          ...(providerError.code ? { code: boundedText(providerError.code, 128) } : {}),
          ...(providerError.param ? { param: boundedText(providerError.param, 128) } : {}),
          ...(providerError.status ? { status: providerError.status } : {}),
          ...(providerError.message ? { message: boundedText(providerError.message, 500) } : {}),
          ...(event.response?.status ? { responseStatus: boundedText(event.response.status, 128) } : {}),
        };
      }
      return;
    }
    const choice = event?.choices?.[0];
    if (!choice) return;
    if (typeof choice.delta?.content === 'string') await emit(choice.delta.content);
    // Codex-LB/OpenAI-compatible chat streams use these vendor-compatible
    // fields for the transient work/reasoning channel.
    if (typeof choice.delta?.reasoning_content === 'string') await emitThought(choice.delta.reasoning_content);
    if (typeof choice.delta?.reasoning === 'string') await emitThought(choice.delta.reasoning);
    for (const call of choice.delta?.tool_calls || []) {
      // Count only tool-call protocol fragments. Answer prose remains governed
      // by the larger response transport guard and its 64 KiB retained cap.
      const fragmentBytes = Buffer.byteLength(String(call?.function?.arguments || ''))
        + Buffer.byteLength(String(call?.function?.name || ''))
        + Buffer.byteLength(String(call?.id || ''));
      toolCallStreamBytes += fragmentBytes;
      recordToolCallFailure(streamToolCallFailure(toolCalls, call));
      if (!toolCallFailure && !mergeStreamToolCall(toolCalls, call)) recordToolCallFailure('model_tool_call_invalid');
      if (toolCallStreamBytes > MAX_TOOL_CALL_STREAM_BYTES) recordToolCallFailure(`model_tool_call_too_large:${toolCallStreamBytes}>${MAX_TOOL_CALL_STREAM_BYTES}`);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
    if (event.usage) usage = event.usage;
  };
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value?.byteLength ?? value?.length ?? 0;
      if (bytes > limit) {
        await reader.cancel();
        // A streamed response may already contain a useful, bounded answer or
        // valid tool calls. Preserve that normalized result instead of turning
        // a successful provider response into a failed turn because a verbose
        // tail crossed the transport guard.
        // A partial tool-call protocol is not an answer: preserve the hard
        // failure unless we have actual text or a completed Responses result.
        if (text || finalData) {
          streamError = null;
          break;
        }
        return { ok: false, bytes, error: `model_response_too_large:${bytes}>${limit}`, data: null, streamedTextChars: text.length };
      }
      buffer += decoder.decode(value, { stream: true });
      while (true) {
        const match = buffer.match(/\r?\n/);
        if (!match || match.index === undefined) break;
        const line = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        if (!line) await consumeEvent();
        else if (line.startsWith('data:')) {
          const dataLine = line.slice(5).trimStart();
          dataChars += dataLine.length;
          if (dataChars > MAX_SSE_EVENT_CHARS) {
            await reader.cancel();
            return { ok: false, bytes, error: `model_stream_event_too_large:${dataChars}>${MAX_SSE_EVENT_CHARS}`, data: null, streamedTextChars: text.length };
          }
          dataLines.push(dataLine);
        }
      }
      if (toolCallFailure) {
        await reader.cancel();
        return { ok: false, bytes, error: toolCallFailure, data: null, streamedTextChars: text.length };
      }
      // A missing newline must not turn buffer concatenation into an unbounded
      // rope. This protects against malformed SSE without storing raw output.
      if (buffer.length > MAX_SSE_CARRY_CHARS) {
        await reader.cancel();
        return { ok: false, bytes, error: `model_stream_line_too_large:${buffer.length}>${MAX_SSE_CARRY_CHARS}`, data: null, streamedTextChars: text.length };
      }
    }
    buffer += decoder.decode();
    if (buffer.length > MAX_SSE_CARRY_CHARS) return { ok: false, bytes, error: `model_stream_line_too_large:${buffer.length}>${MAX_SSE_CARRY_CHARS}`, data: null, streamedTextChars: text.length };
    if (buffer.startsWith('data:')) {
      const dataLine = buffer.slice(5).trimStart();
      dataChars += dataLine.length;
      if (dataChars > MAX_SSE_EVENT_CHARS) return { ok: false, bytes, error: `model_stream_event_too_large:${dataChars}>${MAX_SSE_EVENT_CHARS}`, data: null, streamedTextChars: text.length };
      dataLines.push(dataLine);
    }
    await consumeEvent();
    if (toolCallFailure) return { ok: false, bytes, error: toolCallFailure, data: null, streamedTextChars: text.length };
  } finally {
    reader.releaseLock?.();
  }
  const data = mode === 'openai-responses'
    ? (finalData ? { ...finalData, ...(text ? { output_text: text } : {}), ...(responseToolCalls.length ? { output: responseToolCalls.filter(Boolean) } : finalData.output ? { output: finalData.output } : {}) } : { status: streamError ? 'failed' : 'completed', output_text: text, output: responseToolCalls.filter(Boolean) })
    : { choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', content: text, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) } }], usage };
  return { ok: !streamError, bytes, error: streamError, errorDetails: streamErrorDetails, data, streamedTextChars: text.length };
}

async function readResponseTextBounded(response, maxBytes = DEFAULT_MAX_RESPONSE_BYTES) {
  const limit = Math.max(1, Math.floor(Number(maxBytes) || DEFAULT_MAX_RESPONSE_BYTES));
  const contentLength = Number(response?.headers?.get?.('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    await response?.body?.cancel?.();
    return { ok: false, text: '', bytes: contentLength, error: `model_response_too_large:${contentLength}>${limit}` };
  }
  const reader = response?.body?.getReader?.();
  if (!reader) {
    // Compatibility fallback for mock/custom fetch implementations. Native
    // fetch responses use the stream branch above, which is the hard limit.
    const text = await response.text();
    const bytes = Buffer.byteLength(text);
    return bytes > limit
      ? { ok: false, text: '', bytes, error: `model_response_too_large:${bytes}>${limit}` }
      : { ok: true, text, bytes, error: null };
  }
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Do not clone an oversized Uint8Array before enforcing the cap. A
      // single malicious/broken upstream chunk must not get a full-size copy
      // in the Node heap just so we can reject it.
      const chunkBytes = value?.byteLength ?? value?.length ?? 0;
      bytes += chunkBytes;
      if (bytes > limit) {
        await reader.cancel();
        return { ok: false, text: '', bytes, error: `model_response_too_large:${bytes}>${limit}` };
      }
      chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return { ok: true, text: Buffer.concat(chunks).toString('utf8'), bytes, error: null };
}


export { randomUUID, normalizeProviderMessage, normalizeProviderMessages, buildProviderMessageManifest, providerToolRound, pruneProviderToolResults };
export {
  DEFAULT_MAX_RESPONSE_BYTES,
  CLAUDE_CODE_VERSION,
  CLAUDE_CODE_BILLING_SYSTEM_BLOCK,
  MAX_MODEL_TEXT_CHARS,
  MAX_TOOL_ARGUMENT_CHARS,
  MAX_TOOL_CALL_STREAM_BYTES,
  MAX_STREAM_TOOL_CALLS,
  MAX_SSE_CARRY_CHARS,
  MAX_SSE_EVENT_CHARS,
  contextUsageFromRequest,
  contextUsageFromResponse,
  trimSlash,
  serializedMessageHash,
  isChatGptBackendBaseUrl,
  completionUrl,
  responsesUrl,
  apiMode,
  redactHeaders,
  boundedText,
  parseArguments,
  normalizeToolCall,
  normalizeChoice,
  normalizeResponseChoice,
  responseApiTool,
  messagesToResponsesInput,
  toolNames,
  toolOutputText,
  messageContentChars,
  readResponseTextBounded,
  readResponseSseBounded,
  chatToolContinuationMessages,
  compactResponseCompletion,
  mergeStreamToolCall,
};
