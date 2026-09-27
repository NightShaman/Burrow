import { DEFAULT_MAX_RESPONSE_BYTES, MAX_MODEL_TEXT_CHARS, MAX_SSE_CARRY_CHARS, MAX_SSE_EVENT_CHARS, boundedText, normalizeToolCall, jsonText } from './adapter-primitives.mjs';
import { isGoogleOpenAICompatible } from './google-wire.mjs';
function trimSlash(value) { return String(value || '').replace(/\/+$/, ''); }
export function isChatGptBackendBaseUrl(value) { const raw=trimSlash(value); if (!raw) return false; try { const url=new URL(raw); const pathname=url.pathname.replace(/\/+$/,''); return url.hostname.toLowerCase()==='chatgpt.com' && ['/backend-api','/backend-api/v1','/backend-api/codex','/backend-api/codex/v1'].includes(pathname); } catch { return false; } }
function codexResponsesUrl(baseUrl) { const url=new URL(trimSlash(baseUrl)); url.pathname='/backend-api/codex/responses'; url.search=''; url.hash=''; return url.toString(); }
export function completionUrl(config={}) { const baseUrl=trimSlash(config.baseUrl||config.apiBaseUrl||config.url); if(!baseUrl) throw new Error('model baseUrl is required'); if(isChatGptBackendBaseUrl(baseUrl)) return codexResponsesUrl(baseUrl); if(config.chatCompletionsPath) return `${baseUrl}/${String(config.chatCompletionsPath).replace(/^\/+/, '')}`; if(baseUrl.endsWith('/chat/completions')) return baseUrl; if(baseUrl.endsWith('/v1')||(isGoogleOpenAICompatible(config)&&baseUrl.endsWith('/openai'))) return `${baseUrl}/chat/completions`; return `${baseUrl}/v1/chat/completions`; }
export function responsesUrl(config={}) { const baseUrl=trimSlash(config.baseUrl||config.apiBaseUrl||config.url); if(!baseUrl) throw new Error('model baseUrl is required'); if(isChatGptBackendBaseUrl(baseUrl)) return codexResponsesUrl(baseUrl); if(config.responsesPath) return `${baseUrl}/${String(config.responsesPath).replace(/^\/+/, '')}`; if(baseUrl.endsWith('/responses')) return baseUrl; if(baseUrl.endsWith('/v1')||(isGoogleOpenAICompatible(config)&&baseUrl.endsWith('/openai'))) return `${baseUrl}/responses`; return `${baseUrl}/v1/responses`; }
export function apiMode(config={}) { const requested=config.api||config.mode||'openai-chat-completions'; return isChatGptBackendBaseUrl(config.baseUrl||config.apiBaseUrl||config.url)?'openai-responses':requested; }
export { trimSlash };


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
    toolCalls: (choice?.message?.tool_calls || []).map(normalizeToolCall),
  };
}

function textFromResponses(data = {}) {
  if (typeof data.output_text === 'string') return boundedText(data.output_text, MAX_MODEL_TEXT_CHARS);
  const chunks = [];
  let remaining = MAX_MODEL_TEXT_CHARS;
  for (const item of (data.output || [])) {
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
    .map(normalizeToolCall);
}

function compactResponseToolOutput(output = []) {
  if (!Array.isArray(output)) return [];
  return output
    .filter((item) => item?.type === 'function_call' || item?.type === 'tool_call')
    .map((item, index) => ({
      type: item.type === 'tool_call' ? 'tool_call' : 'function_call',
      id: boundedText(item.call_id || item.id || `tool-call-${index}`, 256),
      call_id: boundedText(item.call_id || item.id || `tool-call-${index}`, 256),
      providerItemId: boundedText(item.id || item.call_id || `tool-call-${index}`, 256),
      name: boundedText(item.name || item.function?.name, 256),
      arguments: typeof item.arguments === 'string' ? item.arguments : jsonText(item.arguments ?? item.function?.arguments ?? {}),
    }));
}

function mergeResponseFunctionCall(calls, fragment = {}) {
  const outputIndex = Number.isInteger(fragment.output_index) ? fragment.output_index : Number.isInteger(fragment.index) ? fragment.index : calls.length;
  if (outputIndex < 0) return false;
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
      for (const call of message.tool_calls) {
        const fn = call.function || call;
        input.push({
          type: 'function_call',
          call_id: String(call.id || call.call_id || `tool-call-${input.length}`).slice(0, 256),
          name: String(fn.name || call.name || '').slice(0, 256),
          arguments: typeof fn.arguments === 'string' ? fn.arguments : jsonText(fn.arguments ?? call.arguments ?? {}),
        });
      }
      continue;
    }
    if (message?.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: String(message.tool_call_id || message.id || `tool-call-${input.length}`).slice(0, 256),
        output: typeof message.content === 'string' ? message.content : JSON.stringify(message.content || ''),
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
  return index < 0 ? `model_tool_call_index_invalid:${index}` : null;
}

function responseFunctionCallFailure(calls, fragment = {}) {
  const outputIndex = Number.isInteger(fragment.output_index) ? fragment.output_index : Number.isInteger(fragment.index) ? fragment.index : calls.length;
  return outputIndex < 0 ? `model_tool_call_index_invalid:${outputIndex}` : null;
}

function mergeStreamToolCall(calls, fragment = {}) {
  const index = Number.isInteger(fragment.index) ? fragment.index : calls.length;
  if (index < 0) return false;
  const prior = calls[index] || { id: null, type: 'function', function: { name: null, arguments: '' } };
  const argumentFragment = String(fragment.function?.arguments || '');
  const priorArguments = String(prior.function?.arguments || '');
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
        recordToolCallFailure(responseFunctionCallFailure(responseToolCalls, event));
        if (!toolCallFailure && !mergeResponseFunctionCall(responseToolCalls, event)) recordToolCallFailure('model_tool_call_invalid');
      }
      if (event?.type === 'response.function_call_arguments.delta') {
        recordToolCallFailure(responseFunctionCallFailure(responseToolCalls, event));
        if (!toolCallFailure && !mergeResponseFunctionCall(responseToolCalls, event)) recordToolCallFailure('model_tool_call_invalid');
      }
      if (event?.type === 'response.function_call_arguments.done') {
        recordToolCallFailure(responseFunctionCallFailure(responseToolCalls, event));
        if (!toolCallFailure && !mergeResponseFunctionCall(responseToolCalls, event)) recordToolCallFailure('model_tool_call_invalid');
      }
      if (event?.type === 'response.completed' && event.response && typeof event.response === 'object') {
        finalData = compactResponseCompletion(event.response);
        usage = finalData.usage || usage;
        if (!text && finalData.output_text) await emit(finalData.output_text);
        for (const call of (finalData.output || [])) {
          const outputIndex = responseToolCalls.length;
          responseToolCalls[outputIndex] ||= call;
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
      recordToolCallFailure(streamToolCallFailure(toolCalls, call));
      if (!toolCallFailure && !mergeStreamToolCall(toolCalls, call)) recordToolCallFailure('model_tool_call_invalid');
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


export { normalizeChoice, normalizeResponseChoice, responseApiTool, messagesToResponsesInput, toolNames, readResponseSseBounded, compactResponseCompletion, mergeStreamToolCall };
