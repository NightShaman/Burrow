import { promises as fs } from 'node:fs';
import path from 'node:path';

// The configured workspace is the trust boundary; reject links at and below it.
// This is a preflight check, not an atomic defense against directory replacement.
export async function validateArtifactRoot(workspaceInput, root, { missing = false } = {}) {
  const workspace = path.resolve(workspaceInput);
  const relative = path.relative(workspace, root);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
  let current = workspace;
  for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
    if (part) current = path.join(current, part);
    let stat;
    try { stat = await fs.lstat(current); }
    catch (error) { if (missing && error?.code === 'ENOENT') continue; if (error?.code === 'ENOENT') return false; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  }
  return true;
}
