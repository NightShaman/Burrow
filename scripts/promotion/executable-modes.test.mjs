import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { executableModes, verifyExecutableModes } from './executable-modes.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promotion-modes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const staged = path.join(root, 'staged');
  const write = (file, mode) => {
    const target = path.join(staged, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `payload ${file}\n`);
    fs.chmodSync(target, mode);
  };
  write('Burrow/install.sh', 0o755);
  write('Burrow/backend/bin/nested helper', 0o755);
  write('Burrow/README.md', 0o644);
  write('Burrow/.github/workflows/docs.yml', 0o644);
  write('Node-Goblin/install.sh', 0o755);
  fs.symlinkSync('install.sh', path.join(staged, 'Burrow/installer-link'));
  return { root, staged };
}

test('tar round trip survives artifact mode normalization and preserves hidden files and symlinks', t => {
  const { root, staged } = fixture(t);
  const manifest = executableModes(staged);
  assert.deepEqual(manifest.executableFiles, ['Burrow/backend/bin/nested helper', 'Burrow/install.sh', 'Node-Goblin/install.sh']);
  fs.writeFileSync(path.join(root, 'executable-modes.json'), JSON.stringify(manifest));
  const archive = path.join(root, 'public-promotion.tar');
  execFileSync('tar', ['-cpf', archive, '-C', root, 'staged', 'executable-modes.json']);
  fs.chmodSync(archive, 0o644); // The artifact service normalizes the wrapper, not its payload.
  const restored = path.join(root, 'restored');
  fs.mkdirSync(restored);
  execFileSync('tar', ['-xpf', archive, '-C', restored]);
  assert.equal(verifyExecutableModes(path.join(restored, 'staged'), JSON.parse(fs.readFileSync(path.join(restored, 'executable-modes.json')))), 3);
  assert.equal(fs.readFileSync(path.join(restored, 'staged/Burrow/.github/workflows/docs.yml'), 'utf8'), 'payload Burrow/.github/workflows/docs.yml\n');
  assert.equal(fs.readlinkSync(path.join(restored, 'staged/Burrow/installer-link')), 'install.sh');
});

test('loose artifact mode stripping is detected, including nested executables beyond install.sh', t => {
  const { staged } = fixture(t);
  const manifest = executableModes(staged);
  fs.chmodSync(path.join(staged, 'Burrow/backend/bin/nested helper'), 0o644);
  assert.throws(() => verifyExecutableModes(staged, manifest), /missing=Burrow\/backend\/bin\/nested helper/);
});

test('detects lost installers, removed executables and unexpected executable files', t => {
  const { staged } = fixture(t);
  const manifest = executableModes(staged);
  fs.chmodSync(path.join(staged, 'Burrow/install.sh'), 0o644);
  fs.rmSync(path.join(staged, 'Node-Goblin/install.sh'));
  fs.chmodSync(path.join(staged, 'Burrow/README.md'), 0o755);
  assert.throws(() => verifyExecutableModes(staged, manifest), /missing=Burrow\/install\.sh,Node-Goblin\/install\.sh unexpected=Burrow\/README\.md/);
});

test('rejects missing, malformed and duplicate executable manifests', t => {
  const { staged } = fixture(t);
  for (const manifest of [null, {}, { schemaVersion: 2, executableFiles: [] }, { schemaVersion: 1, executableFiles: [null] }, { schemaVersion: 1, executableFiles: ['a', 'a'] }]) {
    assert.throws(() => verifyExecutableModes(staged, manifest), /manifest_invalid/);
  }
});
