import { loadBurrowConfig, resolveModelConfig, configDefaults, resolveRuntimeStateConfig, resolveUiConfig, resolveChatToolLoopConfig, resolveSkillsConfig, resolveContextConfig } from './config.mjs';
import { readExecutionBoundaries, validateExecutionBoundaries, emptyExecutionBoundaries, EXECUTION_BOUNDARIES_META_KEY } from './execution-boundaries.mjs';

export async function loadRuntimeConfig({ rootDir, args = {}, stores = null, runtimeStores = null, tolerateModelResolutionError = false } = {}) {
  // Store injection is an async runtime boundary. Keep args-compatible callers,
  // while making the composed application stores available to every resolver.
  const injectedStores = stores || runtimeStores;
  const resolverArgs = injectedStores ? { ...args, stores: injectedStores, runtimeStores: injectedStores } : args;
  const loaded = await loadBurrowConfig({ rootDir });
  const runtimeState = resolveRuntimeStateConfig({ rootDir, args, loadedConfig: loaded.config });
  const skillsConfig = { ...resolveSkillsConfig(loaded.config), root: runtimeState.skillsRoot };
  const storedBoundaries = injectedStores?.metadata ? await injectedStores.metadata.get(EXECUTION_BOUNDARIES_META_KEY) : null;
  const checkedBoundaries = validateExecutionBoundaries(storedBoundaries || emptyExecutionBoundaries());
  const executionBoundaries = injectedStores?.metadata ? (checkedBoundaries.ok ? checkedBoundaries.boundaries : emptyExecutionBoundaries()) : readExecutionBoundaries({ databasePath: runtimeState.settingsDatabasePath });
  let modelConfig = null;
  let modelResolutionError = null;
  try {
    modelConfig = await resolveModelConfig(resolverArgs, loaded.config);
  } catch (error) {
    if (!tolerateModelResolutionError) throw error;
    modelResolutionError = String(error?.message || error);
  }
  return {
    loaded,
    defaults: configDefaults(loaded.config),
    modelConfig,
    modelResolutionError,
    executionBoundaries,
    runtimeState,
    ui: await resolveUiConfig({ ...resolverArgs, settings_database_path: runtimeState.settingsDatabasePath }, loaded.config),
    chatToolLoopConfig: resolveChatToolLoopConfig(loaded.config),
    skillsConfig,
    contextConfig: resolveContextConfig(args, loaded.config),
  };
}
