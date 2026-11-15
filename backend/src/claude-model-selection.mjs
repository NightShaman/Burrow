const fail = code => { throw Object.assign(new Error(code), { statusCode: 400 }); };

export const CLAUDE_SELECTION_ACTIONS = Object.freeze({
  claude_model_selection_required: 'Choose a Claude model and Anthropic OAuth account in Minion settings.',
  claude_model_selection_invalid: 'Supply claudeModel as null or a complete connectionId and model pair.',
  claude_connection_not_found: 'Choose an existing Anthropic OAuth connection in Minion settings.',
  claude_anthropic_oauth_required: 'Choose an enabled direct Anthropic OAuth account in Minion settings; load balancers and API keys are not supported.',
  claude_model_not_enabled: 'Enable the model on the selected Anthropic OAuth connection, or choose another model in Minion settings.',
  claude_model_override_unsupported: 'Choose the Claude model through Minion settings before spawning.',
  claude_model_settings_store_required: 'Restore the model settings store before spawning Claude.',
  claude_model_selection_unavailable: 'Reload model connections and reselect the Claude account and model in Minion settings.',
});

export function normalizeClaudeModelSelection(input) {
  if (input === null) return null;
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).some(key => !['connectionId', 'model'].includes(key))
    || !['connectionId', 'model'].every(key => typeof input[key] === 'string' && input[key].trim())) {
    fail('claude_model_selection_invalid');
  }
  return { connectionId: input.connectionId.trim(), model: input.model.trim() };
}

export const claudeDirectEligible = connection => Boolean(connection
  && connection.enabled !== false
  && connection.apiType === 'anthropic-messages'
  && connection.auth?.type === 'oauth'
  && ['anthropic', 'claude'].includes(String(connection.auth.provider || '').toLowerCase()));

// Secret-free configuration validation; credential resolution/refresh remains
// the native runner's responsibility. Transient quota/cooldown is not consulted.
export async function validateClaudeModelSelection(models, selection) {
  if (!selection) fail('claude_model_selection_required');
  const normalized = normalizeClaudeModelSelection(selection);
  if (!models?.get) fail('claude_model_settings_store_required');
  const connection = await models.get(normalized.connectionId);
  if (!connection) fail('claude_connection_not_found');
  if (!claudeDirectEligible(connection)) fail('claude_anthropic_oauth_required');
  if (!(connection.models || []).some(model => model.id === normalized.model && model.selected !== false)) {
    fail('claude_model_not_enabled');
  }
  return normalized;
}
