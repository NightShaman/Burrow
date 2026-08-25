import { redactText } from '../redaction.mjs';
import {
  apiMode,
  isChatGptBackendBaseUrl,
  responsesUrl,
  completionUrl,
  toolNames,
  responseApiTool,
  toolOutputText,
  messagesToResponsesInput,
  chatToolContinuationMessages,
  buildProviderMessageManifest,
  messageContentChars,
  serializedMessageHash,
  contextUsageFromRequest,
  contextUsageFromResponse,
  redactHeaders,
  readResponseSseBounded,
  readResponseTextBounded,
  normalizeResponseChoice,
  normalizeChoice,
  boundedText,
  randomUUID,
} from './shared.mjs';

export function createOpenAICompatibleModelAdapter({ config = {}, fetchImpl = globalThis.fetch, clock = () => new Date().toISOString(), idFactory = randomUUID } = {}) {
  if (!fetchImpl) throw new Error('fetch implementation is required');
  const mode = apiMode(config);
  const chatGptBackend = isChatGptBackendBaseUrl(config.baseUrl || config.apiBaseUrl || config.url);
  const url = mode === 'openai-responses' ? responsesUrl(config) : completionUrl(config);
  const model = config.model;
  if (!model) throw new Error('model is required');

  const imageCountFor = (messages = []) => (Array.isArray(messages) ? messages : []).reduce((count, message) => count + (Array.isArray(message?.content) ? message.content.filter((part) => part?.type === 'image_url' || part?.type === 'input_image' || part?.image_url || part?.input_image).length : 0), 0);
  const textPromptCharsFor = (messages = []) => (Array.isArray(messages) ? messages : []).reduce((total, message) => total + (typeof message?.content === 'string' ? message.content.length : (Array.isArray(message?.content) ? message.content.reduce((chars, part) => chars + String(part?.text || '').length, 0) : 0)) + (Array.isArray(message?.tool_calls) ? message.tool_calls.reduce((chars, call) => chars + String(call?.function?.name || '').length + String(call?.function?.arguments || '').length, 0) : 0), 0);

  const buildRequest = ({ prompt, messages, temperature = config.temperature ?? 0.2, maxTokens = config.maxTokens, tools = null, toolChoice = 'auto', toolContinuation = null, streaming = false } = {}) => {
    const resolvedMessages = messages || [{ role: 'user', content: String(prompt || '') }];
    const isToolContinuation = Boolean(toolContinuation?.toolCalls?.length && toolContinuation?.toolResults?.length);
    if (!isToolContinuation && (!resolvedMessages.length || !resolvedMessages.some((message) => message.content))) throw new Error('prompt or messages are required');
    const resolvedTools = Array.isArray(tools) && tools.length ? tools : null;
    const resolvedToolNames = toolNames(resolvedTools);
    const continuationOutput = (toolContinuation?.toolResults || []).map((result, index) => ({
      type: 'function_call_output',
      call_id: toolContinuation?.toolCalls?.[index]?.id || `tool-call-${index}`,
      output: toolOutputText(result),
    }));
    // The runtime prepares native continuation messages against the real
    // provider budget. Preserve that protocol-valid sequence here; direct
    // adapter callers retain the unprepared compatibility construction.
    if (isToolContinuation && mode !== 'openai-responses' && !(Array.isArray(toolContinuation.preparedMessages) && toolContinuation.preparedMessages.length)) {
      throw new Error('native_continuation_preparation_required');
    }
    const providerContinuationMessages = isToolContinuation
      ? (Array.isArray(toolContinuation.preparedMessages) && toolContinuation.preparedMessages.length
        ? toolContinuation.preparedMessages
        : chatToolContinuationMessages({ baseMessages: toolContinuation.baseMessages || resolvedMessages, toolCalls: toolContinuation.toolCalls, toolResults: toolContinuation.toolResults }))
      : null;
    const continuationInput = chatGptBackend
      ? messagesToResponsesInput(providerContinuationMessages)
      : continuationOutput;
    const continuationMessages = isToolContinuation && mode !== 'openai-responses'
      ? providerContinuationMessages
      : null;
    const body = mode === 'openai-responses'
      ? {
          model,
          input: isToolContinuation ? continuationInput : messagesToResponsesInput(messages, prompt),
          ...(!chatGptBackend && isToolContinuation && toolContinuation.previousResponseId ? { previous_response_id: toolContinuation.previousResponseId } : {}),
          ...(chatGptBackend || config.supportsTemperature === false ? {} : { temperature }),
          ...(resolvedTools ? { tools: resolvedTools.map(responseApiTool), tool_choice: toolChoice } : {}),
          ...(maxTokens ? { max_output_tokens: maxTokens } : {}),
          ...(config.extra || {}),
          ...(chatGptBackend ? { store: false } : {}),
          ...(streaming ? { stream: true } : {}),
        }
      : {
          model,
          messages: continuationMessages || resolvedMessages,
          ...(config.supportsTemperature === false ? {} : { temperature }),
          ...(resolvedTools ? { tools: resolvedTools, tool_choice: toolChoice } : {}),
          ...(maxTokens ? { max_tokens: maxTokens } : {}),
          ...(config.extra || {}),
          ...(streaming ? { stream: true } : {}),
        };
    const providerMessages = mode === 'openai-responses' ? body.input : body.messages;
    const stablePrefixMessage = Array.isArray(providerMessages)
      ? providerMessages.find((message) => message?.role === 'system') || providerMessages[0]
      : null;
    const providerMessageCount = Array.isArray(providerMessages) ? providerMessages.length : 1;
    const providerMessageManifest = Array.isArray(providerMessages) ? buildProviderMessageManifest(providerMessages) : [];
    const providerPromptChars = Array.isArray(providerMessages)
      ? textPromptCharsFor(providerMessages)
      : String(providerMessages || '').length;
    const serializedBody = JSON.stringify(body);
    return { body, providerMessages, providerMessageCount, providerMessageManifest, providerPromptChars, serializedBody, resolvedTools, resolvedToolNames, stablePrefixHash: serializedMessageHash(stablePrefixMessage), continuation: isToolContinuation, nativeTranscript: continuationMessages || providerContinuationMessages };
  };

  const estimateRequest = (options = {}) => {
    const request = buildRequest({ ...options, streaming: chatGptBackend || Boolean(options.streaming) });
    return contextUsageFromRequest({ promptChars: request.providerPromptChars, bodyChars: request.serializedBody.length, imageCount: imageCountFor(request.providerMessages), model, api: mode, continuation: request.continuation, modelCall: options.modelCall, clock });
  };

  const complete = async ({ prompt, messages, temperature = config.temperature ?? 0.2, maxTokens = config.maxTokens, tools = null, toolChoice = 'auto', traceLogger, signal = null, toolContinuation = null, onTextDelta = null, onThoughtDelta = null, onContextUsage = null, modelCall = null } = {}) => {
      const requestId = idFactory();
      const headers = {
        'content-type': 'application/json',
        ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
        ...(config.headers || {}),
      };
      const streaming = chatGptBackend || typeof onTextDelta === 'function' || typeof onThoughtDelta === 'function';
      const { body, providerMessages, providerMessageCount, providerMessageManifest, providerPromptChars, serializedBody, resolvedTools, resolvedToolNames, stablePrefixHash, continuation: isToolContinuation, nativeTranscript } = buildRequest({ prompt, messages, temperature, maxTokens, tools, toolChoice, toolContinuation, streaming });
      // Keep a bounded, exact copy of the transmitted provider body for the
      // user-facing context debugger. It lives with the trace rather than in
      // the session transcript, so it cannot become model context itself.
      // Provider bodies contain the complete prompt, including the current operator
      // turn. Persist only a redacted debugger projection; the raw body is sent to
      // the provider but must not become a durable trace artifact.
      const providerRequestArtifact = await traceLogger?.artifact?.(`provider-request-${requestId}.json`, redactText(serializedBody)) || null;
      const requestContextUsage = contextUsageFromRequest({
        promptChars: providerPromptChars,
        bodyChars: serializedBody.length,
        imageCount: imageCountFor(providerMessages),
        model,
        api: mode,
        continuation: isToolContinuation,
        modelCall,
        clock,
      });
      await onContextUsage?.(requestContextUsage);

      await traceLogger?.model?.({
        stage: 'model-request',
        requestId,
        provider: 'openai-compatible',
        api: mode,
        model,
        url,
        headers: redactHeaders(headers),
        messageCount: providerMessageCount,
        promptChars: providerPromptChars,
        bodyChars: serializedBody.length,
        continuation: isToolContinuation,
        toolCount: resolvedToolNames.length,
        toolNames: resolvedToolNames,
        toolChoice: resolvedTools ? toolChoice : null,
        stablePrefixHash,
        providerMessageManifest,
        providerRequestArtifact,
        ts: clock(),
      });

      const response = await fetchImpl(url, { method: 'POST', headers, body: serializedBody, ...(signal ? { signal } : {}) });
      // Some OpenAI-compatible proxies silently ignore `stream: true`. Fall
      // back to their normal JSON response rather than converting a complete
      // answer into an empty streamed one.
      const providerReturnedJson = streaming && /application\/json/i.test(String(response?.headers?.get?.('content-type') || ''));
      const responseBody = streaming && !providerReturnedJson
        ? await readResponseSseBounded(response, { mode, maxBytes: config.maxResponseBytes, onTextDelta, onThoughtDelta })
        : await readResponseTextBounded(response, config.maxResponseBytes);
      const text = responseBody.text || '';
      let data = streaming && !providerReturnedJson ? responseBody.data : null;
      if (!streaming || providerReturnedJson) {
        try {
          data = responseBody.ok ? (text ? JSON.parse(text) : {}) : { error: { message: responseBody.error } };
        } catch {
          data = { raw: text };
        }
      }

      const ok = Boolean(response.ok) && responseBody.ok;
      const result = {
        ok,
        requestId,
        provider: 'openai-compatible',
        api: mode,
        model,
        status: response.status,
        choice: ok ? (mode === 'openai-responses' ? normalizeResponseChoice(data) : normalizeChoice(data)) : null,
        responseId: ok && typeof data?.id === 'string' ? boundedText(data.id, 256) : null,
        usage: data?.usage || null,
        contextUsage: contextUsageFromResponse(requestContextUsage, data?.usage || null, clock),
        error: ok ? null : (responseBody.error || data?.error?.message || data?.message || text.slice(0, 500) || `HTTP ${response.status}`),
        // Provider envelopes can include unbounded vendor-specific fields
        // (reasoning, annotations, debug payloads). Nothing outside this
        // adapter needs them; retaining one turns a compact tool call into a
        // process-lifetime heap resident object. Preserve only a bounded
        // transport receipt, or the explicit error shape expected by callers.
        raw: ok
          ? { responseBytes: responseBody.bytes, ...(streaming ? { streamedTextChars: responseBody.streamedTextChars || 0, streamFallback: providerReturnedJson } : {}) }
          : { error: { message: responseBody.error || data?.error?.message || data?.message || `HTTP ${response.status}`, ...(responseBody.errorDetails ? { details: responseBody.errorDetails } : {}) } },
        // Chat Completions has no server-side previous-response chain. Return
        // this bounded, protocol-native transcript so the caller can append
        // the next call/result pair instead of forgetting prior tool rounds.
        nativeTranscript,
      };

      await onContextUsage?.(result.contextUsage);
      await traceLogger?.model?.({
        stage: 'model-response',
        requestId,
        provider: 'openai-compatible',
        api: mode,
        model,
        status: response.status,
        ok,
        usage: result.usage,
        cachedTokens: result.usage?.prompt_tokens_details?.cached_tokens ?? result.usage?.input_tokens_details?.cached_tokens ?? null,
        stablePrefixHash,
        finishReason: result.choice?.finishReason || null,
        responseChars: result.choice?.text?.length || 0,
        responseBytes: responseBody.bytes,
        streamed: streaming && !providerReturnedJson,
        streamFallback: providerReturnedJson,
        streamedTextChars: responseBody.streamedTextChars || 0,
        error: result.error,
        ...(responseBody.errorDetails ? { errorDetails: responseBody.errorDetails } : {}),
        ts: clock(),
      });

      return result;
    };

  return {
    provider: 'openai-compatible',
    api: mode,
    model,
    url,
    supportsVision: Boolean(config.supportsVision || config.vision || config.multimodal || config.capabilities?.vision || config.capabilities?.images),
    estimateRequest,
    complete,
    async continueWithToolResults({ previousModel = null, baseMessages = [], toolCalls = [], toolResults = [], preparedMessages = null, ...options } = {}) {
      return complete({
        ...options,
        toolContinuation: {
          previousResponseId: previousModel?.responseId || null,
          baseMessages,
          toolCalls,
          toolResults,
          preparedMessages,
        },
      });
    },
  };
}


