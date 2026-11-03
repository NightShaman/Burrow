import { createHash } from 'node:crypto';
import { activeModAgentProvider } from './mod-agent-runtime.mjs';

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const PAGE_SIZE = 20;

// Core owns peer discovery without a diagnostic mod or access to conversations.
// Only an A2A-enabled mod agent with a live owning provider is discoverable;
// visibility.agents controls the ordinary Agents UI, not A2A discovery.
export async function listAgentPeers({ store, query = null, includeDisabled = false, cursor = null, limit = PAGE_SIZE } = {}) {
  if (!store?.list) throw new Error('agent_directory_unavailable');
  if (query !== null && (typeof query !== 'string' || query.length > 96)) throw new Error('agent_directory_query_invalid');
  if (typeof includeDisabled !== 'boolean') throw new Error('agent_directory_include_disabled_invalid');
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_SIZE) throw new Error('agent_directory_limit_invalid');
  const requestedQuery = query?.trim() || null;
  const needle = requestedQuery?.toLowerCase();
  const agents = (await store.list({ includeDisabled }))
    .filter(agent => (includeDisabled || agent.enabled === true)
      && (!agent.modAgent || (agent.modAgent.capabilities?.a2a === true && activeModAgentProvider(agent)))
      && (!needle || agent.id.toLowerCase().includes(needle) || agent.name.toLowerCase().includes(needle)))
    .map(({ id, name, enabled }) => ({ id, name, enabled }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  // Cursors carry no authority. Bind traversal to filters and this observed
  // public directory; a registry change asks callers to restart rather than
  // quietly skipping peers. No server-side cursor state or extra store exists.
  const scope = digest([needle || null, includeDisabled]);
  const snapshot = digest(agents);
  let start = 0;
  if (cursor !== null && cursor !== '') {
    let parsed;
    try {
      if (typeof cursor !== 'string' || cursor.length > 512) throw new Error();
      parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
      if (parsed?.v !== 1 || parsed.scope !== scope || typeof parsed.after !== 'string') throw new Error();
    } catch { throw new Error('agent_directory_cursor_invalid'); }
    if (parsed.snapshot !== snapshot) throw new Error('agent_directory_changed_restart_listing');
    const previous = agents.findIndex(agent => agent.id === parsed.after);
    if (previous < 0) throw new Error('agent_directory_cursor_invalid');
    start = previous + 1;
  }
  const page = agents.slice(start, start + limit);
  const nextCursor = start + page.length < agents.length
    ? Buffer.from(JSON.stringify({ v: 1, scope, snapshot, after: page.at(-1).id })).toString('base64url') : null;
  return { tool: 'agents_list', ok: true, agents: page, resultCount: page.length, totalCount: agents.length, nextCursor, query: requestedQuery, includeDisabled };
}
