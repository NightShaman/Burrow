import { loadBurrowConfig, resolveModelConfig, configDefaults, resolveRuntimeStateConfig, resolveUiConfig, resolveChatToolLoopConfig, resolveSkillsConfig, resolveContextConfig } from './config.mjs';
import { readExecutionBoundaries } from './execution-boundaries.mjs';
import { migrateLegacyAgentState } from './runtime-state-migration.mjs';

export async function loadRuntimeConfig({ rootDir, args = {} } = {}) {
  const loaded = await loadBurrowConfig({ rootDir });
  const runtimeState = resolveRuntimeStateConfig({ rootDir, args, loadedConfig: loaded.config });
  runtimeState.migration = await migrateLegacyAgentState({ runtimeRoot: runtimeState.runtimeRoot, workspaceRoot: runtimeState.workspaceRoot, agentId: runtimeState.agentId, legacyAgentDataRoot: runtimeState.legacyAgentDataRoot });
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
