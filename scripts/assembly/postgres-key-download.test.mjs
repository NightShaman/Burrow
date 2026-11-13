import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';

const dockerfile = readFileSync(new URL('../../Dockerfile', import.meta.url), 'utf8');
const keySteps = dockerfile.match(/&& (curl[^\n]+) \\\n\s*&& (gpg[^\n]+) \\\n\s*&& (rm \/tmp\/postgresql\.asc)/);

function run(command, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-eu', '-c', command], { env });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stderr }));
  });
}

async function fixture(t, respond, rejectKey = false) {
  assert.ok(keySteps, 'download, dearmor and cleanup must be distinct &&-gated steps');
  const root = mkdtempSync(join(tmpdir(), 'burrow-pg-key-'));
  const server = createServer(respond);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(root, { recursive: true, force: true }); });
  // Keep real curl/HTTP behavior, while recording precisely what reaches GPG.
  writeFileSync(join(root, 'gpg'), '#!/bin/sh\nset -eu\ncp "$4" "$KEY_SEEN"\n' + (rejectKey ? 'exit 2\n' : 'cp "$4" "$3"\n'));
  chmodSync(join(root, 'gpg'), 0o755);
  const command = keySteps.slice(1).join(' && ')
    .replace('https://www.postgresql.org/media/keys/ACCC4CF8.asc', `http://127.0.0.1:${server.address().port}/key`)
    .replaceAll('/tmp/postgresql.asc', join(root, 'key.asc'))
    .replaceAll('/etc/apt/keyrings/postgresql.gpg', join(root, 'key.gpg'));
  return { root, command, env: { ...process.env, PATH: `${root}:${process.env.PATH}`, KEY_SEEN: join(root, 'seen') } };
}

test('key retrieval forces HTTP/1.1 with bounded retries and no streaming into GPG', () => {
  assert.ok(keySteps);
  for (const flag of ['--http1.1', '--retry 3', '--retry-all-errors', '--connect-timeout 15', '--max-time 60', '--output /tmp/postgresql.asc']) {
    assert.ok(keySteps[1].includes(flag), flag);
  }
  assert.ok(!keySteps[1].includes('|'));
  assert.ok(dockerfile.includes('signed-by=/etc/apt/keyrings/postgresql.gpg'));
});

test('truncated key download retries into a file and passes only complete bytes to GPG', async t => {
  let requests = 0;
  const f = await fixture(t, (req, res) => {
    requests++;
    assert.equal(req.httpVersion, '1.1');
    if (requests === 1) {
      res.writeHead(200, { 'Content-Length': 100 });
      res.end('partial');
    } else res.end('complete-key');
  });
  const result = await run(f.command, f.env);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(requests, 2);
  assert.equal(readFileSync(join(f.root, 'seen'), 'utf8'), 'complete-key');
  assert.equal(readFileSync(join(f.root, 'key.gpg'), 'utf8'), 'complete-key');
  assert.equal(existsSync(join(f.root, 'key.asc')), false);
});

test('exhausted HTTP failures fail closed without invoking GPG', async t => {
  let requests = 0;
  const f = await fixture(t, (_req, res) => { requests++; res.writeHead(503); res.end('unavailable'); });
  const result = await run(f.command, f.env);
  assert.notEqual(result.code, 0);
  assert.equal(requests, 4);
  assert.equal(existsSync(join(f.root, 'seen')), false);
  assert.equal(existsSync(join(f.root, 'key.gpg')), false);
});

test('GPG rejection remains fatal after a successful download', async t => {
  const f = await fixture(t, (_req, res) => res.end('invalid-key'), true);
  const result = await run(f.command, f.env);
  assert.equal(result.code, 2);
  assert.equal(readFileSync(join(f.root, 'seen'), 'utf8'), 'invalid-key');
  assert.equal(existsSync(join(f.root, 'key.gpg')), false);
});

test('assembly SQL gate requires a complete bounded key download before installing it', () => {
  const workflow = readFileSync(new URL('../../.github/workflows/assemble.yml', import.meta.url), 'utf8');
  const step = workflow.split('      - name: Install PostgreSQL 17 with pgvector for owned SQL component gate')[1].split('      - name: Gate development assembly')[0];
  const lines = step.trim().split('\n').map(line => line.trim());
  const curl = lines.findIndex(line => line.startsWith('curl '));
  const install = lines.findIndex(line => line.startsWith('sudo install -m 0644 /tmp/burrow-postgresql.asc '));
  const cleanup = lines.indexOf('rm /tmp/burrow-postgresql.asc');
  assert.ok(curl >= 0 && install === curl + 1 && cleanup === install + 1);
  for (const flag of ['--http1.1', '--fail', '--retry 3', '--retry-all-errors', '--connect-timeout 15', '--max-time 60', '--output /tmp/burrow-postgresql.asc']) assert.ok(lines[curl].includes(flag), flag);
  assert.ok(!lines[curl].includes('|'));
  assert.ok(lines.includes('set -eu'));
});
