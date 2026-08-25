import { apiMode } from './model-adapters/shared.mjs';
import { createOpenAICompatibleModelAdapter } from './model-adapters/openai.mjs';
import { createAnthropicMessagesModelAdapter, __test__ as anthropicTest } from './model-adapters/anthropic.mjs';
import {
  completionUrl,
  responsesUrl,
  normalizeChoice,
  normalizeResponseChoice,
  redactHeaders,
  toolNames,
  readResponseTextBounded,
  readResponseSseBounded,
  chatToolContinuationMessages,
  contextUsageFromRequest,
  contextUsageFromResponse,
  compactResponseCompletion,
  MAX_MODEL_TEXT_CHARS,
  MAX_TOOL_ARGUMENT_CHARS,
  MAX_SSE_CARRY_CHARS,
  MAX_SSE_EVENT_CHARS,
  MAX_TOOL_CALL_STREAM_BYTES,
  DEFAULT_MAX_RESPONSE_BYTES,
  mergeStreamToolCall,
} from './model-adapters/shared.mjs';

export { createOpenAICompatibleModelAdapter } from './model-adapters/openai.mjs';
export { createAnthropicMessagesModelAdapter } from './model-adapters/anthropic.mjs';

export function createModelAdapter(options = {}) {
  const mode = apiMode(options.config || {});
  if (mode === 'anthropic-messages') return createAnthropicMessagesModelAdapter(options);
  return createOpenAICompatibleModelAdapter(options);
}

export const __test__ = {
  completionUrl,
  responsesUrl,
  anthropicUrl: anthropicTest.anthropicUrl,
  apiMode,
  normalizeChoice,
  normalizeResponseChoice,
  normalizeAnthropicChoice: anthropicTest.normalizeAnthropicChoice,
  redactHeaders,
  toolNames,
  readResponseTextBounded,
  readResponseSseBounded,
  chatToolContinuationMessages,
  contextUsageFromRequest,
  contextUsageFromResponse,
  compactResponseCompletion,
  anthropicCachedTokens: anthropicTest.anthropicCachedTokens,
  defaultMaxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
  maxModelTextChars: MAX_MODEL_TEXT_CHARS,
  maxToolArgumentChars: MAX_TOOL_ARGUMENT_CHARS,
  maxSseCarryChars: MAX_SSE_CARRY_CHARS,
  maxSseEventChars: MAX_SSE_EVENT_CHARS,
  maxToolCallStreamBytes: MAX_TOOL_CALL_STREAM_BYTES,
  mergeStreamToolCall,
};
