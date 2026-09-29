import { createPostgresApplication } from './postgres-composition.mjs';
import { postgresConfig } from './postgres-foundation.mjs';
import { settingsKeyFromEnvironment } from './model-settings-store.mjs';
import { loadRuntimeConfig } from './runtime-config-loader.mjs';

// CLI readers connect to the running authority; they do not start PostgreSQL.
export async function withCliPostgres({ rootDir, args = {}, env = process.env,
  compose = createPostgresApplication, loadConfig = loadRuntimeConfig,
} = {}, operation) {
  const application = await compose({ poolConfig: postgresConfig(env),
    encryptionKey: settingsKeyFromEnvironment(env),
    runtimeRoot: env.BURROW_RUNTIME_ROOT || env.BURROW_DATA_ROOT });
  try {
    const runtime = await loadConfig({ rootDir, args, stores: application.stores, tolerateModelResolutionError: true });
    return await operation({ application, runtime });
  } finally {
    await application.close();
  }
}
