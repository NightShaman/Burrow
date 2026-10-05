import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

// Content identity, never an installation path. Works in native backend and
// standalone package layouts, including development trees without RELEASE_ID.
export async function buildIdentity(root) {
  const hash = createHash('sha256');
  for (const file of ['package.json', 'scripts/burrow-ui.mjs']) {
    hash.update(file); hash.update(await fs.readFile(path.join(root, file)));
  }
  return hash.digest('hex');
}
