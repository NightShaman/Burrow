// Canonical request-local message normalization. Persisted transcript records and
// prompt sections never go straight to a provider adapter without crossing this
// boundary. Keep dialogue roles meaningful; provenance belongs in receipts, not
// in fake `user:` / `assistant:` content prefixes.
import { createHash } from 'node:crypto';

const PROVIDER_ROLES = new Set(['system', 'developer', 'user', 'assistant', 'tool']);
const PREVIEW_CHARS = 240;

function hash(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function content(value) {
  if (Array.isArray(value)) return value;
  return text(value);
}

export function normalizeProviderMessage(message = {}) {
  const role = message.role === 'agent' ? 'assistant' : String(message.role || '');
  if (!PROVIDER_ROLES.has(role)) return null;
  const normalizedContent = content(message.content);
  if (!normalizedContent && role !== 'assistant' && role !== 'tool') return null;
  const normalized = { role, content: normalizedContent };
  if (message?.metadata?.providerMessageSource) {
    Object.defineProperty(normalized, 'metadata', {
      value: { providerMessageSource: String(message.metadata.providerMessageSource) },
      enumerable: false,
    });
  }
  if (role === 'tool' && message.tool_call_id) normalized.tool_call_id = String(message.tool_call_id).slice(0, 256);
  if (role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) normalized.tool_calls = message.tool_calls;
  return normalized;
}

export function normalizeProviderMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .map(normalizeProviderMessage)
    .filter(Boolean);
}

// A tool round is indivisible protocol. Callers may bound or summarize the
// result content, but they must never retain the assistant call without its
// corresponding tool output in a provider request.
export function providerToolRound({ toolCalls = [], toolResults = [], toolResultContent = () => '' } = {}) {
  const calls = (Array.isArray(toolCalls) ? toolCalls : []).map((call, index) => ({
    id: String(call?.id || `tool-call-${index}`).slice(0, 256),
    type: 'function',
    function: {
      name: String(call?.name || '').slice(0, 256),
      arguments: typeof call?.rawArguments === 'string' ? call.rawArguments : JSON.stringify(call?.arguments || {}),
    },
  }));
  if (!calls.length) return [];
  return normalizeProviderMessages([
    { role: 'assistant', content: '', tool_calls: calls },
    ...calls.map((call, index) => ({
      role: 'tool',
      tool_call_id: call.id,
      content: toolResultContent((toolResults || [])[index], index),
    })),
  ]);
}

function renderedContent(value) {
  return typeof value === 'string'
    ? value
    : Array.isArray(value)
      ? value.map((part) => part?.text || `[${part?.type || 'content'}]`).join('')
      : String(value || '');
}

function toolRoundStarts(messages = []) {
  return messages.reduce((starts, message, index) => {
    if (message?.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) starts.push(index);
    return starts;
  }, []);
}

function toolRoundChars(round = []) {
  return round.reduce((sum, message) => {
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    const callChars = calls.reduce((callSum, call) => callSum + String(call?.function?.name || '').length + String(call?.function?.arguments || '').length, 0);
    return sum + renderedContent(message?.content).length + callChars;
  }, 0);
}

function compactReceiptFact(round = []) {
  const calls = round.find((message) => message?.role === 'assistant' && Array.isArray(message.tool_calls))?.tool_calls || [];
  const results = round.filter((message) => message?.role === 'tool');
  return calls.map((call, index) => {
    const result = results[index];
    const resultText = renderedContent(result?.content).replace(/\s+/g, ' ').trim();
    const name = String(call?.function?.name || 'tool').slice(0, 120);
    const callId = String(call?.id || result?.tool_call_id || '').slice(0, 80);
    return `- ${name}${callId ? ` (${callId})` : ''}: ${resultText || '[completed without textual output]'}`;
  });
}

function clipEvidenceFact(fact, maxChars) {
  if (maxChars <= 0) return null;
  if (fact.length <= maxChars) return fact;
  if (maxChars === 1) return '…';
  return `${fact.slice(0, Math.max(0, maxChars - 1))}…`;
}

function exchangeEvidenceMessage(rounds = [], priorEvidence = '', maxChars = 0) {
  const facts = rounds.flatMap(compactReceiptFact);
  if (!facts.length && !priorEvidence) return null;
  const lines = [
    '# exchange-evidence',
    '',
    'Receipt-backed evidence from earlier completed tool rounds compacted out of the native protocol:',
  ];
  // The caller owns the complete tool-evidence budget. Evidence is not given a
  // second fixed cap: it receives only the budget left after retained native
  // rounds, so a small-context provider request cannot quietly grow through a
  // synthetic summary. Give every candidate an equal deterministic share.
  const budget = Math.max(0, Number(maxChars) || 0);
  const used = lines.join('\n').length;
  const priorLines = String(priorEvidence || '').split('\n').filter((line) => line.startsWith('- '));
  const candidates = [...priorLines, ...facts];
  const factBudget = Math.max(0, budget - used - (candidates.length ? 1 : 0));
  const perFactBudget = candidates.length ? Math.floor(factBudget / candidates.length) : 0;
  for (const fact of candidates) {
    const clipped = clipEvidenceFact(fact, perFactBudget);
    if (clipped) lines.push(clipped);
  }
  if (lines.length === 3) return null;
  const message = { role: 'user', content: lines.join('\n') };
  Object.defineProperty(message, 'metadata', {
    value: { providerMessageSource: 'exchange-evidence' },
    enumerable: false,
  });
  return message;
}

function insertEvidenceBeforeCurrentTask(messages = [], evidence = null) {
  if (!evidence) return messages;
  const taskIndex = messages.findIndex((message) => /^# (?:task|current-message)\b/u.test(renderedContent(message?.content)));
  if (taskIndex < 0) return [...messages, evidence];
  return [...messages.slice(0, taskIndex), evidence, ...messages.slice(taskIndex)];
}

// Deterministic, protocol-safe tool-result bounding. An assistant tool call and
// its results are an indivisible round: when an old round no longer fits, drop
// the whole protocol unit and carry a bounded receipt-backed evidence record.
// Never preserve a call shell paired with a placeholder result.
export function pruneProviderToolResults(messages = [], { maxChars, maxToolRounds = Infinity } = {}) {
  if (!Number.isFinite(Number(maxChars)) || Number(maxChars) < 0) throw new Error('provider_tool_result_budget_required');
  const normalized = normalizeProviderMessages(messages);
  const priorEvidence = normalized.filter((message) => /^# exchange-evidence\b/u.test(renderedContent(message?.content)))
    .map((message) => renderedContent(message.content)).join('\n');
  const withoutPriorEvidence = normalized.filter((message) => !/^# exchange-evidence\b/u.test(renderedContent(message?.content)));
  const starts = toolRoundStarts(withoutPriorEvidence);
  if (!starts.length) return withoutPriorEvidence;
  const baseEnd = starts[0];
  const rounds = starts.map((start, index) => withoutPriorEvidence.slice(start, starts[index + 1] ?? withoutPriorEvidence.length));
  let remaining = Math.max(0, Number(maxChars) || 0);
  const retained = [];
  const displaced = [];
  for (const round of [...rounds].reverse()) {
    const chars = toolRoundChars(round);
    if (retained.length < Math.max(0, Number(maxToolRounds) || 0) && (chars <= remaining || !retained.length)) {
      retained.unshift(round);
      remaining = Math.max(0, remaining - chars);
    } else {
      displaced.unshift(round);
    }
  }
  return insertEvidenceBeforeCurrentTask(
    [...withoutPriorEvidence.slice(0, baseEnd), ...retained.flat()],
    exchangeEvidenceMessage(displaced, priorEvidence, remaining),
  );
}

function sourceOf(message = {}) {
  const explicit = String(message?.metadata?.providerMessageSource || '').trim();
  if (explicit) return explicit;
  if (message?.type === 'function_call_output') return 'native-tool-result';
  if (message.role === 'tool') return 'native-tool-result';
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) return 'native-tool-call';
  if (message.role === 'system' || message.role === 'developer') return 'stable-context';
  const rendered = renderedContent(message.content);
  if (/^# prior-conversation-summary\b/u.test(rendered)) return 'compaction-summary';
  if (/^# task\b/u.test(rendered) || /^# current-message\b/u.test(rendered)) return 'current-task';
  if (/^# exchange-evidence\b/u.test(rendered)) return 'exchange-evidence';
  if (/\b(?:Executed (?:chat )?tool|Mutation is|required|Repair attempt|verification is still missing|bounded chat tool loop has ended)\b/iu.test(rendered)) return 'synthesized-followup';
  return message.role === 'assistant' ? 'raw-transcript-assistant' : message.role === 'user' ? 'raw-transcript-user' : 'provider-message';
}

function preview(value) {
  const rendered = renderedContent(value);
  return rendered.length > PREVIEW_CHARS ? `${rendered.slice(0, PREVIEW_CHARS)}…` : rendered;
}

// Safe request receipt: enough to inspect message selection, role order, and
// tool pairing without retaining the provider body or attachment payloads.
export function providerMessageManifest(messages = []) {
  return (Array.isArray(messages) ? messages : []).map((message, index) => {
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    const responseToolResult = message?.type === 'function_call_output';
    const resultContent = responseToolResult ? message?.output : message?.content;
    const source = sourceOf(message);
    return {
      index,
      role: String(message?.role || (responseToolResult ? 'tool' : 'unknown')),
      type: calls.length ? 'assistant-tool-call' : message?.role === 'tool' || responseToolResult ? 'tool-result' : 'message',
      source,
      status: source === 'exchange-evidence' || source === 'synthesized-followup' ? 'synthesized' : 'selected',
      chars: renderedContent(resultContent).length,
      contentHash: hash(JSON.stringify(resultContent ?? '')),
      preview: preview(resultContent),
      toolCallIds: calls.map((call) => String(call?.id || '')).filter(Boolean),
      toolCallId: message?.tool_call_id ? String(message.tool_call_id) : message?.call_id ? String(message.call_id) : null,
    };
  });
}

export function conversationProviderMessages({ priorSummary = '', recentMessages = [], task = '' } = {}) {
  return normalizeProviderMessages([
    ...(text(priorSummary) ? [{ role: 'user', content: `# prior-conversation-summary\n\n${text(priorSummary)}` }] : []),
    ...recentMessages,
    { role: 'user', content: `# current-message\n\n${text(task)}` },
  ]);
}
