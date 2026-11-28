import { isAbsoluteRemotePath } from './remote-execution-path.mjs';
import { randomUUID } from 'node:crypto';
import { resolveExecutionTarget } from './execution-context.mjs';
import { createNativeFilesystemExecutionRouter, resolveNativeFilesystemExecutionTarget } from './native-filesystem-execution-router.mjs';
import { statPathEnvelope } from './harness/developer-tools.mjs';

// Structural turn targets must be checked where tools actually run. The
// controller does not have access to an assigned host's filesystem.
export async function resolveRuntimeTurnTarget(request, { agentRuntime = null, filesystemBoundaries = [], runId = null } = {}) {
  if (agentRuntime?.executionEnvironment?.kind !== 'remote') return resolveExecutionTarget(request, { filesystemBoundaries });
  if (!request || typeof request !== 'object') throw new Error('target_request_must_be_object');
  if (request.kind !== 'filesystem') throw new Error(`unsupported_target_kind:${request.kind || 'missing'}`);
  const root = typeof request.root === 'string' ? request.root : '';
  const workspaceRoot = agentRuntime.executionEnvironment.workspaceRoot;
  if (!isAbsoluteRemotePath(root, workspaceRoot)) throw new Error('target_root_must_be_absolute');
  const route = createNativeFilesystemExecutionRouter({
    localExecute: async ({ arguments: args }) => statPathEnvelope(args),
    remoteController: agentRuntime.processExecutionController,
  });
  const result = await route({
    target: resolveNativeFilesystemExecutionTarget(agentRuntime),
    operation: { tool: 'files_inspect', arguments: { path: root, workspaceRoot } },
  }, { parentRunId: runId || 'turn-target-validation', toolCallId: `target-${randomUUID()}` });
  if (!result?.ok) throw new Error(result?.error || 'target_validation_failed');
  if (!result.exists || result.type !== 'directory') throw new Error('target_root_not_found');
  const resolvedRoot = result.path || root;
  if (!isAbsoluteRemotePath(resolvedRoot, workspaceRoot)) throw new Error('target_root_must_be_absolute');
  return Object.freeze({ kind: 'filesystem', root: resolvedRoot, boundaries: [] });
}
