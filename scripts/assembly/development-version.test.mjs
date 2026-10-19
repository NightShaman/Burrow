import test from 'node:test';
import assert from 'node:assert/strict';
import { nextDevelopmentVersion } from './development-version.mjs';

test('starts each UTC date at revision one', () => {
  assert.equal(nextDevelopmentVersion({ date: '2026.10.19', currentVersion: '2026.10.18.14' }), '2026.10.19.1');
  assert.equal(nextDevelopmentVersion({ date: '2026.10.19', currentVersion: '2026.10.19' }), '2026.10.19.1');
});

test('increments the current UTC development revision', () => {
  assert.equal(nextDevelopmentVersion({ date: '2026.10.19', currentVersion: '2026.10.19.7' }), '2026.10.19.8');
});

test('rejects invalid build dates', () => {
  assert.throws(() => nextDevelopmentVersion({ date: '2026-10-19', currentVersion: '' }), /development_build_date_invalid/);
});
