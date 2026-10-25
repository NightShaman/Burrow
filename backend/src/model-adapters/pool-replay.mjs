import { chatToolContinuationMessages } from './adapter-primitives.mjs';
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
    if (!message || typeof message !== 'object' || Object.keys(message).some(key => !['role', 'content', 'tool_calls', 'tool_call_id'].includes(key))) fail('nonportable_history');
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
  const complete = chatToolContinuationMessages({ baseMessages: base, toolCalls, toolResults });
  if (!equal(normalizeProviderMessages(preparedMessages), complete)) fail('incomplete_history');
  if (complete.length !== preparedMessages.length) fail('incomplete_history');
  // Whitelist portable provider message grammar; never carry account-bound
  // native tokens, binary/image/file payloads, or arbitrary vendor fields.
  const clean = complete.map(message => {
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role) ||
        Object.keys(message).some(key => !['role', 'content', 'tool_calls', 'tool_call_id'].includes(key))) fail('nonportable_history');
    const content = message.content;
    if (Array.isArray(content) && content.some(part => ['thinking', 'redacted_thinking'].includes(part?.type))) fail('nonportable_history');
    if (typeof content !== 'string' && (!Array.isArray(content) || content.some(part =>
      (part?.type !== 'text' && !(family === 'anthropic' && part?.type === 'tool_use' && typeof part.id === 'string' && typeof part.name === 'string' && part.input && typeof part.input === 'object' && !Array.isArray(part.input))) || (part?.type === 'text' && typeof part.text !== 'string') || Object.keys(part).some(key => !(['type', 'text', ...(family === 'anthropic' && part?.type === 'tool_use' ? ['id', 'name', 'input'] : [])].includes(key)))))) fail('nonportable_history');
    if (typeof content === 'string' && /data:[^\s]+;base64,/i.test(content)) fail('nonportable_history');
    if (message.tool_calls && (!Array.isArray(message.tool_calls) || message.tool_calls.some(call =>
      !call?.id || call.type !== 'function' || !call.function?.name || typeof call.function.arguments !== 'string' ||
      Object.keys(call).some(key => !['id', 'type', 'function'].includes(key)) ||
      Object.keys(call.function).some(key => !['name', 'arguments'].includes(key))))) fail('nonportable_history');
    return { ...message, content };
  });
  // Never pass the old account's native side channel to the new adapter.
  return { ...args, baseMessages: clean.slice(0, base.length), preparedMessages: clean,
    previousModel: { providerPool: previousModel.providerPool } };
}
