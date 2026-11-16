const fail = code => { throw Object.assign(new Error(code), { statusCode: 400 }); };

export const GEMINI_SELECTION_ACTIONS = Object.freeze({
  gemini_model_selection_required: 'Choose a Gemini model and Google API-key connection in Minion settings.',
  gemini_model_selection_invalid: 'Supply geminiModel as null or a complete connectionId and model pair.',
  gemini_connection_not_found: 'Choose an existing Google API-key connection in Minion settings.',
  gemini_google_api_key_required: 'Choose an enabled Google Generative Language API-key connection in Minion settings.',
  gemini_model_not_enabled: 'Enable the exact model on the selected Google connection, or choose another model.',
  gemini_model_override_unsupported: 'Choose the Gemini model through Minion settings before spawning.',
  gemini_model_settings_store_required: 'Restore the model settings store before spawning Gemini.',
});

export function normalizeGeminiModelSelection(input) {
  if (input === null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['connectionId', 'model'].includes(key))
    || !['connectionId', 'model'].every(key => typeof input[key] === 'string' && input[key].trim())) fail('gemini_model_selection_invalid');
  return { connectionId: input.connectionId.trim(), model: input.model.trim() };
}

export const geminiDirectEligible = connection => Boolean(connection && connection.enabled !== false
  && ['google-generative-language', 'google-gemini', 'gemini'].includes(String(connection.apiType || '').toLowerCase())
  && connection.auth?.type === 'api_key'
  && ['google', 'google-generative-language', 'gemini'].includes(String(connection.auth.provider || '').toLowerCase()));

// CLI wants a bare model name; connection catalogs may use API resource names.
export function geminiCliModel(model) {
  const value = String(model || '').trim();
  return value.startsWith('models/') ? value.slice('models/'.length) : value;
}

export function geminiSupportsModel(connection, model) {
  return (connection?.models || []).some(item => item.selected !== false
    && item.id === model);
}

export async function validateGeminiModelSelection(models, selection) {
  if (!selection) fail('gemini_model_selection_required');
  const normalized = normalizeGeminiModelSelection(selection);
  if (!models?.get) fail('gemini_model_settings_store_required');
  const connection = await models.get(normalized.connectionId);
  if (!connection) fail('gemini_connection_not_found');
  if (!geminiDirectEligible(connection)) fail('gemini_google_api_key_required');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,239}$/.test(geminiCliModel(normalized.model)) || !geminiSupportsModel(connection, normalized.model)) fail('gemini_model_not_enabled');
  return normalized;
}
