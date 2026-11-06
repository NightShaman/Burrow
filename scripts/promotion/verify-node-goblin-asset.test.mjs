import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { verifyNodeGoblinAsset } from './verify-node-goblin-asset.mjs';

const version = '2026.11.06';
test('Node Goblin staged package and checksummed asset have same public version and frozen SHA', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-node-asset-'));
  const root = path.join(temp, 'staged'), assetRoot = path.join(temp, 'assets');
  const gateway = path.join(root, 'Node-Goblin/gateway');
  try {
    fs.mkdirSync(gateway, { recursive: true });
    fs.writeFileSync(path.join(gateway, 'VERSION'), `${version}\n`);
    fs.writeFileSync(path.join(gateway, 'package.json'), JSON.stringify({ version }));
    fs.writeFileSync(path.join(gateway, 'cli.mjs'), 'export default 42;\n');
    fs.writeFileSync(path.join(gateway, 'node-goblin.mjs'), 'export default 24;\n');
    fs.writeFileSync(path.join(gateway, 'index.mjs'), 'export default 1;\n');
    fs.mkdirSync(path.join(gateway, 'lib')); fs.mkdirSync(path.join(gateway, 'deploy'));
    fs.writeFileSync(path.join(gateway, 'lib/helper.mjs'), 'export default 3;\n');
    fs.writeFileSync(path.join(gateway, 'deploy/install.sh'), '#!/bin/sh\n');
    const manifest = { schemaVersion: 1, releaseDate: version, sources: { nodeGoblin: 'a'.repeat(40) } };
    fs.writeFileSync(path.join(root, 'Node-Goblin/PUBLIC_RELEASE.json'), `${JSON.stringify(manifest)}\n`);
    fs.writeFileSync(path.join(root, 'Node-Goblin/install.sh'), 'REPOSITORY=${NODE_GOBLIN_REPOSITORY:-GoblinKing-Burrow/Node-Goblin}\n# releases/download/v$VERSION\n# sha256sum -c\n');
    fs.mkdirSync(assetRoot);
    const name = `node-goblin-${version}`;
    const packageRoot = path.join(temp, name);
    fs.mkdirSync(packageRoot);
    fs.copyFileSync(path.join(gateway, 'VERSION'), path.join(packageRoot, 'VERSION'));
    fs.cpSync(gateway, packageRoot, { recursive: true });
    execFileSync('tar', ['-czf', path.join(assetRoot, `${name}.tar.gz`), '-C', temp, name]);
    fs.writeFileSync(path.join(assetRoot, `${name}.tar.gz.sha256`), execFileSync('sha256sum', [`${name}.tar.gz`], { cwd: assetRoot }));
    assert.equal(verifyNodeGoblinAsset({ stageRoot: root, assetRoot, version }).sourceSha, 'a'.repeat(40));
    fs.writeFileSync(path.join(root, 'Node-Goblin/install.sh'), 'REPOSITORY=${NODE_GOBLIN_REPOSITORY:-NightShaman/Node-Goblin}\n');
    assert.throws(() => verifyNodeGoblinAsset({ stageRoot: root, assetRoot, version }), /public installer authority/);
    fs.writeFileSync(path.join(root, 'Node-Goblin/install.sh'), 'REPOSITORY=${NODE_GOBLIN_REPOSITORY:-GoblinKing-Burrow/Node-Goblin}\n# releases/download/v$VERSION\n# sha256sum -c\n');
    fs.writeFileSync(path.join(gateway, 'lib/helper.mjs'), 'export default 999;\n');
    assert.throws(() => verifyNodeGoblinAsset({ stageRoot: root, assetRoot, version }), /differs from staged source: lib\/helper.mjs/);
    fs.writeFileSync(path.join(gateway, 'lib/helper.mjs'), 'export default 3;\n');
    fs.writeFileSync(path.join(gateway, 'VERSION'), '2026.11.05\n');
    assert.throws(() => verifyNodeGoblinAsset({ stageRoot: root, assetRoot, version }), /gateway identity mismatch/);
    fs.writeFileSync(path.join(gateway, 'VERSION'), `${version}\n`);
    fs.writeFileSync(path.join(assetRoot, `node-goblin-${version}.tar.gz.sha256`), `${'0'.repeat(64)}  node-goblin-${version}.tar.gz\n`);
    assert.throws(() => verifyNodeGoblinAsset({ stageRoot: root, assetRoot, version }), /sha256sum/);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
});
test('helper asset is verified before any public publish, and publish uses the same archived artifact', () => {
  const workflow = fs.readFileSync(new URL('../../.github/workflows/daily-public-promotion.yml', import.meta.url), 'utf8');
  const build = workflow.indexOf('SOURCE_DATE_EPOCH=0 sh staged/Node-Goblin/gateway/deploy/build-release.sh release-assets/nodeGoblin');
  const verify = workflow.indexOf('verify-node-goblin-asset.mjs staged release-assets/nodeGoblin "$VERSION"');
  const bundle = workflow.indexOf('tar -cpf public-promotion.tar');
  const publishing = workflow.indexOf('- name: Publish immutable Git snapshots');
  assert.ok(build > 0 && build < verify && verify < bundle && bundle < publishing);
  assert.match(workflow.slice(bundle, publishing), /release-assets/);
  assert.match(workflow.slice(publishing), /"release-assets\/nodeGoblin\/node-goblin-\$VERSION.tar.gz"/);
  assert.doesNotMatch(workflow.slice(publishing), /build-release.sh/);
});
