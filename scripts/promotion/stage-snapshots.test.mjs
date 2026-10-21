import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setBurrowReleaseAuthority, setNodeGoblinReleaseAuthority, TARGETS, validateInputs } from './stage-snapshots.mjs';

const sha = 'a'.repeat(40);
const sources = { burrow: sha, burrowBackend: sha, burrowUi: sha, nodeGoblin: sha, goblinSecretStore: sha, burrowSkills: sha, burrowBackdoor: sha, burrowTutor: sha, burrowTheater: sha };

test('accepts the complete frozen source set', () => {
  assert.doesNotThrow(() => validateInputs({ releaseDate: '2026.10.17', sources }));
});

test('public skills snapshot includes every supported skill directory', () => {
  for (const directory of ['burrow-backdoor', 'burrow-runtime', 'goblin-secret-store', 'node-goblin-operations']) {
    assert.ok(TARGETS.burrowSkills.paths.includes(directory), `missing public skill directory: ${directory}`);
  }
});

test('rejects revision suffixes and incomplete source sets', () => {
  assert.throws(() => validateInputs({ releaseDate: '2026.10.17.1', sources }), /promotion_release_date_invalid/);
  const incomplete = { ...sources }; delete incomplete.burrowUi;
  assert.throws(() => validateInputs({ releaseDate: '2026.10.17', sources: incomplete }), /promotion_source_missing:burrowUi/);
});

test('public snapshot rewrites Burrow installer release authority', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-public-authority-'));
  try {
    const installer = path.join(root, 'install.sh');
    fs.writeFileSync(installer, 'DEFAULT_REPOSITORY="NightShaman/Burrow"\nREPOSITORY="${BURROW_UPDATE_REPOSITORY:-$DEFAULT_REPOSITORY}"\n');
    setBurrowReleaseAuthority(root, 'GoblinKing-Burrow/Burrow');
    assert.equal(fs.readFileSync(installer, 'utf8'), 'DEFAULT_REPOSITORY="GoblinKing-Burrow/Burrow"\nREPOSITORY="${BURROW_UPDATE_REPOSITORY:-$DEFAULT_REPOSITORY}"\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('public snapshot fails closed when Burrow installer authority is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-public-authority-'));
  try {
    fs.writeFileSync(path.join(root, 'install.sh'), '#!/bin/sh\n');
    assert.throws(() => setBurrowReleaseAuthority(root, 'GoblinKing-Burrow/Burrow'), /burrow_installer_authority_missing/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('public snapshot rewrites Node Goblin installer release authority', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-goblin-public-authority-'));
  try {
    const installer = path.join(root, 'install.sh');
    fs.writeFileSync(installer, 'REPOSITORY=${NODE_GOBLIN_REPOSITORY:-NightShaman/Node-Goblin}\n');
    setNodeGoblinReleaseAuthority(root, 'GoblinKing-Burrow/Node-Goblin');
    assert.equal(fs.readFileSync(installer, 'utf8'), 'REPOSITORY=${NODE_GOBLIN_REPOSITORY:-GoblinKing-Burrow/Node-Goblin}\n');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('public snapshot fails closed when Node Goblin installer authority is missing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'node-goblin-public-authority-'));
  try {
    fs.writeFileSync(path.join(root, 'install.sh'), '#!/bin/sh\n');
    assert.throws(() => setNodeGoblinReleaseAuthority(root, 'GoblinKing-Burrow/Node-Goblin'), /node_goblin_installer_authority_missing/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});


test('Node Goblin snapshot preserves documentation deployment without release workflows', () => {
  const paths = TARGETS.nodeGoblin.paths;
  assert.ok(paths.includes('.github/workflows/docs.yml'));
  assert.ok(!paths.includes('.github'));
  assert.ok(!paths.includes('.github/workflows'));
  assert.ok(!paths.includes('.github/workflows/release-node-goblin.yml'));
  assert.ok(TARGETS.nodeGoblin.excludes.includes('docs/audit-repair-pass-5.md'));
  assert.ok(TARGETS.nodeGoblin.excludes.includes('docs/repairs/lifecycle-pass-4.md'));
});


test('Goblin Secret Store snapshot preserves documentation without other workflows', () => {
  const paths = TARGETS.goblinSecretStore.paths;
  for (const file of ['.github/workflows/docs.yml', 'docs', 'mkdocs.yml', 'requirements-docs.txt', 'scripts/docs']) {
    assert.ok(paths.includes(file), `missing public documentation path: ${file}`);
  }
  assert.deepEqual(paths.filter(file => file.startsWith('.github')), ['.github/workflows/docs.yml']);
  assert.deepEqual(paths.filter(file => file.startsWith('scripts')), ['scripts/docs']);
});


test('Burrow Tutor snapshot includes the complete standalone author source without development workflows', () => {
  const paths = TARGETS.burrowTutor.paths;
  for (const file of ['README.md', 'LICENSE', 'burrow.mod.json', 'docs', 'package.json', 'scripts', 'server', 'test', 'ui']) {
    assert.ok(paths.includes(file), `missing public Tutor path: ${file}`);
  }
  assert.ok(!paths.some(file => file.startsWith('.github')));
});

test('Burrow Backdoor snapshot preserves documentation without other workflows', () => {
  const paths = TARGETS.burrowBackdoor.paths;
  for (const file of ['.github/workflows/docs.yml', 'docs', 'mkdocs.yml', 'requirements-docs.txt', 'scripts/docs']) {
    assert.ok(paths.includes(file), `missing public documentation path: ${file}`);
  }
  assert.deepEqual(paths.filter(file => file.startsWith('.github')), ['.github/workflows/docs.yml']);
  assert.deepEqual(paths.filter(file => file.startsWith('scripts')), ['scripts/docs']);
});

test('Burrow Theater snapshot includes the standalone mod without development workflows', () => {
  const paths = TARGETS.burrowTheater.paths;
  for (const file of ['README.md', 'LICENSE', 'burrow.mod.json', 'docs', 'package.json', 'server', 'test', 'ui']) {
    assert.ok(paths.includes(file), `missing public Theater path: ${file}`);
  }
  assert.ok(!paths.some(file => file.startsWith('.github')));
  assert.ok(!paths.includes('scripts'));
});
