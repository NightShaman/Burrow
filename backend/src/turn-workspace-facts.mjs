import path from 'node:path';

function normalizeRoot(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || !path.isAbsolute(text)) return null;
  return path.resolve(text);
}

/**
 * Structural workspace facts for one turn.
 *
 * This intentionally does not inspect the filesystem or interpret prose. It
 * preserves the legacy resolver result shape only so downstream consumers can
 * migrate without receiving inferred project authority.
 */
export function turnWorkspaceFacts({ configuredWorkspaceRoot = null, requestedWorkspaceRoot = null } = {}) {
  const configured = normalizeRoot(configuredWorkspaceRoot);
  const requested = normalizeRoot(requestedWorkspaceRoot);
  const workspaceRoot = requested || configured;
  return Object.freeze({
    workspaceRoot,
    resolved: Boolean(requested),
    reason: requested ? 'explicit_workspace_root' : (configured ? 'configured_workspace_root' : 'no_workspace_root'),
    candidates: [],
    previousWorkspaceRoot: configured,
    projectHint: null,
  });
}
