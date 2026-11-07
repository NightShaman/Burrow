import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('publisher creates once, skips existing releases, and propagates create failure', t => {
  const root = mkdtempSync(join(tmpdir(), 'publisher-')); t.after(() => rmSync(root, {recursive:true, force:true}));
  const bin = join(root, 'bin'); mkdirSync(bin);
  const gh = join(bin, 'gh');
  writeFileSync(gh, `#!/bin/sh\nprintf '%s\\n' "$*" >> "$LOG"\ncase "$2" in view) [ "$CASE" = existing ];; create) [ "$CASE" != failure ];; *) exit 9;; esac\n`); chmodSync(gh, 0o755);
  for (const scenario of ['existing', 'new', 'failure']) {
    const log = join(root, scenario);
    const result = spawnSync('sh', [fileURLToPath(new URL('./publish-release.sh', import.meta.url)), 'owner/Burrow', '2026.11.06', 'notes.md'], {cwd:root, env:{...process.env, PATH:`${bin}:${process.env.PATH}`, LOG:log, CASE:scenario}, encoding:'utf8'});
    assert.equal(result.status === 0, scenario !== 'failure');
    const calls = readFileSync(log, 'utf8');
    assert.match(calls, /release view v2026\.11\.06 --repo owner\/Burrow/);
    if (scenario === 'existing') assert.doesNotMatch(calls, /release create/);
    else assert.match(calls, /release create v2026\.11\.06 --repo owner\/Burrow --title Burrow 2026\.11\.06 --notes-file notes\.md/);
  }
});
