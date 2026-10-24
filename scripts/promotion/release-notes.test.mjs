import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { generateReleaseNotes } from './release-notes.mjs';

const run = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function fixture(subjects) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'burrow-release-notes-'));
  run(root, 'init', '-q', '-b', 'main');
  run(root, 'config', 'user.name', 'Fixture');
  run(root, 'config', 'user.email', 'fixture@example.invalid');
  let first;
  for (const [index, subject] of subjects.entries()) {
    fs.appendFileSync(path.join(root, 'fixture'), `${index}\n`);
    run(root, 'add', '.');
    run(root, 'commit', '-q', '-m', subject);
    if (index === 0) first = run(root, 'rev-parse', 'HEAD');
  }
  return { root, first, current: run(root, 'rev-parse', 'HEAD') };
}

test('component notes contain only that repository and omit provenance noise', () => {
  const skills = fixture(['chore: previous public state', 'feat: update managed skills']);
  const backend = fixture(['chore: previous backend state', 'fix: unrelated backend change']);
  try {
    const notes = generateReleaseNotes({
      target: 'burrowSkills',
      releaseDate: '2026.10.19',
      sources: { burrowSkills: skills.current, burrowBackend: backend.current },
      previousSources: { burrowSkills: skills.first, burrowBackend: backend.first },
      roots: { burrowSkills: skills.root, burrowBackend: backend.root }
    });
    assert.match(notes, /^# Burrow Skills 2026\.10\.19/m);
    assert.match(notes, /feat: update managed skills/);
    assert.doesNotMatch(notes, /unrelated backend change/);
    assert.doesNotMatch(notes, /Frozen sources/);
    assert.doesNotMatch(notes, /[0-9a-f]{7}/);
  } finally {
    fs.rmSync(skills.root, { recursive: true, force: true });
    fs.rmSync(backend.root, { recursive: true, force: true });
  }
});

test('Theater notes contain only Theater changes', () => {
  const theater = fixture(['chore: previous Theater state', 'feat: improve roleplay']);
  const backend = fixture(['chore: previous backend state', 'fix: unrelated backend change']);
  try {
    const notes = generateReleaseNotes({
      target: 'burrowTheater',
      releaseDate: '2026.10.22',
      sources: { burrowTheater: theater.current, burrowBackend: backend.current },
      previousSources: { burrowTheater: theater.first, burrowBackend: backend.first },
      roots: { burrowTheater: theater.root, burrowBackend: backend.root }
    });
    assert.match(notes, /^# Burrow Theater 2026\.10\.22/m);
    assert.match(notes, /feat: improve roleplay/);
    assert.doesNotMatch(notes, /unrelated backend change/);
  } finally {
    fs.rmSync(theater.root, { recursive: true, force: true });
    fs.rmSync(backend.root, { recursive: true, force: true });
  }
});

test('Switchboard notes contain only Switchboard changes', () => {
  const switchboard = fixture(['chore: previous Switchboard state', 'feat: improve Telegram routing']);
  const backend = fixture(['chore: previous backend state', 'fix: unrelated backend change']);
  try {
    const notes = generateReleaseNotes({
      target: 'burrowSwitchboard',
      releaseDate: '2026.10.24',
      sources: { burrowSwitchboard: switchboard.current, burrowBackend: backend.current },
      previousSources: { burrowSwitchboard: switchboard.first, burrowBackend: backend.first },
      roots: { burrowSwitchboard: switchboard.root, burrowBackend: backend.root }
    });
    assert.match(notes, /^# Burrow Switchboard 2026\.10\.24/m);
    assert.match(notes, /feat: improve Telegram routing/);
    assert.doesNotMatch(notes, /unrelated backend change/);
  } finally {
    fs.rmSync(switchboard.root, { recursive: true, force: true });
    fs.rmSync(backend.root, { recursive: true, force: true });
  }
});

test('Burrow notes include only assembled Burrow, backend, and UI changes', () => {
  const burrow = fixture(['chore: previous Burrow state', 'build: assemble Burrow', 'feat: installer improvement']);
  const backend = fixture(['chore: previous backend state', 'fix: backend behavior']);
  const ui = fixture(['chore: previous UI state', 'feat: UI behavior']);
  const skills = fixture(['chore: previous skills state', 'docs: unrelated skill change']);
  try {
    const notes = generateReleaseNotes({
      target: 'burrow',
      releaseDate: '2026.10.19',
      sources: { burrow: burrow.current, burrowBackend: backend.current, burrowUi: ui.current, burrowSkills: skills.current },
      previousSources: { burrow: burrow.first, burrowBackend: backend.first, burrowUi: ui.first, burrowSkills: skills.first },
      roots: { burrow: burrow.root, burrowBackend: backend.root, burrowUi: ui.root, burrowSkills: skills.root }
    });
    assert.match(notes, /installer improvement/);
    assert.match(notes, /backend behavior/);
    assert.match(notes, /UI behavior/);
    assert.doesNotMatch(notes, /assemble Burrow/);
    assert.doesNotMatch(notes, /unrelated skill change/);
  } finally {
    for (const item of [burrow, backend, ui, skills]) fs.rmSync(item.root, { recursive: true, force: true });
  }
});

test('rejects unknown release-note targets', () => {
  assert.throws(() => generateReleaseNotes({ target: 'wat', releaseDate: '2026.10.19', sources: {}, roots: {} }), /unknown release-note target/);
});
