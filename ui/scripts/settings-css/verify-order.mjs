// Baseline is the exact settings.css bytes at UI 31f2ec12 before U09.
// Check the actual app.css import order, not a separately maintained list.
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import postcss from 'postcss';
import { createHash } from 'node:crypto';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const app = readFileSync(resolve(root, 'src/app.css'), 'utf8');
const imports = [...app.matchAll(/^@import '([^']+)';$/gm)].map((m) => m[1]);
const start = imports.indexOf('./features/settings/settingsSharedIntro.css');
const end = imports.indexOf('./features/settings/agentReferenceSettings.css');
if (
  start < 0 ||
  end < start ||
  imports[start - 1] !== './features/settings/firstRunSetup.css' ||
  imports[end + 1] !== './features/groups/group-channels.css'
) {
  throw new Error('Settings CSS import boundaries changed');
}
const css = Buffer.concat(
  imports.slice(start, end + 1).map((path) => readFileSync(resolve(root, 'src', path))),
);
const hash = createHash('sha256').update(css).digest('hex');
const baseline = execFileSync(
  'git',
  ['show', '31f2ec12f4f0f4f0efbb3b631e1f120681ef61a2:src/features/settings/settings.css'],
  { cwd: root },
);
assert.equal(baseline.length, 63380);
assert.equal(
  createHash('sha256').update(baseline).digest('hex'),
  'eff458576f1085f9bfde87b9603800f6b82c020bf1f4fa3473c1311b14bfe877',
);
// Retain selectors, values (including meaningful internal whitespace), comments,
// node types and child order; omit only parser source positions/formatting raws.
function orderedTree(node) {
  const { raws, source, parent, nodes, ...fields } = node;
  return { ...fields, ...(nodes ? { nodes: nodes.map(orderedTree) } : {}) };
}
assert.deepEqual(
  orderedTree(postcss.parse(css.toString())),
  orderedTree(postcss.parse(baseline.toString())),
  'Ordered CSS AST differs',
);
// Additional strict byte guard: the ONLY permitted formatting difference is
// removal of redundant blank lines. No arbitrary whitespace normalization.
// Walk the baseline byte-for-byte: only a redundant LF immediately after
// another LF may be deleted. Insertions and all other changes fail.
let before = 0;
let after = 0;
const removedAt = [];
while (before < baseline.length) {
  if (baseline[before] === css[after]) {
    before++;
    after++;
    continue;
  }
  assert.equal(baseline[before], 10, 'Only LF deletion allowed');
  assert.equal(baseline[before - 1], 10, 'Only blank-line LF deletion allowed');
  removedAt.push(before++);
}
assert.equal(after, css.length, 'Candidate contains extra bytes');
assert.equal(removedAt.length, 19);
console.log('Deleted blank-line LF baseline byte offsets:', removedAt.join(', '));
assert.equal(baseline.length - css.length, 19, 'Unexpected whitespace delta');
console.log(
  `Settings CSS ordered AST identical; only 19 redundant LF bytes removed; ${css.length} bytes sha256 ${hash}`,
);
