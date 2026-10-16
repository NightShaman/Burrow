// Compose the worker at the outer boundary, not inside the recursive execution
// implementation. This keeps nested child dispatch explicit without a static cycle.
import { executeReviewedProposalActions as execute } from './proposal-execution.mjs';
import { runSpawnSubagentChild } from './subagent-worker-runner.mjs';
import { resolveNativeFilesystemExecutionTarget } from './native-filesystem-execution-router.mjs';

export function executeReviewedProposalActions(options = {}) {
  const remote = resolveNativeFilesystemExecutionTarget(options.executionContext || {}).kind === 'remote';
  return execute({ ...options, childRunner: options.childRunner || (remote ? runSpawnSubagentChild : null) });
}
