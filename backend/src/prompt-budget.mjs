import { createModelAdapter } from './model-adapter.mjs';
import { normalizeProviderMessages } from './provider-messages.mjs';

function estimateTokensFromChars(chars = 0) {
  return Math.ceil(Number(chars || 0) / 4);
}

function contextBudgetPressure(usageRatio = 0) {
  if (usageRatio >= 1) return 'blocked';
  if (usageRatio >= 0.9) return 'compress';
  if (usageRatio >= 0.75) return 'watch';
  return 'ok';
}

function normalizedProviderMessages(prompt = null) {
  if (Array.isArray(prompt?.modelMessages) && prompt.modelMessages.length) return normalizeProviderMessages(prompt.modelMessages);
  if (prompt?.text) return normalizeProviderMessages([{ role: 'user', content: prompt.text }]);
  return [];
}

function normalizedTools(tools = null) {
  return (Array.isArray(tools) ? tools : [])
    .filter((tool) => tool && typeof tool === 'object')
    .map((tool) => tool.function || tool)
    .filter((tool) => tool?.name)
    .map((tool) => ({
      name: String(tool.name),
      description: String(tool.description || ''),
      parameters: tool.parameters && typeof tool.parameters === 'object' ? tool.parameters : { type: 'object', properties: {} },
    }));
}

function fallbackEstimateProviderRequest({ prompt = null, modelConfig = null, tools = null } = {}) {
  const messages = normalizedProviderMessages(prompt);
  const toolSchemas = normalizedTools(tools);
  if (!messages.length) {
    const estimatedChars = Number(prompt?.stats?.totalChars || prompt?.text?.length || 0);
    return { source: 'prompt_text_fallback', estimatedChars, messageCount: 0, toolCount: toolSchemas.length };
  }
  const api = String(modelConfig?.api || modelConfig?.mode || '').toLowerCase();
  const requestShape = api.includes('responses')
    ? {
        model: modelConfig?.model || 'model',
        input: messages,
        ...(toolSchemas.length ? { tools: toolSchemas.map((tool) => ({ type: 'function', ...tool })), tool_choice: 'auto' } : {}),
      }
    : {
        model: modelConfig?.model || 'model',
        messages,
        ...(toolSchemas.length ? { tools: toolSchemas.map((tool) => ({ type: 'function', function: tool })), tool_choice: 'auto' } : {}),
      };
  return {
    source: 'provider_message_estimate_fallback',
    estimatedChars: JSON.stringify(requestShape).length,
    messageCount: messages.length,
    toolCount: toolSchemas.length,
  };
}

function adapterEstimateProviderRequest({ prompt = null, modelConfig = null, tools = null } = {}) {
  const messages = normalizedProviderMessages(prompt);
  if (!messages.length) return fallbackEstimateProviderRequest({ prompt, modelConfig, tools });
  try {
    const adapter = createModelAdapter({ config: { ...(modelConfig || {}), model: modelConfig?.model || 'model', baseUrl: modelConfig?.baseUrl || modelConfig?.apiBaseUrl || modelConfig?.url || 'https://example.invalid/v1' }, fetchImpl: async () => { throw new Error('estimate_only_no_fetch'); } });
    if (typeof adapter.estimateRequest !== 'function') throw new Error('adapter_estimate_unavailable');
    const estimate = adapter.estimateRequest({ messages, tools });
    return {
      source: 'adapter_request_estimate',
      estimatedChars: Number(estimate.estimatedChars || 0),
      estimatedTokens: Number(estimate.estimatedTokens || 0),
      messageCount: messages.length,
      toolCount: normalizedTools(tools).length,
      promptChars: Number(estimate.promptChars || 0),
      api: estimate.api || adapter.api || null,
      model: estimate.model || adapter.model || null,
    };
  } catch {
    return fallbackEstimateProviderRequest({ prompt, modelConfig, tools });
  }
}

export function inspectAssembledPromptBudget({ prompt = null, modelConfig = null, tools = null } = {}) {
  const estimate = adapterEstimateProviderRequest({ prompt, modelConfig, tools });
  const estimatedChars = Number(estimate.estimatedChars || 0);
  const estimatedTokens = Number.isFinite(Number(estimate.estimatedTokens)) && Number(estimate.estimatedTokens) > 0
    ? Number(estimate.estimatedTokens)
    : estimateTokensFromChars(estimatedChars);
  const nativeWindow = Number.isFinite(Number(modelConfig?.contextWindow)) && Number(modelConfig.contextWindow) > 0 ? Number(modelConfig.contextWindow) : null;
  const effectiveWindow = Number.isFinite(Number(modelConfig?.contextTokens)) && Number(modelConfig.contextTokens) > 0
    ? Number(modelConfig.contextTokens)
    : nativeWindow;
  const usageRatio = effectiveWindow === null ? null : estimatedTokens / effectiveWindow;
  return {
    source: estimate.source,
    contextWindow: nativeWindow,
    contextTokens: effectiveWindow,
    estimatedChars,
    estimatedTokens,
    remainingTokens: effectiveWindow === null ? null : Math.max(0, effectiveWindow - estimatedTokens),
    usageRatio,
    pressure: usageRatio === null ? 'unknown' : contextBudgetPressure(usageRatio),
    sections: prompt?.stats?.sections || [],
    messageCount: estimate.messageCount,
    toolCount: estimate.toolCount,
    promptChars: estimate.promptChars ?? null,
    api: estimate.api || null,
    model: estimate.model || null,
    debugPromptChars: Number(prompt?.stats?.totalChars || prompt?.text?.length || 0),
  };
}

export const __test__ = { estimateTokensFromChars, contextBudgetPressure, fallbackEstimateProviderRequest, adapterEstimateProviderRequest };
