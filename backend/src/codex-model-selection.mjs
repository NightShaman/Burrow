import { isProviderPool } from './provider-pool-settings.mjs';
import { codexDirectEligible, codexPoolSnapshot } from './codex-pool-routing.mjs';

const fail = code => { throw Object.assign(new Error(code), { statusCode: 400 }); };

export const CODEX_SELECTION_ACTIONS = Object.freeze({
  codex_model_selection_required: 'Choose a Codex model and OpenAI OAuth account in Minion settings.',
  codex_model_selection_invalid: 'Supply codexModel as null or a complete connectionId and model pair.',
  codex_connection_not_found: 'Choose an existing OpenAI OAuth connection in Minion settings.',
  codex_openai_oauth_required: 'Choose a direct OpenAI OAuth account in Minion settings, or an enabled OpenAI load balancer with eligible OAuth members.',
  codex_pool_ineligible: 'Enable an OpenAI load balancer with at least one enabled OpenAI OAuth member supporting this model, then select it in Minion settings.',
  codex_pool_replay_unavailable: 'The saved native turn contains tool actions or incomplete history. Restore its original account to continue safely; automatic replay is blocked.',
  provider_pool_no_eligible_members: 'All eligible Codex pool accounts are unavailable or cooling down. Retry after their quota or cooldown resets.',
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
  if (isProviderPool(connection)) {
    if (connection.apiType !== 'openai-lb') fail('codex_openai_oauth_required');
    try { await codexPoolSnapshot(models, selection.connectionId, selection.model); }
    catch { fail('codex_pool_ineligible'); }
  } else if (!codexDirectEligible(connection)) {
    fail('codex_openai_oauth_required');
  }
  if (!isProviderPool(connection) && !(connection.models || []).some(model => model.id === selection.model && model.selected !== false)) {
    fail('codex_model_not_enabled');
  }
  return { connectionId: selection.connectionId, model: selection.model };
}
