import { isProviderPool } from './provider-pool-settings.mjs';

const fail = code => { throw Object.assign(new Error(code), { statusCode: 400 }); };

export const CODEX_SELECTION_ACTIONS = Object.freeze({
  codex_model_selection_required: 'Choose a Codex model and OpenAI OAuth account in Minion settings.',
  codex_model_selection_invalid: 'Supply codexModel as null or a complete connectionId and model pair.',
  codex_connection_not_found: 'Choose an existing OpenAI OAuth connection in Minion settings.',
  codex_openai_oauth_required: 'Connect and select a direct OpenAI OAuth account in Minion settings. Codex does not support load balancers or API keys.',
  codex_model_not_enabled: 'Enable the model on the selected OpenAI OAuth connection, or choose another model in Minion settings.',
  codex_model_override_unsupported: 'Choose the Codex model through Minion settings before spawning.',
  codex_model_settings_store_required: 'Restore the model settings store before spawning Codex.',
  codex_model_selection_unavailable: 'Reload model connections and reselect the Codex account and model in Minion settings.',
});

export function normalizeCodexModelSelection(input) {
  if (input === null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['connectionId', 'model'].includes(key))
    || !['connectionId', 'model'].every(key => typeof input[key] === 'string' && input[key].trim())) {
    fail('codex_model_selection_invalid');
  }
  return { connectionId: input.connectionId.trim(), model: input.model.trim() };
}

// Uses the existing secret-free connection/catalog projection. The runner still
// validates actual credentials at dispatch and owns OAuth refresh.
export async function validateCodexModelSelection(models, selection) {
  if (!selection) fail('codex_model_selection_required');
  if (!models?.get) fail('codex_model_settings_store_required');
  const connection = await models.get(selection.connectionId);
  if (!connection) fail('codex_connection_not_found');
  if (isProviderPool(connection)
    || !['openai-responses', 'openai-chat-completions'].includes(connection.apiType)
    || connection.auth?.type !== 'oauth'
    || String(connection.auth?.provider || '').toLowerCase() !== 'openai') {
    fail('codex_openai_oauth_required');
  }
  if (!(connection.models || []).some(model => model.id === selection.model && model.selected !== false)) {
    fail('codex_model_not_enabled');
  }
  return { connectionId: selection.connectionId, model: selection.model };
}
