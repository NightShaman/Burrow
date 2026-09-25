import { apiMode } from './model-adapters/shared.mjs';
import { createOpenAICompatibleModelAdapter } from './model-adapters/openai.mjs';
import { createAnthropicMessagesModelAdapter, __test__ as anthropicTest } from './model-adapters/anthropic.mjs';
import { createOpenAIGeneratedArtifactAdapter, generatedArtifactKind, __test__ as generatedArtifactTest } from './model-adapters/openai-generated-artifacts.mjs';
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
  MAX_SSE_CARRY_CHARS,
  MAX_SSE_EVENT_CHARS,
  DEFAULT_MAX_RESPONSE_BYTES,
  mergeStreamToolCall,
} from './model-adapters/shared.mjs';

export { createOpenAICompatibleModelAdapter } from './model-adapters/openai.mjs';
export { createAnthropicMessagesModelAdapter } from './model-adapters/anthropic.mjs';
export { createOpenAIGeneratedArtifactAdapter } from './model-adapters/openai-generated-artifacts.mjs';

export function createModelAdapter(options = {}) {
  const config = options.config || {};
  const mode = apiMode(config);
  if (mode === 'anthropic-messages') return createAnthropicMessagesModelAdapter(options);
  if (generatedArtifactKind(config)) return createOpenAIGeneratedArtifactAdapter(options);
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
  anthropicThinkingConfig: anthropicTest.anthropicThinkingConfig,
  defaultMaxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
  maxModelTextChars: MAX_MODEL_TEXT_CHARS,
  maxSseCarryChars: MAX_SSE_CARRY_CHARS,
  maxSseEventChars: MAX_SSE_EVENT_CHARS,
  mergeStreamToolCall,
  generatedArtifactKind,
  generatedArtifactEndpoint: generatedArtifactTest.endpoint,
  generatedArtifactRequestHeaders: generatedArtifactTest.requestHeaders,
};
