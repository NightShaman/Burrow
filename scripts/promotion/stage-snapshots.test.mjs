import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setBurrowReleaseAuthority, setNodeGoblinReleaseAuthority, stampSkills, PUBLIC_SKILL_IDS, TARGETS, validateInputs } from './stage-snapshots.mjs';

const sha = 'a'.repeat(40);
const sources = { burrow: sha, burrowBackend: sha, burrowUi: sha, nodeGoblin: sha, goblinSecretStore: sha, burrowSkills: sha, burrowBackdoor: sha, burrowTutor: sha, burrowTheater: sha, burrowSwitchboard: sha };

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

test('Burrow Switchboard snapshot includes the standalone mod without development workflows', () => {
  const paths = TARGETS.burrowSwitchboard.paths;
  for (const file of ['README.md', 'LICENSE', 'burrow.mod.json', 'docs', 'package.json', 'server', 'test', 'ui']) {
    assert.ok(paths.includes(file), `missing public Switchboard path: ${file}`);
  }
  assert.ok(!paths.some(file => file.startsWith('.github')));
  assert.ok(!paths.includes('scripts'));
});


test('public snapshot stamps all four skill frontmatter versions without changing instructions', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-skill-versions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const originals = new Map();
  for (const [index, id] of PUBLIC_SKILL_IDS.entries()) {
    const newline = index % 2 ? '\r\n' : '\n';
    const content = ['---', `name: ${id}`, 'version: "2026.10.19.1"', 'description: "Keep exact instructions"', '---', '', '# Instructions', 'version: must not rewrite a body example', 'Unicode: 🟢 café', ''].join(newline);
    fs.mkdirSync(path.join(root, id));
    fs.writeFileSync(path.join(root, id, 'SKILL.md'), content);
    originals.set(id, content);
  }
  stampSkills(root, '2026.10.30', sources);
  for (const [id, original] of originals) {
    assert.equal(fs.readFileSync(path.join(root, id, 'SKILL.md'), 'utf8'), original.replace('version: "2026.10.19.1"', 'version: 2026.10.30'));
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, 'PUBLIC_RELEASE.json'))), { schemaVersion: 1, releaseDate: '2026.10.30', sources });
  // Restamping is idempotent, but Development revision suffixes are never Public identities.
  stampSkills(root, '2026.10.30', sources);
  assert.throws(() => stampSkills(root, '2026.10.30.4', sources), /promotion_release_date_invalid/);
});

test('public skill stamping rejects missing or duplicate frontmatter versions before writing', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-skill-versions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const id of PUBLIC_SKILL_IDS) {
    fs.mkdirSync(path.join(root, id));
    fs.writeFileSync(path.join(root, id, 'SKILL.md'), `---\nname: ${id}\nversion: 2026.10.19.1\n---\nBody\n`);
  }
  const first = path.join(root, PUBLIC_SKILL_IDS[0], 'SKILL.md');
  const last = path.join(root, PUBLIC_SKILL_IDS.at(-1), 'SKILL.md');
  const original = fs.readFileSync(first, 'utf8');
  for (const invalid of ['# No frontmatter\nversion: 2026.10.19.1\n', '---\nname: missing\n---\nBody\n', '---\nversion: one\nversion: two\n---\nBody\n']) {
    fs.writeFileSync(last, invalid);
    assert.throws(() => stampSkills(root, '2026.10.30', sources), /promotion_skill_version_invalid/);
    assert.equal(fs.readFileSync(first, 'utf8'), original);
    assert.equal(fs.existsSync(path.join(root, 'PUBLIC_RELEASE.json')), false);
  }
});
