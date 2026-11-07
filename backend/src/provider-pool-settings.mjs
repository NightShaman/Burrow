function normalize(value) { return String(value ?? '').trim(); }

export function isProviderPool(connection = {}) { return ['openai-lb', 'anthropic-lb'].includes(connection.apiType); }

export function normalizeProviderPool(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('provider_pool_invalid');
  if (typeof value.enabled !== 'boolean') throw new Error('provider_pool_enabled_required');
  if (!Array.isArray(value.memberConnectionIds) || value.memberConnectionIds.some(id => typeof id !== 'string' || !id.trim())) throw new Error('provider_pool_members_invalid');
  if (value.sticky !== undefined && typeof value.sticky !== 'boolean') throw new Error('provider_pool_sticky_invalid');
  if (value.preferEarlierReset !== undefined && typeof value.preferEarlierReset !== 'boolean') throw new Error('provider_pool_prefer_earlier_reset_invalid');
  const memberConnectionIds = [...new Set(value.memberConnectionIds.map(normalize))];
  if (!memberConnectionIds.length) throw new Error('provider_pool_members_required');
  return { enabled: value.enabled, memberConnectionIds, sticky: value.sticky ?? true, preferEarlierReset: value.preferEarlierReset ?? false };
}

export function assertProviderPoolMembers(connection, members = []) {
  const family = connection.apiType === 'openai-lb' ? 'openai' : 'anthropic';
  for (const id of connection.pool.memberConnectionIds) {
    const member = members.find(item => item.id === id);
    if (!member) throw new Error('provider_pool_member_not_found');
    if (id === connection.id || isProviderPool(member)) throw new Error('provider_pool_nested');
    if (member.auth?.type !== 'oauth') throw new Error('provider_pool_member_oauth_required');
    const provider = String(member.auth.provider || '').toLowerCase();
    const matching = family === 'openai'
      ? provider === 'openai' && ['openai-responses', 'openai-chat-completions'].includes(member.apiType)
      : ['anthropic', 'claude'].includes(provider) && member.apiType === 'anthropic-messages';
    if (!matching) throw new Error('provider_pool_member_family_mismatch');
  }
}

export function providerPoolModels(members = []) {
  if (!members.length) return [];
  const catalogs = members.map(member => new Map((member.models || [])
    .filter(model => !model.manual).map(model => [model.id, model])));
  return [...catalogs[0].values()].filter(model => catalogs.every(catalog => catalog.has(model.id)))
    .map(model => ({ ...model, selected: true }));
}
