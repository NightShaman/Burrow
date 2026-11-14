import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manifest, selectedFiles } from './run-critical-backend.mjs';

test('Public critical backend manifest is an explicit small allowlist of actual behavioral cases', () => {
  assert.equal(manifest.schemaVersion, 1);
  assert.ok(manifest.files.length >= 8 && manifest.files.length <= 15);
  assert.ok(manifest.files.some(file => file.includes('migration-baseline')));
  assert.ok(manifest.files.some(file => file.includes('portable-install-restore')));
  for (const area of ['chat', 'tools', 'auth', 'provider']) assert.ok(manifest.files.some(file => file.includes(area) || area === 'tools' && file.includes('developer-tools')), area);
  assert.ok(manifest.files.every(file => !/performance|scale|source-string/.test(file)));
});
test('critical backend runner rejects absent, duplicate and traversal entries before launching npm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'critical-backend-'));
  try {
    mkdirSync(join(dir, 'tests'));
    writeFileSync(join(dir, 'tests', 'real.test.mjs'), '');
    assert.deepEqual(selectedFiles(dir, { schemaVersion: 1, files: ['tests/real.test.mjs'] }), ['tests/real.test.mjs']);
    for (const files of [['tests/missing.test.mjs'], ['tests/real.test.mjs', 'tests/real.test.mjs'], ['tests/../other.test.mjs']]) {
      assert.throws(() => selectedFiles(dir, { schemaVersion: 1, files }));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
