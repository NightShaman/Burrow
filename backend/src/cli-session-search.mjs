import { createPostgresApplication } from './postgres-composition.mjs';
import { postgresConfig } from './postgres-foundation.mjs';
import { settingsKeyFromEnvironment } from './model-settings-store.mjs';
import { loadRuntimeConfig } from './runtime-config-loader.mjs';
import { searchSessionEvidence } from './session-search.mjs';

// Connect to the already-started authority using the same composition and config
// as the UI. A read command does not own PostgreSQL lifecycle or legacy cutover.
export async function runCliSessionSearch({ rootDir, args = {}, env = process.env,
  compose = createPostgresApplication, loadConfig = loadRuntimeConfig, search = searchSessionEvidence,
} = {}) {
  let application = null;
  try {
    if (env.BURROW_UI_POSTGRES === '1') {
      application = await compose({ poolConfig: postgresConfig(env), encryptionKey: settingsKeyFromEnvironment(env), runtimeRoot: env.BURROW_RUNTIME_ROOT || env.BURROW_DATA_ROOT });
    }
    const runtime = await loadConfig({ rootDir, args, stores: application?.stores || null });
    return await search({
      rootDir: args.data_root || runtime.runtimeState.dataRoot,
      conversationStore: application?.stores.conversations || null,
      agentId: args.agent_id || 'hatchet',
      sessionId: args.session_id || 'default',
      query: args.query || args.message || (args._ || []).join(' '),
      role: args.role || 'any', sourceId: args.source_id || null, limit: args.limit || 50,
    });
  } finally {
    if (application) await application.close();
  }
}
