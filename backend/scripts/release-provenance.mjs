import { promises as fs } from 'node:fs';
import path from 'node:path';

const sha = /^[0-9a-f]{40}$/;

export async function releaseProvenance(root) {
  try {
    const value = JSON.parse(await fs.readFile(path.join(root, 'RELEASE_PROVENANCE.json'), 'utf8'));
    if (!sha.test(value.backend) || !sha.test(value.ui) || !sha.test(value.nodeGoblin) || typeof value.assembly !== 'string' || !value.assembly) return null;
    return { assembly: value.assembly, backend: value.backend, ui: value.ui, nodeGoblin: value.nodeGoblin };
  } catch { return null; }
}
