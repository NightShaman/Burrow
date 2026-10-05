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
// Match the adapter transport budget rather than silently clipping successful
// model generations at 64K characters (notably JSON accounts from mods).
const MAX_MODEL_TEXT_CHARS = DEFAULT_MAX_RESPONSE_BYTES;
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

function jsonText(value) {
  return JSON.stringify(value);
}

function parseArguments(value) {
  if (value && typeof value === 'object') return value;
  if (!value || typeof value !== 'string') return {};
  try { return JSON.parse(value); } catch { return {}; }
}

function normalizeToolCall(call = {}, index = 0) {
  const fn = call.function || call;
  const name = fn.name || call.name || null;
  const rawArguments = fn.arguments ?? call.arguments ?? {};
  const rawArgumentText = typeof rawArguments === 'string'
    ? rawArguments
    : jsonText(rawArguments);
  return {
    id: boundedText(call.id || call.call_id || `tool-call-${index}`, 256),
    type: boundedText(call.type || 'function', 64),
    name: boundedText(name, 256) || null,
    ...(call.providerItemId ? { providerItemId: boundedText(call.providerItemId, 256) } : {}),
    arguments: parseArguments(rawArguments),
    rawArguments: rawArgumentText,
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
  for (const key of ['tool', 'ok', 'error', 'filePath', 'path', 'dirPath', 'command', 'query', 'pattern', 'id', 'resultCount', 'contentHash', 'resultFingerprint', 'truncated', 'entryBudgetExhausted', 'depthTruncated', 'incomplete', 'durationMs']) {
    const value = result?.[key];
    if (value === null || typeof value === 'boolean' || typeof value === 'number') receipt[key] = value;
    else if (typeof value === 'string') receipt[key] = truncatedNativeText(value, 1_000);
  }
  if (Array.isArray(result.warnings)) receipt.warnings = result.warnings.filter(value => typeof value === 'string');
  // Preserve compact execution origin and correlation so observations from
  // different hosts/runs remain distinguishable on the provider wire.
  if (result?.execution && typeof result.execution === 'object') {
    const execution = result.execution;
    receipt.execution = {
      ...(typeof execution.kind === 'string' ? { kind: execution.kind } : {}),
      ...(typeof execution.providerId === 'string' ? { providerId: truncatedNativeText(execution.providerId, 120) } : {}),
      ...(typeof execution.targetId === 'string' ? { targetId: truncatedNativeText(execution.targetId, 240) } : {}),
      ...(typeof execution.parentRunId === 'string' ? { parentRunId: truncatedNativeText(execution.parentRunId, 240) } : {}),
      ...(typeof execution.toolCallId === 'string' ? { toolCallId: truncatedNativeText(execution.toolCallId, 240) } : {}),
      ...(typeof execution.operationId === 'string' ? { operationId: truncatedNativeText(execution.operationId, 240) } : {}),
    };
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
  // Forge already returns public catalog/job/attachment records. Preserve the
  // declared payload through the final provider wire boundary, not only the
  // durable receipt summary. Provider-budget preparation owns any projection.
  const forgeFields = {
    forge_catalog: ['models', 'music', 'video', 'sourceAttachments'],
    forge_create_job: ['job', 'replayed'],
    forge_list_jobs: ['jobs'],
    forge_inspect_job: ['job'],
    forge_attach_artifact: ['attachment'],
  };
  for (const key of forgeFields[result?.tool] || []) {
    if (result[key] !== undefined) receipt[key] = result[key];
  }
  // Explicit handoff reads must deliver their body, not just a success flag.
  // The store bounds records; provider-budget preparation owns any projection.
  if (result?.tool === 'session_read_handoff') receipt.handoff = result.handoff ?? null;
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
  if (result?.tool === 'attachment_view' && result?.attachment && typeof result.attachment === 'object') {
    const attachment = result.attachment;
    receipt.attachment = {
      id: typeof attachment.id === 'string' ? attachment.id : null,
      name: typeof attachment.name === 'string' ? attachment.name : null,
      type: typeof attachment.type === 'string' ? attachment.type : null,
      size: Number.isFinite(Number(attachment.size)) ? Number(attachment.size) : null,
      kind: typeof attachment.kind === 'string' ? attachment.kind : null,
      ...(typeof attachment.text === 'string' ? { text: attachment.text } : {}),
    };
  }
  // These are explicit tool-returned evidence collections. Preserve them whole
  // until provider-budget preparation projects them with truthful coverage.
  if (Array.isArray(result?.paths)) receipt.paths = result.paths;
  if (Array.isArray(result?.entries)) receipt.entries = result.entries;
  if (Array.isArray(result?.matches)) receipt.matches = result.matches;
  if (Array.isArray(result?.tasks)) receipt.tasks = result.tasks;
  if (Array.isArray(result?.providers)) receipt.providers = result.providers;
  if (Array.isArray(result?.tools) && result?.tool === 'mcp_capabilities') receipt.tools = result.tools;
  // Capability and task-board results are selected evidence. Preserve the
  // selected records until continuation preparation applies its actual model
  // budget; shaping or clipping them here silently presents partial results as
  // complete collections.
  if (Array.isArray(result?.skills) && result?.tool === 'list_skills') receipt.skills = result.skills;
  if (result?.skill && typeof result.skill === 'object' && result?.tool === 'load_skill') receipt.skill = result.skill;
  for (const key of ['provider', 'nextCursor']) if (typeof result?.[key] === 'string') receipt[key] = result[key];
  for (const key of ['totalCount']) if (typeof result?.[key] === 'number') receipt[key] = result[key];
  if (result?.task && typeof result.task === 'object') receipt.task = result.task;
  if (result?.artifacts && typeof result.artifacts === 'object') receipt.artifacts = result.artifacts;
  // Native result contracts, not arbitrary runtime objects. These fields are
  // already tool-selected public evidence; retain them without a second size
  // policy. prepareNativeToolContinuation owns the actual provider budget.
  const nativeFields = {
    scheduled_jobs_list: ['jobs'],
    scheduled_jobs_read: ['job'],
    scheduled_jobs_create: ['job'],
    scheduled_jobs_update: ['job'],
    scheduled_jobs_delete: ['job'],
    scheduled_job_runs: ['job', 'runs'],
    scheduled_jobs_run_now: ['job', 'run'],
    memory_working_search: ['project', 'agentId', 'results'],
    memory_rolling_search: ['project', 'agentId', 'owner', 'entersPrompt', 'results'],
    memory_working_write: ['record'],
    agent_update_tools_profile: ['document'],
    session_write_handoff: ['handoff'],
    files_read: ['encoding', 'bytes', 'modifiedAt', 'offsetBytes', 'returnedBytes', 'nextOffsetBytes'],
    files_write: ['encoding', 'created', 'overwrote', 'bytesWritten'],
    files_edit: ['replaced', 'changedFiles'],
    files_patch: ['touchedFiles', 'changedFiles', 'sideEffectsApplied', 'failureClass', 'gitApplyExitCode'],
    files_inspect: ['exists', 'type', 'size', 'modifiedAt', 'symlinkTarget'],
    shell_exec: ['cwd', 'exitCode', 'signal', 'timedOut', 'cancelled', 'killed', 'stdoutTruncated', 'stderrTruncated', 'stdoutOriginalChars', 'stderrOriginalChars'],
    git_status: ['exitCode'],
    git_diff: ['exitCode'],
    spawn_subagent: ['changedFiles', 'sideEffectsApplied', 'status', 'spawned', 'reused', 'evidence', 'blockers', 'verification', 'verificationTarget', 'childRun', 'target', 'childSessionId'],
    finish_subagent: ['status', 'verification', 'blockers'],
  };
  for (const key of nativeFields[result?.tool] || []) {
    if (result[key] !== undefined) receipt[key] = result[key];
  }
  return receipt;
}

function toolOutputContent(result = {}) {
  // Tool-result transport must remain textual. Chat Completions tool messages
  // are text-only in practice, and Responses function_call_output must not be
  // handed Chat-style image_url parts. Image bytes are carried in an adjacent
  // provider-native user message built by attachmentViewUserMessage().
  return JSON.stringify(nativeToolReceipt(result));
}

function toolOutputText(result = {}) {
  return toolOutputContent(result);
}

function attachmentViewUserMessage(result = {}, call = {}, index = 0) {
  const attachment = result?.attachment;
  if (result?.tool !== 'attachment_view' || !result?.ok || attachment?.kind !== 'image' || !attachment?.dataUrl) return null;
  const callId = String(call?.id || call?.call_id || `tool-call-${index}`).slice(0, 256);
  const name = typeof attachment.name === 'string' ? attachment.name : 'attachment';
  const type = typeof attachment.type === 'string' ? attachment.type : 'image';
  const id = typeof attachment.id === 'string' ? attachment.id : (typeof result.attachmentId === 'string' ? result.attachmentId : null);
  return {
    role: 'user',
    content: [
      { type: 'text', text: `Attachment image from attachment_view result for tool_call_id ${callId}: ${name}${id ? ` (${id})` : ''}, ${type}. Use this image with the preceding tool receipt.` },
      { type: 'image_url', image_url: { url: String(attachment.dataUrl) } },
    ],
    metadata: { providerMessageSource: 'attachment-view-image' },
  };
}

function nativeToolCall(call = {}, index = 0) {
  const rawArguments = typeof call?.rawArguments === 'string'
    ? call.rawArguments
    : jsonText(call?.arguments ?? {});
  return {
    id: boundedText(call?.id || `tool-call-${index}`, 256),
    type: 'function',
    function: {
      name: boundedText(call?.name, 256),
      arguments: rawArguments,
    },
  };
}

function nativeToolRound({ toolCalls = [], toolResults = [] } = {}) {
  const calls = (toolCalls || []).map(nativeToolCall).map((call) => ({
    id: call.id,
    name: call.function.name,
    rawArguments: call.function.arguments,
  }));
  const round = providerToolRound({
    toolCalls: calls,
    toolResults,
    toolResultContent: toolOutputContent,
  });
  if (!round.length) return round;
  const expanded = [];
  let toolIndex = 0;
  for (const message of round) {
    expanded.push(message);
    if (message?.role !== 'tool') continue;
    const imageMessage = attachmentViewUserMessage((toolResults || [])[toolIndex], calls[toolIndex], toolIndex);
    toolIndex += 1;
    if (imageMessage) expanded.push(imageMessage);
  }
  return normalizeProviderMessages(expanded);
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

async function readResponseBytesBounded(response, maxBytes = DEFAULT_MAX_RESPONSE_BYTES) {
  const limit = Math.max(1, Math.floor(Number(maxBytes) || DEFAULT_MAX_RESPONSE_BYTES));
  const contentLength = Number(response?.headers?.get?.('content-length') || 0);
  if (Number.isFinite(contentLength) && contentLength > limit) {
    await response?.body?.cancel?.();
    return { ok: false, data: Buffer.alloc(0), bytes: contentLength, error: `model_response_too_large:${contentLength}>${limit}` };
  }
  const reader = response?.body?.getReader?.();
  if (!reader) {
    // Compatibility fallback for mock/custom fetch implementations. Native
    // fetch responses use the stream branch above, which is the hard limit.
    const data = typeof response.arrayBuffer === 'function' ? Buffer.from(await response.arrayBuffer()) : Buffer.from(await response.text());
    const bytes = data.length;
    return bytes > limit
      ? { ok: false, data: Buffer.alloc(0), bytes, error: `model_response_too_large:${bytes}>${limit}` }
      : { ok: true, data, bytes, error: null };
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
        return { ok: false, data: Buffer.alloc(0), bytes, error: `model_response_too_large:${bytes}>${limit}` };
      }
      chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return { ok: true, data: Buffer.concat(chunks), bytes, error: null };
}
async function readResponseTextBounded(response, maxBytes) {
  const result = await readResponseBytesBounded(response, maxBytes);
  return { ...result, text: result.data.toString('utf8') };
}



export { randomUUID, normalizeProviderMessage, normalizeProviderMessages, buildProviderMessageManifest, providerToolRound, pruneProviderToolResults };
export {
  DEFAULT_MAX_RESPONSE_BYTES,
  MAX_MODEL_TEXT_CHARS,
  MAX_SSE_CARRY_CHARS,
  MAX_SSE_EVENT_CHARS,
  contextUsageFromRequest,
  contextUsageFromResponse,
  trimSlash,
  serializedMessageHash,
  redactHeaders,
  boundedText,
  jsonText,
  parseArguments,
  normalizeToolCall,
  toolOutputText,
  toolOutputContent,
  attachmentViewUserMessage,
  messageContentChars,
  readResponseTextBounded,
  readResponseBytesBounded,
  chatToolContinuationMessages,
};
