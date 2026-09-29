import { withCliPostgres } from './cli-postgres.mjs';
import { searchSessionEvidence } from './session-search.mjs';

export async function runCliSessionSearch({ rootDir, args = {}, search = searchSessionEvidence, ...options } = {}) {
  return withCliPostgres({ rootDir, args, ...options }, async ({ application, runtime }) => search({
    rootDir: args.data_root || runtime.runtimeState.dataRoot,
    conversationStore: application.stores.conversations,
    agentId: args.agent_id || 'hatchet', sessionId: args.session_id || 'default',
    query: args.query || args.message || (args._ || []).join(' '),
    role: args.role || 'any', sourceId: args.source_id || null, limit: args.limit || 50,
  }));
}
