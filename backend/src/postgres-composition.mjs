import { PostgresMcpProviderStateStore } from './postgres-mcp-provider-state-store.mjs';
import { PostgresDreamExtractionStore } from './postgres-dream-extraction-store.mjs';
import { PostgresAlbdruckStore } from './postgres-albdruck-store.mjs';
import { createPostgresModDistributionRepository } from './postgres-mod-distribution-repository.mjs';
import { postgresModStoreFactory, disabledPostgresMods, publishPostgresModCatalog } from './postgres-mod-store.mjs';
import { createPostgresPool, closePostgresPool } from './postgres-foundation.mjs';
import { PostgresAgentRegistryStore } from './postgres-agent-registry.mjs';
import { PostgresAgentProfileStore } from './postgres-agent-profile-store.mjs';
import { PostgresModelSettingsStore } from './postgres-model-settings-store.mjs';
import { PostgresMcpSettingsStore } from './postgres-mcp-settings-store.mjs';
import { PostgresTaskBoardStore } from './postgres-task-board-store.mjs';
import { PostgresScheduledJobStore } from './postgres-scheduled-job-store.mjs';
import { PostgresDreamSettingsStore } from './postgres-dream-settings-store.mjs';
import { PostgresDreamDiaryStore } from './postgres-dream-diary-store.mjs';
import { PostgresDreamCycleReceiptStore } from './postgres-dream-cycle-receipt-store.mjs';
import { PostgresContinuityHandoffStore } from './postgres-continuity-handoff-store.mjs';
import PostgresForgeStore, { POSTGRES_FORGE_SCHEMA_SQL } from './postgres-forge-store.mjs';
import { PostgresWorkingMemoryStore } from './postgres-working-memory-store.mjs';
import { PostgresApiTokenStore } from './postgres-api-token-store.mjs';
import { PostgresSkillSettingsStore } from './postgres-skill-settings-store.mjs';
import PostgresSetupStateStore, { POSTGRES_SETUP_STATE_SCHEMA_SQL } from './postgres-setup-state-store.mjs';
import PostgresSettingsMetadataStore from './postgres-settings-metadata-store.mjs';
import { PostgresSessionStore } from './postgres-session-store.mjs';
import PostgresUiAuthSecretStore from './postgres-ui-auth-secret-store.mjs';
import PostgresRetentionSettingsStore, { POSTGRES_RETENTION_SETTINGS_SCHEMA_SQL } from './postgres-retention-settings-store.mjs';
import PostgresWorkingMemoryRetentionSettingsStore, { POSTGRES_WORKING_MEMORY_RETENTION_SCHEMA_SQL } from './postgres-working-memory-retention-settings-store.mjs';

import { migratePostgres } from './postgres-migrations.mjs';
import { POSTGRES_APPLICATION_SCHEMA_SQL } from './postgres-application-schema.mjs';

/** Compose all staged stores around one explicitly owned pool. This is isolated plumbing;
 * callers must opt in and production startup deliberately does not call this factory. */
export async function createPostgresApplication({
  pool,
  poolConfig,
  PoolClass,
  encryptionKey,
  retention,
  runtimeRoot,
  resolveAgent,
  resolveOperator,
  connections,
  resolveConfig,
  runtimeInstanceId,
  ownerId,
  clock,
  bootstrapSampleIdentities,
} = {}) {
  const ownedPool = !pool;
  const sharedPool = pool || createPostgresPool({ config: poolConfig, ...(PoolClass ? { PoolClass } : {}) });
  const common = { pool: sharedPool, ownsPool: false };
  try {
    await migratePostgres(sharedPool);
    const workingMemoryRetention = new PostgresWorkingMemoryRetentionSettingsStore({ ...common, ...(clock ? { clock } : {}) });
    const stores = {
    agents: new PostgresAgentRegistryStore({ ...common, bootstrapSampleIdentities }),
    profiles: new PostgresAgentProfileStore({ ...common, ...(clock ? { clock } : {}) }),
    models: new PostgresModelSettingsStore({ ...common, key: encryptionKey, ...(clock ? { clock } : {}), ...(bootstrapSampleIdentities !== undefined ? { bootstrapSampleIdentities } : {}) }),
    mcpProviderStates: new PostgresMcpProviderStateStore(common),
    mcp: new PostgresMcpSettingsStore({ ...common, key: encryptionKey }),
    tasks: new PostgresTaskBoardStore({ ...common, ...(clock ? { clock } : {}) }),
    scheduledJobs: new PostgresScheduledJobStore({ ...common, ...(clock ? { clock } : {}) }),
    dreamSettings: new PostgresDreamSettingsStore(common),
    dreamExtractions: new PostgresDreamExtractionStore(common),
    dreamDiary: new PostgresDreamDiaryStore(common),
    dreamCycles: new PostgresDreamCycleReceiptStore({ ...common, ...(clock ? { clock } : {}), ...(runtimeInstanceId ? { runtimeInstanceId } : {}) }),
    continuity: new PostgresContinuityHandoffStore(common),
    forge: new PostgresForgeStore({ ...common, runtimeRoot, resolveAgent, resolveOperator, connections, resolveConfig, ...(ownerId ? { ownerId } : {}) }),
    workingMemory: new PostgresWorkingMemoryStore({ ...common, retention: retention || (() => workingMemoryRetention.read()), ...(clock ? { clock } : {}) }),
    apiTokens: new PostgresApiTokenStore({ pool: sharedPool, ...(clock ? { clock } : {}) }),
    skills: new PostgresSkillSettingsStore({ ...common, ...(clock ? { clock } : {}) }),
    setupState: new PostgresSetupStateStore({ ...common, ...(clock ? { clock } : {}) }),
    retentionSettings: new PostgresRetentionSettingsStore({ ...common, ...(clock ? { clock } : {}) }),
    workingMemoryRetention,
    uiAuthSecrets: new PostgresUiAuthSecretStore({ ...common, key: encryptionKey, ...(clock ? { clock } : {}) }),
    metadata: new PostgresSettingsMetadataStore({ ...common, ...(clock ? { clock } : {}) }),
    conversations: new PostgresSessionStore({ ...common, ...(clock ? { clock } : {}) }),
    };
    stores.albdruck = new PostgresAlbdruckStore({ pool: sharedPool, resolveOriginal: ref => stores.conversations.resolveOriginal(ref), searchHistory: input => stores.conversations.history(input) });
    await stores.forge.init();
    let closed = false;
    return Object.freeze({
    modDistributionRepositoryFactory: () => createPostgresModDistributionRepository({ pool: sharedPool }),
    modStoreFactory: postgresModStoreFactory({ pool: sharedPool, key: encryptionKey }),
    disabledModIds: () => disabledPostgresMods(sharedPool),
    modCatalogWriter: mod => publishPostgresModCatalog(sharedPool, mod),
    pool: sharedPool,
    ownsPool: ownedPool,
    stores: Object.freeze(stores),
    async close() {
      if (closed) return;
      closed = true;
      await stores.conversations.close();
      if (ownedPool) await closePostgresPool(sharedPool);
    },
    });
  } catch (error) {
    if (ownedPool) await closePostgresPool(sharedPool);
    throw error;
  }
}

export default createPostgresApplication;
