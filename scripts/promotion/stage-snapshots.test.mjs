import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setNodeGoblinReleaseAuthority, TARGETS, validateInputs } from './stage-snapshots.mjs';

const sha = 'a'.repeat(40);
const sources = { burrow: sha, burrowBackend: sha, burrowUi: sha, nodeGoblin: sha, goblinSecretStore: sha, burrowSkills: sha, burrowBackdoor: sha };

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
