import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = mkdtempSync(join(tmpdir(), 'burrow-ui-test-'));
try {
  const home = join(root, 'home'), tmp = join(root, 'tmp');
  mkdirSync(home); mkdirSync(tmp);
  const env = { PATH: process.env.PATH || '/usr/bin:/bin', HOME: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp,
    LANG: 'C.UTF-8', NODE_ENV: 'test', NODE_OPTIONS: `--require=${resolve('scripts/deny-network.cjs')}` };
  const args = process.argv.slice(2);
  const probe = args[0] === '--probe';
  const result = spawnSync(process.execPath, probe ? ['scripts/isolation-probe.cjs'] : ['node_modules/vitest/vitest.mjs', 'run', ...args], { env, stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally { rmSync(root, { recursive: true, force: true }); }
