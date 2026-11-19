import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { recordedPins } from './resolve-revisions.mjs';

export function assemblyDecision({ eventName, recorded, backend, ui, inputs }) {
  const pins = recordedPins(recorded);
  const prior = recorded.match(/^Burrow-Assembly-Inputs ([0-9a-f]{64})$/m)?.[1];
  return eventName !== 'repository_dispatch' || pins.backend !== backend || pins.ui !== ui || prior !== inputs;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2];
  // Git tree entries include modes and blob IDs, not timestamps or generated payload.
  const tree = execFileSync('git', ['-C', root, 'ls-tree', '-r', 'HEAD', '--', '.github', 'scripts'], { encoding: 'utf8' });
  const inputs = createHash('sha256').update(tree).digest('hex');
  const required = assemblyDecision({ eventName: process.env.EVENT_NAME, recorded: fs.readFileSync(`${root}/SOURCE_VERSIONS`, 'utf8'), backend: process.env.BACKEND_SHA, ui: process.env.UI_SHA, inputs });
  fs.appendFileSync(process.env.GITHUB_OUTPUT, `required=${required}\ninputs=${inputs}\n`);
}
