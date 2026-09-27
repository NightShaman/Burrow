const text = (value) => typeof value === 'string' ? value.trim() : '';

// Google exposes an OpenAI-compatible route alongside its native Generative
// Language API. Catalog IDs remain provider data; only the compatible request
// wire removes Google's optional `models/` resource prefix.
export function isGoogleOpenAICompatible(config = {}) {
  const api = text(config.api || config.apiType || config.mode || 'openai-chat-completions').toLowerCase();
  if (!api.startsWith('openai-')) return false;
  let hostname = '';
  try { hostname = new URL(config.baseUrl || config.apiBaseUrl || config.url).hostname.toLowerCase(); } catch {}
  const provider = text(config.provider || config.providerName).toLowerCase();
  return hostname === 'generativelanguage.googleapis.com'
    || ['google', 'google-ai', 'google-gemini'].includes(provider);
}

export function googleCompatibleWireModel(config = {}) {
  const model = text(config.model);
  return isGoogleOpenAICompatible(config) ? model.replace(/^models\//i, '') : model;
}

export const __test__ = { isGoogleOpenAICompatible, googleCompatibleWireModel };
