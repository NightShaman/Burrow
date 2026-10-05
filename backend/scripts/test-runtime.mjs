#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createManagedPostgresLifecycle } from '../src/postgres-lifecycle.mjs';

const TEST_ROOT_PREFIX = 'burrow-test-runtime-';
// Object identity is the cleanup capability; names supplied by callers are not ownership.
const ownedRuntimes = new WeakSet();

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function contentDigest(filePath) {
  const hash = createHash('sha256');
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.allocUnsafe(256 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
    }
  } finally {
    await handle.close();
  }
  return hash.digest('hex');
}

/** Content-addressed tree manifest. Timestamps are intentionally excluded. */
export async function contentManifest(root) {
  const resolvedRoot = path.resolve(root);
  const entries = [];
  async function walk(absolutePath, relativePath = '') {
    let stat;
    try {
      stat = await fs.lstat(absolutePath);
    } catch (error) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isDirectory()) {
      entries.push(`directory\t${relativePath || '.'}`);
      const children = await fs.readdir(absolutePath);
      for (const name of children.sort((a, b) => a.localeCompare(b))) {
        await walk(path.join(absolutePath, name), relativePath ? path.join(relativePath, name) : name);
      }
      return;
    }
    if (stat.isFile()) {
      entries.push(`file\t${relativePath}\t${stat.size}\t${await contentDigest(absolutePath)}`);
      return;
    }
    if (stat.isSymbolicLink()) {
      entries.push(`symlink\t${relativePath}\t${await fs.readlink(absolutePath)}`);
      return;
    }
    entries.push(`other\t${relativePath}\t${stat.mode}`);
  }
  await walk(resolvedRoot);
  return Object.freeze({ root: resolvedRoot, entries: Object.freeze(entries), hash: digest(entries.join('\n')) });
}

export async function deployedRuntimeManifests({ rootDir = process.cwd() } = {}) {
  const runtimeRoot = process.env.BURROW_RUNTIME_ROOT || '/mnt/local/burrow';
  const workspace = process.env.BURROW_WORKSPACE_ROOT || path.join(runtimeRoot, 'workspace');
  const agentWorkspace = process.env.BURROW_AGENT_WORKSPACE_ROOT || path.join(workspace, 'hatchet');
  const agentData = agentWorkspace;
  const cache = process.env.BURROW_CACHE_ROOT || path.join(runtimeRoot, 'cache');
  const roots = {
    sessions: path.join(agentWorkspace, 'sessions'),
    agentData,
    traces: path.join(cache, 'traces'),
  };
  return Object.freeze(Object.fromEntries(await Promise.all(Object.entries(roots).map(async ([name, target]) => [name, await contentManifest(target)]))));
}

export function changedManifests(before = {}, after = {}) {
  return Object.entries(before)
    .filter(([name, manifest]) => manifest?.hash !== after[name]?.hash)
    .map(([name, manifest]) => ({ name, root: manifest.root, before: manifest.hash, after: after[name]?.hash || null }));
}

export async function createTestRuntime({ prefix = TEST_ROOT_PREFIX } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  const paths = {
    root,
    tmp: path.join(root, 'tmp'),
    workspace: path.join(root, 'workspace'),
    agentWorkspace: path.join(root, 'workspace', 'hatchet'),
    agentData: path.join(root, 'workspace', 'hatchet'),
    cache: path.join(root, 'cache'),
  };
  await Promise.all([paths.tmp, paths.workspace, paths.agentWorkspace, paths.agentData, paths.cache].map((dir) => fs.mkdir(dir, { recursive: true })));
  ownedRuntimes.add(paths);
  return Object.freeze(paths);
}

/** Global reaping is deliberately disabled: another runner may still own any root. */
export async function removeStaleTestRuntimes() {}

function assertOwned(runtime) {
  if (!ownedRuntimes.has(runtime)) throw new Error('refusing non-owned test runtime');
}

function assertNoInheritedDatabase(env) {
  if (Object.entries(env).some(([key, value]) => value &&
    (key === 'DATABASE_URL' || key === 'BURROW_ACCESS_TEST_SOCKET' || key.startsWith('BURROW_POSTGRES_') || /^PG[A-Z_0-9]+$/.test(key)))) {
    throw new Error('Inherited database configuration rejected; use a run-owned disposable fixture');
  }
}

export function testRuntimeEnv(runtime, baseEnv = process.env) {
  assertOwned(runtime);
  assertNoInheritedDatabase(baseEnv);
  const env = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (/(?:API_KEY|TOKEN|CLIENT_SECRET|PASSWORD)$/.test(key)) delete env[key];
  }
  for (const key of ['BURROW_CONFIG', 'BURROW_RUNTIME_ROOT', 'BURROW_DATA_ROOT', 'BURROW_WORKSPACE_ROOT', 'BURROW_AGENT_WORKSPACE_ROOT', 'BURROW_AGENT_DATA_ROOT', 'BURROW_CACHE_ROOT', 'BURROW_ARCHIVE_ROOT', 'BURROW_SETTINGS_KEY', 'TMPDIR', 'TMP', 'TEMP']) delete env[key];
  // Isolated settings stores still encrypt connection secrets. This fixed test-only
  // key never reaches a deployed runtime and avoids inheriting host credentials.
  const disabledSocket = path.join(runtime.root, 'no-postgres-socket');
  return { ...env, PGHOST: disabledSocket, PGPORT: '5432', PGDATABASE: 'burrow_test_disabled', PGUSER: 'burrow_test_disabled', BURROW_POSTGRES_HOST: disabledSocket, BURROW_POSTGRES_DATABASE: 'burrow_test_disabled', BURROW_POSTGRES_USER: 'burrow_test_disabled', TMPDIR: runtime.tmp, TMP: runtime.tmp, TEMP: runtime.tmp, BURROW_RUNTIME_ROOT: runtime.root, BURROW_WORKSPACE_ROOT: runtime.workspace, BURROW_AGENT_WORKSPACE_ROOT: runtime.agentWorkspace, BURROW_CACHE_ROOT: runtime.cache, BURROW_TRACE_ISOLATION: '1', BURROW_SETTINGS_KEY: Buffer.alloc(32, 7).toString('base64') };
}

export async function removeTestRuntime(runtime) {
  assertOwned(runtime);
  await fs.rm(runtime.root, { recursive: true, force: true });
}

export async function runTestSuite({ argv = null, spawnProcess = spawn, verifyDeployedIsolation = false, baseEnv = process.env, disposablePostgres = false, postgresBinDir = '/usr/lib/postgresql/17/bin', timeoutMs = Number(process.env.BURROW_TEST_TIMEOUT_MS || 120_000) } = {}) {
  // Bound simultaneous fixture processes and PostgreSQL work, not test coverage.
  // The full archive fixtures are CPU-heavy; callers can raise this on dedicated hosts.
  const concurrency = Number(baseEnv.BURROW_TEST_CONCURRENCY || 4);
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('BURROW_TEST_CONCURRENCY must be a positive integer');
  const resolvedArgv = argv || ['--test', `--test-concurrency=${concurrency}`, ...(await fs.readdir(path.join(process.cwd(), 'tests'))).filter((name) => name.endsWith('.test.mjs')).map((name) => path.join('tests', name))];
  assertNoInheritedDatabase(baseEnv);
  const runtime = await createTestRuntime();
  let postgres;
  try {
    const childEnv = testRuntimeEnv(runtime, baseEnv);
    if (disposablePostgres) {
      const socketDir = path.join(runtime.root, 'socket');
      postgres = createManagedPostgresLifecycle({ dataDir: path.join(runtime.root, 'postgres'), socketDir,
        initdb: path.join(postgresBinDir, 'initdb'), pgCtl: path.join(postgresBinDir, 'pg_ctl'),
        postgres: path.join(postgresBinDir, 'postgres'), initdbArgs: ['--auth=trust'] });
      await postgres.start();
      // The URL is constructed here, never accepted from the shell. A private
      // Unix socket (no TCP listener) binds the target to this mkdtemp cluster.
      const url = new URL('postgresql://localhost/postgres');
      url.username = os.userInfo().username;
      url.searchParams.set('host', socketDir);
      childEnv.BURROW_POSTGRES_TEST_URL = url.href;
      childEnv.BURROW_POSTGRES_URL = url.href;
      childEnv.BURROW_POSTGRES_HOST = socketDir;
      childEnv.BURROW_POSTGRES_DATABASE = 'postgres';
      childEnv.BURROW_POSTGRES_USER = os.userInfo().username;
      childEnv.PGHOST = socketDir;
      childEnv.PGPORT = '5432';
      childEnv.PGDATABASE = 'postgres';
      childEnv.PGUSER = os.userInfo().username;
      // These opt-ins are minted only after this runner has created the owned
      // fixture. They are never accepted from the invoking environment.
      childEnv.BURROW_ACCESS_TEST_SOCKET = socketDir;
      childEnv.BURROW_ACCESS_TEST_USER = os.userInfo().username;
      childEnv.BURROW_POSTGRES_MANAGED_INTEGRATION = '1';
      childEnv.BURROW_POSTGRES_TEST_BIN = postgresBinDir;
      childEnv.PATH = `${postgresBinDir}${path.delimiter}${childEnv.PATH || ''}`;
    }
    const deployedBefore = verifyDeployedIsolation ? await deployedRuntimeManifests() : null;
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawnProcess(process.execPath, resolvedArgv, { cwd: process.cwd(), env: childEnv, stdio: 'inherit', detached: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        console.error(`Burrow test timeout after ${timeoutMs}ms; terminating process group ${child.pid}`);
        try { process.kill(-child.pid, 'SIGTERM'); } catch { child.kill('SIGTERM'); }
        setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, 2_000).unref();
      }, timeoutMs);
      timer.unref?.();
      child.once('error', (error) => { clearTimeout(timer); reject(error); });
      child.once('exit', (code, signal) => { clearTimeout(timer); resolve(timedOut ? 1 : (code ?? (signal ? 1 : 0))); });
    });
    const deployedAfter = verifyDeployedIsolation ? await deployedRuntimeManifests() : null;
    const liveChanges = deployedBefore ? changedManifests(deployedBefore, deployedAfter) : [];
    if (liveChanges.length) {
      console.error(`Burrow test isolation breach: deployed runtime changed:\n${JSON.stringify(liveChanges, null, 2)}`);
      return { exitCode: exitCode || 1, runtime, liveChanges };
    }
    return { exitCode, runtime, liveChanges: [] };
  } finally {
    // Never unlink a running cluster if stopping it fails.
    if (postgres) await postgres.stop();
    await removeTestRuntime(runtime);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const requestedFiles = process.argv.slice(2).filter((argument) => argument !== '--');
  const argv = requestedFiles.length ? ['--test', ...requestedFiles] : null;
  const result = await runTestSuite({ argv, verifyDeployedIsolation: process.env.BURROW_VERIFY_DEPLOYED_ISOLATION === '1', disposablePostgres: process.env.BURROW_TEST_DISPOSABLE_POSTGRES === '1' });
  process.exitCode = result.exitCode;
}
