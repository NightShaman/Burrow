import { claudeDirectEligible, claudeSupportsModel } from './claude-model-selection.mjs';
import { ProviderPoolEngine } from './provider-pool-engine.mjs';
import { createProviderUsageService } from './provider-usage-service.mjs';

export async function claudePoolSnapshot(store, connectionId, model) {
  const connection = await store.get(connectionId);
  const members = connection?.apiType === 'anthropic-lb' && connection.enabled !== false && connection.pool?.enabled
    ? (await Promise.all((connection.pool.memberConnectionIds || []).map(id => store.get(id))))
      .filter(member => claudeDirectEligible(member) && claudeSupportsModel(member, model)) : [];
  if (!claudeSupportsModel(connection, model) || !members.length) throw new Error('claude_pool_ineligible');
  return { connection: { ...connection, models: [{ id: model, selected: true }],
    pool: { ...connection.pool, memberConnectionIds: members.map(member => member.id) } }, members };
}

export async function createClaudePoolRouting(store, connectionId, model, context = {}) {
  const snapshot = await claudePoolSnapshot(store, connectionId, model);
  return new ProviderPoolEngine({ store, connection: snapshot.connection,
    refreshConnection: () => claudePoolSnapshot(store, connectionId, model),
    usageService: context.providerUsageService || createProviderUsageService({ modelLookup: () => store,
      authSecretToken: auth => auth?.token || auth?.accessToken || auth?.apiKey }) });
}
