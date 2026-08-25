#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const TEST_ROOT_PREFIX = 'burrow-test-runtime-';

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
  const agentData = process.env.BURROW_AGENT_DATA_ROOT || path.join(runtimeRoot, 'agentdata', 'hatchet');
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
    agentData: path.join(root, 'agentdata', 'hatchet'),
    cache: path.join(root, 'cache'),
    settingsDb: path.join(root, 'config', 'settings.sqlite'),
  };
  await Promise.all([paths.tmp, paths.workspace, paths.agentWorkspace, paths.agentData, paths.cache, path.dirname(paths.settingsDb)].map((dir) => fs.mkdir(dir, { recursive: true })));
  return paths;
}

/** Remove only abandoned private roots created by this runner. */
export async function removeStaleTestRuntimes({ prefix = TEST_ROOT_PREFIX, tmpRoot = os.tmpdir() } = {}) {
  const entries = await fs.readdir(tmpRoot, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix))
    .map((entry) => fs.rm(path.join(tmpRoot, entry.name), { recursive: true, force: true })));
}

export function testRuntimeEnv(runtime, baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of ['BURROW_CONFIG', 'BURROW_RUNTIME_ROOT', 'BURROW_DATA_ROOT', 'BURROW_WORKSPACE_ROOT', 'BURROW_AGENT_WORKSPACE_ROOT', 'BURROW_AGENT_DATA_ROOT', 'BURROW_CACHE_ROOT', 'BURROW_ARCHIVE_ROOT', 'BURROW_SETTINGS_DB', 'BURROW_SETTINGS_KEY', 'TMPDIR', 'TMP', 'TEMP']) delete env[key];
  // Isolated settings stores still encrypt connection secrets. This fixed test-only
  // key never reaches a deployed runtime and avoids inheriting host credentials.
  return { ...env, TMPDIR: runtime.tmp, TMP: runtime.tmp, TEMP: runtime.tmp, BURROW_RUNTIME_ROOT: runtime.root, BURROW_WORKSPACE_ROOT: runtime.workspace, BURROW_AGENT_WORKSPACE_ROOT: runtime.agentWorkspace, BURROW_AGENT_DATA_ROOT: runtime.agentData, BURROW_CACHE_ROOT: runtime.cache, BURROW_TRACE_ISOLATION: '1', BURROW_SETTINGS_DB: runtime.settingsDb, BURROW_SETTINGS_KEY: Buffer.alloc(32, 7).toString('base64') };
}

export async function removeTestRuntime(runtime) {
  if (!runtime?.root || !path.basename(runtime.root).startsWith(TEST_ROOT_PREFIX)) throw new Error('refusing to remove non-test runtime root');
  await fs.rm(runtime.root, { recursive: true, force: true });
}

export async function runTestSuite({ argv = null, spawnProcess = spawn, verifyDeployedIsolation = false, timeoutMs = Number(process.env.BURROW_TEST_TIMEOUT_MS || 120_000) } = {}) {
  const resolvedArgv = argv || ['--test', ...(await fs.readdir(path.join(process.cwd(), 'tests'))).filter((name) => name.endsWith('.test.mjs')).map((name) => path.join('tests', name))];
  await removeStaleTestRuntimes();
  const runtime = await createTestRuntime();
  const deployedBefore = verifyDeployedIsolation ? await deployedRuntimeManifests() : null;
  try {
    const exitCode = await new Promise((resolve, reject) => {
      const child = spawnProcess(process.execPath, resolvedArgv, { cwd: process.cwd(), env: testRuntimeEnv(runtime), stdio: 'inherit', detached: true });
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
    await removeTestRuntime(runtime);
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const requestedFiles = process.argv.slice(2).filter((argument) => argument !== '--');
  const argv = requestedFiles.length ? ['--test', ...requestedFiles] : null;
  const result = await runTestSuite({ argv, verifyDeployedIsolation: process.env.BURROW_VERIFY_DEPLOYED_ISOLATION === '1' });
  process.exitCode = result.exitCode;
}
