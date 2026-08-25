import path from 'node:path';

function inside(child, parent) {
  if (!child || !parent) return false;
  const resolvedChild = path.resolve(child);
  const resolvedParent = path.resolve(parent);
  return resolvedChild === resolvedParent || resolvedChild.startsWith(`${resolvedParent}${path.sep}`);
}

export function contextBoundaryViolation({ rootDir = null, dataRoot = null, agentWorkspaceRoot = null, agentDataRoot = null, cacheRoot = null } = {}) {
  if (agentWorkspaceRoot && agentDataRoot && inside(agentWorkspaceRoot, agentDataRoot)) {
    return { field: 'agentWorkspaceRoot', value: path.resolve(agentWorkspaceRoot), forbiddenRoot: path.resolve(agentDataRoot), reason: 'agent_workspace_inside_agent_data' };
  }
  const forbidden = [
    ['rootDir', rootDir],
    ['dataRoot', dataRoot],
  ];
  for (const [field, value] of forbidden) {
    if (inside(value, agentDataRoot)) return { field, value: path.resolve(value), forbiddenRoot: path.resolve(agentDataRoot), reason: 'agent_data_root_not_context' };
    if (inside(value, cacheRoot)) return { field, value: path.resolve(value), forbiddenRoot: path.resolve(cacheRoot), reason: 'cache_root_not_context' };
  }
  return null;
}

export function assertContextBoundary(options = {}) {
  const violation = contextBoundaryViolation(options);
  if (!violation) return;
  const error = new Error(`context boundary violation: ${violation.reason}`);
  error.code = 'CONTEXT_BOUNDARY_VIOLATION';
  error.boundary = violation;
  throw error;
}
