import { loadBurrowConfig, resolveModelConfig, configDefaults, resolveRuntimeStateConfig, resolveUiConfig, resolveChatToolLoopConfig, resolveSkillsConfig, resolveContextConfig } from './config.mjs';
import { readExecutionBoundaries } from './execution-boundaries.mjs';

export async function loadRuntimeConfig({ rootDir, args = {}, stores = null, runtimeStores = null, tolerateModelResolutionError = false } = {}) {
  // Store injection is an async runtime boundary. Keep args-compatible callers,
  // while making the composed application stores available to every resolver.
  const injectedStores = stores || runtimeStores || args.stores || args.runtimeStores;
  if (!injectedStores?.metadata) throw new Error('runtime_stores_required');
  const resolverArgs = injectedStores ? { ...args, stores: injectedStores, runtimeStores: injectedStores } : args;
  const loaded = await loadBurrowConfig({ rootDir });
  const runtimeState = resolveRuntimeStateConfig({ rootDir, args, loadedConfig: loaded.config });
  const skillsConfig = { ...resolveSkillsConfig(loaded.config), root: runtimeState.skillsRoot };
  const executionBoundaries = await readExecutionBoundaries({ metadataStore: injectedStores.metadata });
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
    ui: await resolveUiConfig(resolverArgs, loaded.config),
    chatToolLoopConfig: resolveChatToolLoopConfig(loaded.config),
    skillsConfig,
    contextConfig: resolveContextConfig(args, loaded.config),
  };
}
