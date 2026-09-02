import { loadBurrowConfig, resolveModelConfig, configDefaults, resolveRuntimeStateConfig, resolveUiConfig, resolveChatToolLoopConfig, resolveSkillsConfig, resolveContextConfig } from './config.mjs';
import { readExecutionBoundaries } from './execution-boundaries.mjs';

export async function loadRuntimeConfig({ rootDir, args = {} } = {}) {
  const loaded = await loadBurrowConfig({ rootDir });
  const runtimeState = resolveRuntimeStateConfig({ rootDir, args, loadedConfig: loaded.config });
  const skillsConfig = { ...resolveSkillsConfig(loaded.config), root: runtimeState.skillsRoot };
  const executionBoundaries = readExecutionBoundaries({ databasePath: runtimeState.settingsDatabasePath });
  return {
    loaded,
    defaults: configDefaults(loaded.config),
    modelConfig: await resolveModelConfig(args, loaded.config),
    executionBoundaries,
    runtimeState,
    ui: await resolveUiConfig({ ...args, settings_database_path: runtimeState.settingsDatabasePath }, loaded.config),
    chatToolLoopConfig: resolveChatToolLoopConfig(loaded.config),
    skillsConfig,
    contextConfig: resolveContextConfig(args, loaded.config),
  };
}
