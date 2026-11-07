import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, rmSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { TARGETS } from '../promotion/stage-snapshots.mjs';

test('assembly copies only launcher with its bytes and executable mode into archived public backend path', t => {
  const workflow = readFileSync(resolve('.github/workflows/assemble.yml'), 'utf8');
  const lines = workflow.split('\n').filter(x => /(?:install -d backend\/deploy\/installer|cp -a \.\.\/backend-source\/deploy\/installer\/burrow )/.test(x));
  assert.equal(lines.length, 2);
  assert.ok(TARGETS.burrow.paths.includes('backend'));
  assert.deepEqual(TARGETS.burrow.excludes, []);
  const root = mkdtempSync(join(tmpdir(), 'burrow-launcher-package-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'backend-source/deploy/installer');
  const assembled = join(root, 'assembled');
  mkdirSync(source, { recursive: true }); mkdirSync(assembled);
  const content = '#!/bin/sh\necho launcher-fixture\n';
  writeFileSync(join(source, 'burrow'), content, { mode: 0o755 });
  chmodSync(join(source, 'burrow'), 0o755);
  writeFileSync(join(source, 'unrelated'), 'must not ship');
  execFileSync('sh', ['-eu', '-c', lines.join('\n')], { cwd: assembled });
  const launcher = 'backend/deploy/installer/burrow';
  assert.equal(readFileSync(join(assembled, launcher), 'utf8'), content);
  assert.equal(statSync(join(assembled, launcher)).mode & 0o777, 0o755);
  execFileSync('git', ['init', '-q'], { cwd: assembled });
  execFileSync('git', ['add', 'backend'], { cwd: assembled });
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'fixture'], { cwd: assembled });
  const archive = join(root, 'payload.tar');
  execFileSync('git', ['archive', '--format=tar', `--output=${archive}`, 'HEAD', '--', ...TARGETS.burrow.paths.filter(x => x === 'backend')], { cwd: assembled });
  const unpack = join(root, 'unpack'); mkdirSync(unpack);
  execFileSync('tar', ['-xpf', archive, '-C', unpack]);
  assert.equal(readFileSync(join(unpack, launcher), 'utf8'), content);
  // git archive applies tar.umask; executable bits must survive the handoff.
  assert.equal(statSync(join(unpack, launcher)).mode & 0o111, 0o111);
  assert.throws(() => statSync(join(unpack, 'backend/deploy/installer/unrelated')));
});
