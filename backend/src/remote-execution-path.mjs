import path from 'node:path';

function remotePathFlavor(value) {
  if (typeof value !== 'string' || value.includes('\0')) return null;
  if (/^[a-z]:[\\/]/i.test(value)) return path.win32;
  if (/^[\\/]{2}/.test(value)) {
    // Double-leading separators are reserved for normal UNC paths.
    const [server, share, ...components] = value.slice(2).split(/[\\/]/);
    const invalidName = /[<>:"|?*\x00-\x1f]/;
    if ([server, share].some(name => !name || invalidName.test(name) || /[. ]$/.test(name))) return null;
    if (components.some((name, index) =>
      invalidName.test(name) || (!name && index !== components.length - 1))) return null;
    return path.win32;
  }
  return path.posix.isAbsolute(value) ? path.posix : null;
}

// A known workspace selects the target's path semantics, independently of Core's OS.
export function isAbsoluteRemotePath(value, workspaceRoot = null) {
  const flavor = remotePathFlavor(value);
  return flavor !== null && (workspaceRoot == null || flavor === remotePathFlavor(workspaceRoot));
}

export function isInvalidRemotePath(value, workspaceRoot = null) {
  // A drive-colon filename is relative in POSIX; only Windows workspaces
  // reserve drive-relative names. Fully qualified foreign paths stay invalid.
  return typeof value !== 'string' || value.includes('\0')
    || (/^[a-z]:[\\/]|^[\\/]{2}|^\//i.test(value) && !isAbsoluteRemotePath(value, workspaceRoot))
    || (/^[a-z]:/i.test(value) && remotePathFlavor(workspaceRoot) !== path.posix && !isAbsoluteRemotePath(value, workspaceRoot))
    || (remotePathFlavor(workspaceRoot) === path.win32 && value.startsWith('\\') && !isAbsoluteRemotePath(value, workspaceRoot));
}

export function resolveRemotePath(value, workspaceRoot) {
  const flavor = remotePathFlavor(workspaceRoot);
  if (isAbsoluteRemotePath(value, workspaceRoot)) return value;
  if (isInvalidRemotePath(value, workspaceRoot) || !flavor) {
    throw new Error('remote_path_invalid');
  }
  const resolved = flavor.resolve(workspaceRoot, value);
  if (!isAbsoluteRemotePath(resolved)) throw new Error('remote_path_invalid');
  return resolved;
}

export function normalizeRemotePathForMatching(value, { ignoreWindowsCase = false } = {}) {
  const flavor = remotePathFlavor(value);
  const normalized = flavor?.resolve(value);
  if (flavor !== path.win32) return normalized;
  const withSlashes = normalized.replaceAll('\\', '/');
  return ignoreWindowsCase ? withSlashes.toLowerCase() : withSlashes;
}
