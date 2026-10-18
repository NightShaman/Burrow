import assert from 'node:assert/strict';
import test from 'node:test';
import { validateInputs } from './stage-snapshots.mjs';

const sha = 'a'.repeat(40);
const sources = { burrow: sha, burrowBackend: sha, burrowUi: sha, nodeGoblin: sha, goblinSecretStore: sha, burrowSkills: sha, burrowBackdoor: sha };

test('accepts the complete frozen source set', () => {
  assert.doesNotThrow(() => validateInputs({ releaseDate: '2026.10.17', sources }));
});

test('rejects revision suffixes and incomplete source sets', () => {
  assert.throws(() => validateInputs({ releaseDate: '2026.10.17.1', sources }), /promotion_release_date_invalid/);
  const incomplete = { ...sources }; delete incomplete.burrowUi;
  assert.throws(() => validateInputs({ releaseDate: '2026.10.17', sources: incomplete }), /promotion_source_missing:burrowUi/);
});
