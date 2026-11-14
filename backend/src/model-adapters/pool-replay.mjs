import { chatToolContinuationMessages } from './adapter-primitives.mjs';
import { isPreparedPoolReplay } from '../native-continuation-preparation.mjs';
import { normalizeProviderMessages } from '../provider-messages.mjs';

const fail = (reason) => { throw new Error(`provider_pool_replay_${reason}`); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Only the actual adapter's returned request transcript proves what the old
// account saw. A caller-supplied suffix (even a perfectly paired suffix) does
// not prove that earlier rounds or their receipts were retained.
export function portablePoolReplay(args, family) {
  const { previousModel, baseMessages, preparedMessages, toolCalls, toolResults } = args;
  if (previousModel?.nativeTranscriptComplete !== true) fail('incomplete_history');
  if (!Array.isArray(previousModel?.nativeTranscript) || !previousModel.nativeTranscript.length ||
      !Array.isArray(baseMessages) || !baseMessages.length || !Array.isArray(preparedMessages) || !preparedMessages.length ||
      !Array.isArray(toolCalls) || !toolCalls.length || !Array.isArray(toolResults) || toolResults.length !== toolCalls.length) fail('incomplete_history');
  for (const message of [...previousModel.nativeTranscript, ...baseMessages, ...preparedMessages]) {
    if (!message || typeof message !== 'object' || Object.keys(message).some(key => !['role', 'content', 'tool_calls', 'tool_call_id', 'continuationRecap'].includes(key))) fail('nonportable_history');
  }
  const priorCalls = previousModel.choice?.toolCalls;
  if (!Array.isArray(priorCalls) || priorCalls.length !== toolCalls.length ||
      priorCalls.some((call, index) => call?.id !== toolCalls[index]?.id ||
        call?.name !== toolCalls[index]?.name ||
        !equal(call?.arguments ?? {}, toolCalls[index]?.arguments ?? {}) ||
        !equal(call?.rawArguments ?? null, toolCalls[index]?.rawArguments ?? null))) fail('incomplete_history');
  const prior = normalizeProviderMessages(previousModel.nativeTranscript);
  const base = normalizeProviderMessages(baseMessages);
  if (prior.length !== previousModel.nativeTranscript.length || base.length !== baseMessages.length) fail('incomplete_history');
  const pending = family === 'anthropic' && prior.at(-1)?.role === 'assistant' &&
    Array.isArray(prior.at(-1)?.content) && prior.at(-1).content.some(part => part?.type === 'tool_use');
  // The runtime supplies the full Claude transcript, including its pending
  // assistant. Accept only that exact base, never a truncated surrogate.
  if (!equal(base, prior)) fail('incomplete_history');
  if (pending) {
    const ids = prior.at(-1).content.filter(part => part?.type === 'tool_use').map(part => part.id);
    if (!equal(ids, toolCalls.map(call => call.id))) fail('incomplete_history');
  }
  const expected = chatToolContinuationMessages({ baseMessages: base, toolCalls, toolResults });
  const attested = isPreparedPoolReplay(preparedMessages, args);
  if (!attested && !equal(normalizeProviderMessages(preparedMessages), expected)) fail('incomplete_history');
  if (!attested && expected.length !== preparedMessages.length) fail('incomplete_history');
  const complete = attested ? preparedMessages : expected;
  // Whitelist portable provider message grammar; never carry account-bound
  // native tokens, account-bound files, or arbitrary vendor fields.
  const clean = portableReplayMessages(complete, family);
  // Never pass the old account's native side channel to the new adapter.
  return { ...args, baseMessages: clean.slice(0, base.length), preparedMessages: clean,
    previousModel: { providerPool: previousModel.providerPool } };
}

export function portableReplayMessages(messages, family) {
  return messages.map(message => {
    if (!message || typeof message !== 'object') fail('nonportable_history');
    if (Object.hasOwn(message, 'continuationRecap') && message.continuationRecap !== true) fail('nonportable_history');
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role) ||
        Object.keys(message).some(key => !['role', 'content', 'tool_calls', 'tool_call_id', 'continuationRecap'].includes(key))) fail('nonportable_history');
    // Anthropic thinking/signatures are bound to the account that produced
    // them. The proof above compares the ORIGINAL transcript first; only the
    // outbound copy may omit those opaque blocks. Visible text, tool calls and
    // tool receipts retain their order and exact contents.
    const content = family === 'anthropic' && Array.isArray(message.content)
      ? message.content.filter(part => !['thinking', 'redacted_thinking'].includes(part?.type))
      : message.content;
    if (Array.isArray(content) && content.some(part => ['thinking', 'redacted_thinking'].includes(part?.type))) fail('nonportable_history');
    if (Array.isArray(message.content) && message.content.length && !content.length) fail('nonportable_history');
    if (typeof content !== 'string' && (!Array.isArray(content) || content.some(part => !portablePart(part, family)))) fail('nonportable_history');
    if (message.tool_calls && (!Array.isArray(message.tool_calls) || message.tool_calls.some(call =>
      !call?.id || call.type !== 'function' || !call.function?.name || typeof call.function.arguments !== 'string' ||
      Object.keys(call).some(key => !['id', 'type', 'function'].includes(key)) ||
      Object.keys(call.function).some(key => !['name', 'arguments'].includes(key))))) fail('nonportable_history');
    return { role: message.role, content, ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}), ...(message.tool_call_id ? { tool_call_id: message.tool_call_id } : {}) };
  });
}

function onlyKeys(value, keys) {
  return value && typeof value === 'object' && Object.keys(value).every(key => keys.includes(key));
}
function portableImageUrl(url) {
  return typeof url === 'string' && /^(https?:\/\/|data:image\/[^;]+;base64,)/i.test(url);
}
function portablePart(part, family) {
  if (['text', 'input_text', 'output_text'].includes(part?.type)) return onlyKeys(part, ['type', 'text']) && typeof part.text === 'string';
  // Inline bytes and public URLs are self-contained. File IDs and vendor
  // handles are not: never silently omit an image to make replay possible.
  if (part?.type === 'image_url') return onlyKeys(part, ['type', 'image_url']) &&
    onlyKeys(part.image_url, ['url', 'detail']) && portableImageUrl(part.image_url.url);
  if (family === 'anthropic' && part?.type === 'image') return onlyKeys(part, ['type', 'source']) && (
    (onlyKeys(part.source, ['type', 'url']) && part.source.type === 'url' && portableImageUrl(part.source.url)) ||
    (onlyKeys(part.source, ['type', 'media_type', 'data']) && part.source.type === 'base64' && /^image\//.test(part.source.media_type) && typeof part.source.data === 'string'));
  if (part?.type === 'input_image') return onlyKeys(part, ['type', 'image_url', 'detail']) && portableImageUrl(part.image_url);
  if (family === 'anthropic' && part?.type === 'tool_use') return onlyKeys(part, ['type', 'id', 'name', 'input']) &&
    typeof part.id === 'string' && typeof part.name === 'string' && part.input && typeof part.input === 'object' && !Array.isArray(part.input);
  return false;
}

// complete() already submits a full request, not a suffix tied to a response
// ID. Treat that explicit request as the replay boundary, just as for a fresh
// turn, while rejecting opaque native protocol items and unpaired tools.
export function portablePoolComplete(args, family) {
  const messages = args.messages || (typeof args.prompt === 'string' ? [{ role: 'user', content: args.prompt }] : null);
  if (!Array.isArray(messages) || !messages.length) fail('incomplete_history');
  const clean = portableReplayMessages(messages, family);
  const pending = new Set();
  for (const message of clean) {
    if (message.role === 'tool') {
      if (!pending.delete(message.tool_call_id)) fail('incomplete_history');
    } else {
      if (pending.size) fail('incomplete_history');
      const calls = [...(message.tool_calls || []), ...(Array.isArray(message.content) ? message.content.filter(part => part?.type === 'tool_use') : [])];
      for (const call of calls) {
        if (pending.has(call.id)) fail('incomplete_history');
        pending.add(call.id);
      }
    }
  }
  if (pending.size) fail('incomplete_history');
  return { ...args, messages: clean, previousModel: { providerPool: args.previousModel?.providerPool } };
}
