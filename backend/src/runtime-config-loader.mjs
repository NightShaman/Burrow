import { loadBurrowConfig, resolveModelConfig, configDefaults, resolveRuntimeStateConfig, resolveUiConfig, resolveChatToolLoopConfig, resolveSkillsConfig, resolveContextConfig } from './config.mjs';
import { readExecutionBoundaries } from './execution-boundaries.mjs';

export async function loadRuntimeConfig({ rootDir, args = {}, tolerateModelResolutionError = false } = {}) {
  const loaded = await loadBurrowConfig({ rootDir });
  const runtimeState = resolveRuntimeStateConfig({ rootDir, args, loadedConfig: loaded.config });
  const skillsConfig = { ...resolveSkillsConfig(loaded.config), root: runtimeState.skillsRoot };
  const executionBoundaries = readExecutionBoundaries({ databasePath: runtimeState.settingsDatabasePath });
  let modelConfig = null;
  let modelResolutionError = null;
  try {
    modelConfig = await resolveModelConfig(args, loaded.config);
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
    ui: await resolveUiConfig({ ...args, settings_database_path: runtimeState.settingsDatabasePath }, loaded.config),
    chatToolLoopConfig: resolveChatToolLoopConfig(loaded.config),
    skillsConfig,
    contextConfig: resolveContextConfig(args, loaded.config),
  };
}
