import { AgentProfileStore } from './agent-profile-store.mjs';

export function updateOwnToolsProfile({ agentId, markdown, databasePath } = {}) {
  if (!agentId) return { tool: 'agent_update_tools_profile', ok: false, error: 'agent_profile_update_agent_required' };
  if (!databasePath) return { tool: 'agent_update_tools_profile', ok: false, error: 'agent_profile_update_database_required' };
  const store = new AgentProfileStore({ databasePath });
  try {
    const document = store.replaceTools(agentId, markdown);
    return { tool: 'agent_update_tools_profile', ok: true, document: { kind: document.kind, chars: document.markdown.length, updatedAt: document.updatedAt } };
  } catch (error) {
    return { tool: 'agent_update_tools_profile', ok: false, error: String(error?.message || error) };
  } finally { store.close(); }
}
