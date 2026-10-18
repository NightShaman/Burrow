import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateReleaseNotes } from './release-notes.mjs';

const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

test('builds notes from frozen commit ranges and omits generated release noise', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-release-notes-'));
  try {
    run(root, 'init', '-q', '-b', 'main');
    run(root, 'config', 'user.name', 'Fixture');
    run(root, 'config', 'user.email', 'fixture@example.invalid');
    fs.writeFileSync(path.join(root, 'fixture'), 'one\n');
    run(root, 'add', '.'); run(root, 'commit', '-q', '-m', 'feat: first useful change');
    const first = run(root, 'rev-parse', 'HEAD');
    fs.appendFileSync(path.join(root, 'fixture'), 'two\n');
    run(root, 'add', '.'); run(root, 'commit', '-q', '-m', 'build: assemble Burrow');
    fs.appendFileSync(path.join(root, 'fixture'), 'three\n');
    run(root, 'add', '.'); run(root, 'commit', '-q', '-m', 'fix: visible correction');
    const current = run(root, 'rev-parse', 'HEAD');
    const notes = generateReleaseNotes({
      releaseDate: '2026.10.18',
      sources: { burrow: current },
      previousSources: { burrow: first },
      roots: { burrow: root }
    });
    assert.match(notes, /fix: visible correction/);
    assert.doesNotMatch(notes, /build: assemble Burrow/);
    assert.match(notes, /Frozen sources/);
    assert.match(notes, new RegExp(current));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
