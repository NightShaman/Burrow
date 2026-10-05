import { mkdtempSync, writeFileSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const owned = mkdtempSync(join(tmpdir(), 'ui-guard-verification-'));
const before = new Set(readdirSync(tmpdir()).filter(x => x.startsWith('burrow-ui-test-')));
try {
  const sentinels = ['other-run-a', 'other-run-b'].map(x => join(owned, x));
  sentinels.forEach(x => writeFileSync(x, 'owned fixture'));
  const result = spawnSync(process.execPath, ['scripts/test-isolated.mjs', '--probe'], { stdio: 'inherit', env: { ...process.env, DATABASE_URL: 'synthetic', PGHOST: 'synthetic', PGUSER: 'synthetic', PGPASSWORD: 'synthetic' } });
  assert.equal(result.status, 0);
  sentinels.forEach(x => assert(existsSync(x), 'unrelated owned sentinel deleted'));
  const after = readdirSync(tmpdir()).filter(x => x.startsWith('burrow-ui-test-') && !before.has(x));
  assert.deepEqual(after, [], 'runner temp root leaked');
  console.log('PASS: two other-run sentinels survive; this run root cleaned');
} finally { rmSync(owned, { recursive: true, force: true }); }
