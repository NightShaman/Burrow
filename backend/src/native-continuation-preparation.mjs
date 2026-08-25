// Native Chat Completions continuation preparation.
//
// Conversation compaction owns semantic retention. This boundary owns only the
// provider's assistant-tool-call ↔ tool-result protocol: it fits complete
// protocol rounds into the same provider budget used for normal prompt
// preparation, carrying displaced rounds as receipt-backed evidence. It does
// not apply an independent round, dialogue, or character policy.
import { chatToolContinuationMessages, messageContentChars, pruneProviderToolResults } from './model-adapters/shared.mjs';
import { inspectAssembledPromptBudget } from './prompt-budget.mjs';

function transcriptChars(messages = []) {
  return (messages || []).reduce((total, message) => {
    const calls = Array.isArray(message?.tool_calls) ? message.tool_calls : [];
    return total + messageContentChars(message?.content) + calls.reduce((callTotal, call) => callTotal + String(call?.function?.name || '').length + String(call?.function?.arguments || '').length, 0);
  }, 0);
}


function projectValue(value, { maxChars, artifactRef = null } = {}) {
  if (typeof value === 'string') {
    if (value.length <= maxChars) return value;
    const includedChars = Math.max(0, maxChars);
    return { text: value.slice(0, includedChars), originalChars: value.length, includedChars, truncated: true, artifactRef };
  }
  if (Array.isArray(value)) return value.map((item) => projectValue(item, { maxChars, artifactRef }));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, projectValue(item, { maxChars, artifactRef })]));
}

function projectToolFields(messages = [], maxChars = 0) {
  const toolCount = messages.filter((message) => message?.role === 'tool').length || 1;
  const fieldBudget = Math.max(64, Math.floor(Math.max(0, maxChars) / toolCount / 2));
  return messages.map((message) => {
    if (message?.role !== 'tool' || typeof message.content !== 'string') return message;
    try {
      const parsed = JSON.parse(message.content);
      const artifactRef = parsed?.artifacts?.result || parsed?.artifacts?.stdout || parsed?.artifacts?.stderr || null;
      return { ...message, content: JSON.stringify(projectValue(parsed, { maxChars: fieldBudget, artifactRef })) };
    } catch { return { ...message, content: JSON.stringify(projectValue(message.content, { maxChars: fieldBudget })) }; }
  });
}

function inspectionFor(messages, { modelConfig, tools } = {}) {
  return inspectAssembledPromptBudget({ prompt: { modelMessages: messages }, modelConfig, tools });
}

function assertFits(inspection, { compacted = false } = {}) {
  const contextTokens = Number(inspection?.contextTokens);
  const estimatedTokens = Number(inspection?.estimatedTokens);
  if (!Number.isFinite(contextTokens) || contextTokens <= 0 || !Number.isFinite(estimatedTokens) || estimatedTokens <= contextTokens) return;
  const error = new Error('context_preparation_prompt_over_budget');
  error.statusCode = 413;
  error.details = {
    contextTokens,
    estimatedTokens,
    pressure: inspection?.pressure || 'blocked',
    continuation: true,
    compacted,
  };
  throw error;
}

// Tool protocol pairing is a transport invariant, not a second context
// authority. The canonical budget inspection decides how much of the paired
// transcript fits; pruneProviderToolResults compacts only complete displaced
// rounds into truthful receipt evidence.
export function prepareNativeToolContinuation({ baseMessages = [], toolCalls = [], toolResults = [], modelConfig = null, tools = null } = {}) {
  const complete = chatToolContinuationMessages({ baseMessages, toolCalls, toolResults });
  const completeInspection = inspectionFor(complete, { modelConfig, tools });
  if (!Number.isFinite(Number(completeInspection.contextTokens)) || completeInspection.contextTokens <= 0 || completeInspection.estimatedTokens <= completeInspection.contextTokens) {
    return { messages: complete, inspection: completeInspection, compacted: false };
  }

  // Search the complete protocol transcript's actual available request budget.
  // No fixed char/round constant participates: the upper bound is only the
  // current serialized transcript, and every candidate is inspected using the
  // normal provider-request estimator.
  let low = 0;
  let high = transcriptChars(complete);
  let best = null;
  let bestInspection = null;
  while (low <= high) {
    const budget = Math.floor((low + high) / 2);
    const projected = projectToolFields(complete, budget);
    const candidate = pruneProviderToolResults(projected, { maxChars: budget });
    const inspection = inspectionFor(candidate, { modelConfig, tools });
    if (inspection.estimatedTokens <= inspection.contextTokens) {
      best = candidate;
      bestInspection = inspection;
      low = budget + 1;
    } else high = budget - 1;
  }
  if (!best) {
    // Even the smallest protocol-valid representation cannot fit. Do not let
    // the adapter silently truncate it; surface the same preparation failure
    // contract used for an oversized ordinary prompt.
    const minimum = pruneProviderToolResults(projectToolFields(complete, 0), { maxChars: 0 });
    assertFits(inspectionFor(minimum, { modelConfig, tools }), { compacted: true });
  }
  return { messages: best, inspection: bestInspection, compacted: true };
}

export const __test__ = { transcriptChars, projectToolFields };
