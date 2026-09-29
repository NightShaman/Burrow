export async function updateOwnToolsProfile({ agentId, markdown, store } = {}) {
  if (!agentId) return { tool: 'agent_update_tools_profile', ok: false, error: 'agent_profile_update_agent_required' };
  if (!store?.replaceTools) return { tool: 'agent_update_tools_profile', ok: false, error: 'agent_profile_store_required' };
  try {
    const document = await store.replaceTools(agentId, markdown);
    return { tool: 'agent_update_tools_profile', ok: true, document: { kind: document.kind, chars: document.markdown.length, updatedAt: document.updatedAt } };
  } catch (error) { return { tool: 'agent_update_tools_profile', ok: false, error: String(error?.message || error) }; }
}
