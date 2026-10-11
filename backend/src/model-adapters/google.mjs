import { redactStructuredJsonText } from '../redaction.mjs';
import { buildProviderMessageManifest } from './adapter-primitives.mjs';
import { randomUUID, normalizeProviderMessages, normalizeToolCall, toolOutputText, contextUsageFromRequest, contextUsageFromResponse, readResponseTextBounded, DEFAULT_MAX_RESPONSE_BYTES } from './adapter-primitives.mjs';
import { googleNativeBase, googleNativeHeaders, googleModelId } from './google-native-catalog.mjs';
import { invokeProviderFetch, providerTiming, flushProviderDiagnostics } from './provider-fetch.mjs';

function partsFor(content) {
  if (!Array.isArray(content)) return content ? [{ text: String(content) }] : [];
  return content.map(p => {
    if (p.type === 'google_part') return p.part;
    if (p.type === 'text') return { text: p.text || '' };
    if (p.type === 'image_url') {
      const m = /^data:([^;]+);base64,(.+)$/s.exec(p.image_url?.url || '');
      if (m) return { inlineData: { mimeType: m[1], data: m[2] } };
    }
    throw new Error('google_content_part_unsupported');
  });
}
export function googleContents(messages) {
  const system = [], contents = [], calls = new Map();
  for (const m of messages) {
    if (['system','developer'].includes(m.role)) { system.push(...partsFor(m.content)); continue; }
    let parts;
    if (m.role === 'tool') {
      const call = calls.get(m.tool_call_id);
      if (!call) throw new Error('google_tool_result_unpaired');
      let output; try { output = JSON.parse(m.content); } catch { output = { result: m.content }; }
      parts = [{ functionResponse: { name: call.name, ...(call.nativeId ? { id: call.nativeId } : {}), response: output && typeof output === 'object' && !Array.isArray(output) ? output : { result: output } } }];
    } else {
      parts = partsFor(m.content);
      const matchedParts = new Set();
      for (const c of m.tool_calls || []) {
        const fn = c.function || c;
        // Match explicit IDs before positional ID-less calls, consuming each
        // native part once even when parallel calls share a function name.
        const native = parts.find(p => !matchedParts.has(p) && p.functionCall?.name === fn.name && p.functionCall.id === c.id)
          || parts.find(p => !matchedParts.has(p) && p.functionCall?.name === fn.name && !p.functionCall.id);
        if (native) matchedParts.add(native);
        let args; try { args = typeof fn.arguments === 'string' ? JSON.parse(fn.arguments) : fn.arguments || {}; } catch { throw new Error('google_tool_arguments_invalid'); }
        calls.set(c.id, { name: fn.name, nativeId: native?.functionCall?.id });
        if (!native) parts.push({ functionCall: { name: fn.name, args } });
      }
    }
    if (parts.length) {
      const role = m.role === 'assistant' ? 'model' : 'user';
      // Parallel function responses belong in one user turn.
      if (m.role === 'tool' && contents.at(-1)?.role === 'user' && contents.at(-1).parts.every(p => p.functionResponse)) contents.at(-1).parts.push(...parts);
      else contents.push({ role, parts });
    }
  }
  return { contents, ...(system.length ? { systemInstruction: { parts: system } } : {}) };
}
// Native SSE is GenerateContentResponse per data event, not OpenAI deltas.
export async function readGoogleSse(response, { maxBytes = DEFAULT_MAX_RESPONSE_BYTES, onTextDelta, onThoughtDelta } = {}) {
  const parts = []; let carry = '', bytes = 0, finishReason = null, usageMetadata = null, saw = false;
  const consume = async (chunk, final = false) => {
    carry += chunk;
    carry = carry.replace(/\r\n/g, '\n');
    let index;
    while ((index = carry.indexOf('\n\n')) >= 0 || (final && carry)) {
      const event = index >= 0 ? carry.slice(0,index) : carry;
      carry = index >= 0 ? carry.slice(index+2) : '';
      const payload = event.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (!payload) continue;
      const data = JSON.parse(payload); saw = true;
      if (data.error) throw new Error('google_stream_provider_error');
      const c = data.candidates?.[0];
      for (const part of c?.content?.parts || []) {
        parts.push(part);
        if (part.text) await (part.thought ? onThoughtDelta : onTextDelta)?.({ delta: part.text });
      }
      finishReason = c?.finishReason || finishReason;
      usageMetadata = data.usageMetadata || usageMetadata;
    }
  };
  if (response.body?.getReader) {
    const reader = response.body.getReader(), decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new Error('provider_response_too_large');
        await consume(decoder.decode(value, { stream: true }));
      }
      await consume(decoder.decode(), true);
    } catch (error) { await reader.cancel().catch(() => {}); throw error; }
    finally { reader.releaseLock(); }
  } else {
    const text = await response.text(); bytes = Buffer.byteLength(text);
    if (bytes > maxBytes) throw new Error('provider_response_too_large');
    await consume(text, true);
  }
  if (!saw || !finishReason) throw new Error('google_stream_truncated');
  return { candidates: [{ content: { role: 'model', parts }, finishReason }], usageMetadata };
}
export function createGoogleNativeModelAdapter({ config = {}, fetchImpl = fetch, clock = () => new Date().toISOString(), idFactory = randomUUID } = {}) {
  const base = googleNativeBase(config), headers = googleNativeHeaders(config), model = googleModelId(config.model), api = 'google-generative-language';
  if (!model) throw new Error('model is required');
  if (config.supportedGenerationMethods && !config.supportedGenerationMethods.includes('generateContent')) throw new Error('google_chat_method_unsupported');
  const url = `${base}/models/${encodeURIComponent(model)}:generateContent`;
  const build = ({ prompt, messages, tools, maxTokens = config.maxTokens, temperature = config.temperature } = {}) => {
    const source = normalizeProviderMessages(messages?.length ? messages : [{ role: 'user', content: prompt || '' }]);
    const body = { ...googleContents(source), generationConfig: { ...(maxTokens ? { maxOutputTokens: maxTokens } : {}), ...(temperature !== undefined ? { temperature } : {}) } };
    if (tools?.length) body.tools = [{ functionDeclarations: tools.map(t => { const f=t.function || t; return { name: f.name, description: f.description || '', parametersJsonSchema: f.parameters || t.inputSchema || { type: 'object', properties: {} } }; }) }];
    return { body, source };
  };
  const estimateRequest = options => { const {body}=build(options); const chars=JSON.stringify(body).length; return contextUsageFromRequest({ promptChars:chars, bodyChars:chars, model, api, clock }); };
  const complete = async (options = {}) => {
    const requestId = idFactory(), { traceLogger, signal, onTextDelta, onThoughtDelta, onContextUsage, modelCall } = options;
    const timing = providerTiming({ traceLogger, requestId, provider:'google', api, model, modelCall, clock });
    try {
      const {body,source} = build(options), requestContext = estimateRequest(options);
      await onContextUsage?.(requestContext);
      const streaming = typeof onTextDelta === 'function' || typeof onThoughtDelta === 'function';
      const diagnosticBody = JSON.parse(JSON.stringify(body, (key,value) => key==='thoughtSignature' ? '[redacted]' : value));
      for (const content of diagnosticBody.contents) for (const part of content.parts) if (part.thought && part.text) part.text='[redacted]';
      const providerRequestArtifact = await traceLogger?.artifact?.(`provider-request-${requestId}.json`, redactStructuredJsonText(JSON.stringify(diagnosticBody))) || null;
      await traceLogger?.model?.({ stage:'model-request', requestId, provider:'google', api, model, modelCall, url, providerRequestArtifact, providerMessageManifest:buildProviderMessageManifest(source), messageCount:body.contents.length, bodyChars:JSON.stringify(body).length, ts:clock() });
      const response = await invokeProviderFetch(fetchImpl, streaming ? url.replace(':generateContent', ':streamGenerateContent?alt=sse') : url, { method:'POST', headers, body:JSON.stringify(body), ...(signal ? { signal } : {}) }, { traceLogger, requestId, provider:'google', api, model, modelCall, clock, timing });
      let data;
      if (response.ok && streaming) data = await readGoogleSse(response, { maxBytes: config.maxResponseBytes, onTextDelta:timing.wrap(onTextDelta,'text'), onThoughtDelta:timing.wrap(onThoughtDelta,'thought') });
      else { const bounded = await readResponseTextBounded(response, config.maxResponseBytes); if (!bounded.ok) throw new Error(bounded.error); try { data=JSON.parse(bounded.text); } catch { throw new Error('google_response_invalid_json'); } }
      const candidate = data.candidates?.[0], parts = candidate?.content?.parts || [], calls = parts.filter(p => p.functionCall).map((p,i) => normalizeToolCall({ id:p.functionCall.id || `google-call-${requestId}-${i}`, name:p.functionCall.name, arguments:p.functionCall.args },i));
      const text = parts.filter(p => !p.thought).map(p => p.text || '').join('');
      const ok = response.ok && !data.error && candidate?.finishReason === 'STOP' && (text.length > 0 || calls.length > 0);
      const assistant = { role:'assistant', content:parts.map(part => ({ type:'google_part', part })), ...(calls.length ? { tool_calls:calls.map(c => ({ id:c.id, type:'function', function:{ name:c.name, arguments:c.rawArguments } })) } : {}) };
      const usage = data.usageMetadata ? { prompt_tokens:data.usageMetadata.promptTokenCount, completion_tokens:data.usageMetadata.candidatesTokenCount, total_tokens:data.usageMetadata.totalTokenCount, prompt_tokens_details:{ cached_tokens:data.usageMetadata.cachedContentTokenCount || 0 } } : null;
      const contextUsage = contextUsageFromResponse(requestContext, usage, clock);
      await onContextUsage?.(contextUsage);
      await traceLogger?.model?.({ stage:'model-response', requestId, provider:'google', api, model, modelCall, status:response.status, ok, usage, finishReason:candidate?.finishReason || null, responseChars:text.length, streamed:streaming, ts:clock() });
      return { ok, requestId, provider:'google', api, model, status:response.status, choice:{ index:0, finishReason:candidate?.finishReason, text, message:{ role:'assistant', content:text }, toolCalls:calls }, usage, contextUsage, error:ok ? null : `google_generation_failed:${response.status}:${candidate?.finishReason || 'no_candidate'}`, raw:{ usageMetadata:data.usageMetadata }, nativeTranscript:[...source,...(parts.length ? [assistant] : [])] };
    } finally { await flushProviderDiagnostics(traceLogger); }
  };
  return { provider:'google', api, model, url, supportsVision:config.supportsVision === true || config.capabilities?.images === true, estimateRequest, complete,
    async continueWithToolResults({ previousModel, baseMessages=[], preparedMessages, toolCalls=[], toolResults=[], ...options } = {}) {
      let transcript = [...(preparedMessages?.length ? preparedMessages : baseMessages)];
      const pending = previousModel?.nativeTranscript?.at(-1);
      // Generic preparation can synthesize an unsigned call shell. Replace it
      // with the provider-native persisted sequence; signatures are opaque.
      const ids = new Set(toolCalls.map(c => c.id));
      const index = transcript.findIndex(m => m.role==='assistant' && m.tool_calls?.some(c => ids.has(c.id)));
      if (pending?.role==='assistant' && pending.tool_calls?.some(c => ids.has(c.id))) {
        if (index >= 0) transcript[index]=pending; else transcript.push(pending);
        transcript = transcript.filter((m,i) => i===index || m===pending || !(m.role==='assistant' && m.tool_calls?.some(c => ids.has(c.id))));
      }
      for (const [i,call] of toolCalls.entries()) if (!transcript.some(m => m.role==='tool' && m.tool_call_id===call.id)) transcript.push({ role:'tool', tool_call_id:call.id, content:toolOutputText(toolResults[i]) });
      if (config.contextTokens || config.contextWindow) {
        const estimate = estimateRequest({ ...options, messages:transcript });
        if (estimate.estimatedTokens > (config.contextTokens || config.contextWindow)) throw new Error('context_preparation_prompt_over_budget');
      }
      return complete({ ...options, messages:transcript });
    } };
}
