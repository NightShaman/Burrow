// Public composition boundary. The worker depends on the executor implementation,
// never this facade; local process dispatch remains owned by the spawn executor.
import { executeSpawnSubagentTool as executeSpawn } from './subagent-spawn-execution.mjs';
import { runSpawnSubagentChild } from './subagent-worker-runner.mjs';
import { resolveNativeFilesystemExecutionTarget } from './native-filesystem-execution-router.mjs';

export function executeSpawnSubagentTool(options = {}) {
  return executeSpawn({ ...options, childRunner: options.childRunner || (resolveNativeFilesystemExecutionTarget(options.executionContext || {}).kind === 'remote' ? runSpawnSubagentChild : null) });
}
