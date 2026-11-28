import path from 'node:path';
import { isAbsoluteRemotePath } from './remote-execution-path.mjs';

function normalizeRoot(value, remote) {
  if (value == null) return null;
  const text = remote ? String(value) : String(value).trim();
  if (!text || !(remote ? isAbsoluteRemotePath(text) : path.isAbsolute(text))) return null;
  return remote ? text : path.resolve(text);
}

/**
 * Structural workspace facts for one turn.
 *
 * This intentionally does not inspect the filesystem or interpret prose. It
 * preserves the legacy resolver result shape only so downstream consumers can
 * migrate without receiving inferred project authority.
 */
export function turnWorkspaceFacts({ configuredWorkspaceRoot = null, requestedWorkspaceRoot = null, remote = false } = {}) {
  const configured = normalizeRoot(configuredWorkspaceRoot, remote);
  const candidate = normalizeRoot(requestedWorkspaceRoot, remote);
  const requested = remote && candidate && configured && !isAbsoluteRemotePath(candidate, configured) ? null : candidate;
  const workspaceRoot = requested || configured;
  return Object.freeze({
    workspaceRoot,
    resolved: Boolean(requested),
    reason: requested ? 'explicit_workspace_request' : (configured ? 'configured_workspace_root' : 'no_workspace_root'),
    candidates: [],
    previousWorkspaceRoot: configured,
    projectHint: null,
  });
}
