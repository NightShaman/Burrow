import { googleNativeApi } from './model-adapters/google-native-catalog.mjs';
import { createGoogleNativeModelAdapter } from './model-adapters/google.mjs';
import { normalizeChoice, normalizeResponseChoice, responseApiTool, messagesToResponsesInput, toolNames, readResponseSseBounded, compactResponseCompletion, mergeStreamToolCall } from './model-adapters/openai-transport.mjs';
import { apiMode, completionUrl, responsesUrl } from './model-adapters/openai-transport.mjs';
import { createOpenAICompatibleModelAdapter } from './model-adapters/openai.mjs';
import { createAnthropicMessagesModelAdapter, __test__ as anthropicTest } from './model-adapters/anthropic.mjs';
import { createOpenAIGeneratedArtifactAdapter, generatedArtifactKind, __test__ as generatedArtifactTest } from './model-adapters/openai-generated-artifacts.mjs';
import {
  redactHeaders,
  readResponseTextBounded,
  chatToolContinuationMessages,
  contextUsageFromRequest,
  contextUsageFromResponse,
  MAX_MODEL_TEXT_CHARS,
  MAX_SSE_CARRY_CHARS,
  MAX_SSE_EVENT_CHARS,
  DEFAULT_MAX_RESPONSE_BYTES,
} from './model-adapters/adapter-primitives.mjs';

export { createOpenAICompatibleModelAdapter } from './model-adapters/openai.mjs';
export { createAnthropicMessagesModelAdapter } from './model-adapters/anthropic.mjs';
export { createOpenAIGeneratedArtifactAdapter } from './model-adapters/openai-generated-artifacts.mjs';

export function createModelAdapter(options = {}) {
  const config = options.config || {};
  if (googleNativeApi(config)) return createGoogleNativeModelAdapter(options);
  const mode = apiMode(config);
  if (mode === 'anthropic-messages') return createAnthropicMessagesModelAdapter(options);
  // Lyria is a separate Forge dispatch path, not a chat model transport.
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

export { createGoogleNativeModelAdapter } from './model-adapters/google.mjs';
