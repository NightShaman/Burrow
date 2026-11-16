import { claudeDirectEligible, claudePoolEligible } from './claude-model-selection.mjs';
import { ProviderPoolEngine } from './provider-pool-engine.mjs';
import { createProviderUsageService } from './provider-usage-service.mjs';
import { geminiDirectEligible } from './gemini-model-selection.mjs';

export const codexDirectEligible = connection => Boolean(connection
  && connection.enabled !== false
  && ['openai-responses', 'openai-chat-completions'].includes(connection.apiType)
  && connection.auth?.type === 'oauth'
  && String(connection.auth.provider || '').toLowerCase() === 'openai');
export const codexSupportsModel = (connection, model) => (connection?.models || [])
  .some(item => item.id === model && item.selected !== false);

export async function codexPoolSnapshot(store, connectionId, model) {
  const connection = await store.get(connectionId);
  if (connection?.apiType !== 'openai-lb' || !connection.pool?.enabled || connection.enabled === false) {
    throw Object.assign(new Error('codex_pool_ineligible'), { runnerCode: 'codex_pool_ineligible' });
  }
  const members = (await Promise.all((connection.pool.memberConnectionIds || []).map(id => store.get(id))))
    .filter(member => codexDirectEligible(member) && codexSupportsModel(member, model));
  if (!codexSupportsModel(connection, model) || !members.length) throw Object.assign(new Error('codex_pool_ineligible'), { runnerCode: 'codex_pool_ineligible' });
  return { connection: { ...connection, models: [{ id: model, selected: true }], pool: { ...connection.pool, memberConnectionIds: members.map(member => member.id) } }, members };
}

// Configuration eligibility deliberately ignores transient usage/cooldown state.
export function withCodexEligibility(connections) {
  return connections.map(connection => ({ ...connection,
    claudeEligible: claudeDirectEligible(connection) || claudePoolEligible(connection, connections),
    codexEligible: codexDirectEligible(connection)
    || Boolean(connection.apiType === 'openai-lb' && connection.enabled !== false && connection.pool?.enabled
      && (connection.pool.memberConnectionIds || []).some(id => {
        const member = connections.find(item => item.id === id);
        return codexDirectEligible(member) && (member.models || []).some(model => model.selected !== false
          && codexSupportsModel(connection, model.id));
      })),
    geminiEligible: geminiDirectEligible(connection) }));
}

export async function createCodexPoolRouting(store, connectionId, model, context) {
  const snapshot = await codexPoolSnapshot(store, connectionId, model);
  return new ProviderPoolEngine({ store, connection: snapshot.connection,
    refreshConnection: () => codexPoolSnapshot(store, connectionId, model),
    usageService: context.providerUsageService || createProviderUsageService({ modelLookup: () => store,
      authSecretToken: auth => auth?.token || auth?.accessToken || auth?.apiKey }) });
}
