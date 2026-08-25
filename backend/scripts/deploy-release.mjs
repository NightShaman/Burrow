#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { buildReleaseArtifact, verifyReleaseArtifact, exportReleaseArchive, pruneReleases, nextCalendarReleaseId } from '../src/release-deployer.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_RUNTIME_ROOT = '/mnt/local/burrow';
const DEPLOY_LOCK_NAME = 'deploy.lock';
const DEPLOY_REPORT_DIR = 'deployments';

export function parseArgs(argv = []) {
  const args = { apply: false, json: false, skipCheck: false, exportArchive: false, smokePort: 8789, healthTimeoutMs: 15_000, unit: 'burrow.service', lockStaleMs: 30 * 60_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--skip-check') args.skipCheck = true;
    else if (arg === '--export-archive') args.exportArchive = true;
    else if (arg === '--source-root') args.sourceRoot = argv[++index];
    else if (arg === '--runtime-root') args.runtimeRoot = argv[++index];
    else if (arg === '--ui-dist') args.uiDist = argv[++index];
    else if (arg === '--release-id') args.releaseId = argv[++index];
    else if (arg === '--archive-dir') args.archiveDir = argv[++index];
    else if (arg === '--smoke-port') args.smokePort = Number(argv[++index]);
    else if (arg === '--health-timeout-ms') args.healthTimeoutMs = Number(argv[++index]);
    else if (arg === '--unit') args.unit = argv[++index];
    else if (arg === '--lock-stale-ms') args.lockStaleMs = Number(argv[++index]);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

export function usage() {
  return `Usage: node scripts/deploy-release.mjs --ui-dist DIR [--apply] [--json] [--export-archive] [--source-root DIR] [--runtime-root DIR] [--release-id ID] [--smoke-port PORT]\n\nDefault is a build-and-validate dry run. --ui-dist is required and supplies the already-built external UI artifact for public/ui. --export-archive writes runtime/packages/<release>.tar.gz plus .sha256. --apply updates BURROW_SOURCE_ROOT in runtime/burrow.env, restarts systemd, verifies health, and rolls back on failure. A deploy lock prevents overlapping runs; JSON reports are written under runtime/deployments.\n`;
}

function boundedOutput(value, limit = 12_000) {
  const text = String(value || '').trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

async function run(command, args, options = {}) {
  const startedAt = Date.now();
  try {
    const result = await execFileAsync(command, args, { timeout: options.timeout ?? 300_000, maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024, cwd: options.cwd, env: options.env });
    return { stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim(), durationMs: Date.now() - startedAt };
  } catch (error) {
    const detail = { command: [command, ...args].join(' '), stdout: boundedOutput(error?.stdout), stderr: boundedOutput(error?.stderr), durationMs: Date.now() - startedAt, exitCode: error?.code ?? null, signal: error?.signal ?? null };
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { runOutput: detail });
  }
}

async function pathInfo(filePath) {
  try {
    const stat = await fs.lstat(filePath);
    return { path: filePath, exists: true, type: stat.isSymbolicLink() ? 'symlink' : stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other', mode: stat.mode & 0o777, realPath: stat.isSymbolicLink() ? await fs.realpath(filePath).catch(() => null) : null };
  } catch { return { path: filePath, exists: false }; }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  await fs.rename(tmp, filePath);
}

async function writeDeployReport(runtimeRoot, report, suffix = 'json') {
  const dir = path.join(runtimeRoot, DEPLOY_REPORT_DIR);
  const name = `${report.releaseId || 'unknown'}-${report.applied ? 'applied' : 'validate'}-${report.ok ? 'ok' : 'failed'}.${suffix}`;
  const filePath = path.join(dir, name);
  await writeJsonAtomic(filePath, report);
  return filePath;
}

async function readEnvSourceRoot(envPath) {
  try {
    const text = await fs.readFile(envPath, 'utf8');
    const line = text.split('\n').find((value) => /^BURROW_SOURCE_ROOT=/.test(value));
    const value = line ? line.slice('BURROW_SOURCE_ROOT='.length).trim() : '';
    return value || null;
  } catch { return null; }
}

async function appSymlinkTarget(runtimeRoot) {
  const appPath = path.join(runtimeRoot, 'app');
  try {
    const stat = await fs.lstat(appPath);
    if (!stat.isSymbolicLink()) return null;
    const target = await fs.readlink(appPath);
    return path.resolve(path.dirname(appPath), target);
  } catch { return null; }
}

async function readActiveRelease(envPath, runtimeRoot) {
  return await appSymlinkTarget(runtimeRoot) || await readEnvSourceRoot(envPath);
}

async function writeEnvSourceRoot(envPath, sourceRoot) {
  const current = await fs.readFile(envPath, 'utf8').catch(() => '');
  const nextLine = `BURROW_SOURCE_ROOT=${sourceRoot}`;
  const next = /^BURROW_SOURCE_ROOT=/m.test(current)
    ? current.replace(/^BURROW_SOURCE_ROOT=.*$/m, nextLine)
    : `${current.replace(/\s*$/, '\n')}${nextLine}\n`;
  const mode = (await fs.stat(envPath).catch(() => ({ mode: 0o600 }))).mode & 0o777;
  const tmp = `${envPath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, next, { mode: mode || 0o600 });
  await fs.rename(tmp, envPath);
}

async function setActiveRelease(envPath, runtimeRoot, releaseRoot) {
  const appPath = path.join(runtimeRoot, 'app');
  const currentAppTarget = await appSymlinkTarget(runtimeRoot);
  if (currentAppTarget) {
    const tmpLink = path.join(runtimeRoot, `.app.tmp-${process.pid}-${Date.now()}`);
    await fs.symlink(releaseRoot, tmpLink);
    await fs.rename(tmpLink, appPath);
    await writeEnvSourceRoot(envPath, releaseRoot);
    return { mode: 'app-symlink', appPath, releaseRoot };
  }
  await writeEnvSourceRoot(envPath, releaseRoot);
  return { mode: 'env-source-root', releaseRoot };
}

async function withDeployLock(runtimeRoot, staleMs, fn) {
  await fs.mkdir(runtimeRoot, { recursive: true });
  const lockPath = path.join(runtimeRoot, DEPLOY_LOCK_NAME);
  const token = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
  let handle;
  try {
    handle = await fs.open(lockPath, 'wx');
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    const stat = await fs.stat(lockPath).catch(() => null);
    const ageMs = stat ? Date.now() - stat.mtimeMs : 0;
    if (stat && ageMs > Math.max(1, Number(staleMs) || 30 * 60_000)) await fs.rm(lockPath, { force: true });
    else throw new Error('deploy_lock_active');
    handle = await fs.open(lockPath, 'wx');
  }
  try {
    await handle.writeFile(`${token}\n`);
    await handle.close();
    handle = null;
    return await fn(lockPath);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await fs.rm(lockPath, { force: true }).catch(() => {});
  }
}

async function runStage(report, name, fn) {
  const startedAt = new Date().toISOString();
  const start = Date.now();
  report.stageDetails.push({ name, startedAt, status: 'running' });
  const detail = report.stageDetails[report.stageDetails.length - 1];
  try {
    const result = await fn();
    detail.status = 'ok';
    detail.durationMs = Date.now() - start;
    detail.completedAt = new Date().toISOString();
    report.stages.push(name);
    return result;
  } catch (error) {
    detail.status = 'failed';
    detail.durationMs = Date.now() - start;
    detail.completedAt = new Date().toISOString();
    detail.error = String(error?.message || error);
    if (error?.runOutput) detail.output = error.runOutput;
    throw error;
  }
}

async function gitValue(sourceRoot, args) {
  return (await run('git', args, { cwd: sourceRoot, timeout: 30_000 })).stdout;
}

async function readEnvFile(filePath) {
  const values = {};
  const text = await fs.readFile(filePath, 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const index = trimmed.indexOf('=');
    if (index <= 0) continue;
    values[trimmed.slice(0, index)] = trimmed.slice(index + 1);
  }
  return values;
}

async function waitForHealth(url, expectedSourceRoot, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      const body = await response.json();
      const sourceRoot = body?.state?.sourceRoot || body?.runtimeState?.sourceRoot || body?.sourceRoot || null;
      if (response.ok && body?.ok && path.resolve(sourceRoot || '') === path.resolve(expectedSourceRoot)) return body;
      lastError = new Error(`health_mismatch:${response.status}:${sourceRoot || 'unknown'}`);
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error('health_timeout');
}

async function smokeRelease({ sourceRoot, releaseRoot, runtimeRoot, port, timeoutMs }) {
  const logPath = path.join(os.tmpdir(), `burrow-release-smoke-${path.basename(releaseRoot)}-${process.pid}.log`);
  const runtimeEnv = await readEnvFile(path.join(runtimeRoot, 'burrow.env'));
  const env = {
    ...process.env,
    ...runtimeEnv,
    BURROW_SOURCE_ROOT: releaseRoot,
    BURROW_RUNTIME_ROOT: runtimeRoot,
    BURROW_UI_HOST: '127.0.0.1',
    BURROW_UI_PORT: String(port),
  };
  const child = execFile('/usr/bin/env', ['node', path.join(releaseRoot, 'bin', 'burrow.mjs'), 'serve', '--root', releaseRoot], { cwd: releaseRoot, env });
  const output = [];
  child.stdout?.on('data', (chunk) => output.push(chunk));
  child.stderr?.on('data', (chunk) => output.push(chunk));
  try {
    const health = await waitForHealth(`http://127.0.0.1:${port}/health`, releaseRoot, timeoutMs);
    return { ok: true, port, sourceRoot: health?.state?.sourceRoot || health?.runtimeState?.sourceRoot || health?.sourceRoot || releaseRoot, logPath };
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5_000); });
    await fs.writeFile(logPath, Buffer.concat(output.map((value) => Buffer.from(value))));
  }
}

export async function deployRelease(args, dependencies = {}) {
  const sourceRoot = path.resolve(args.sourceRoot || process.cwd());
  const runtimeRoot = path.resolve(args.runtimeRoot || process.env.BURROW_RUNTIME_ROOT || DEFAULT_RUNTIME_ROOT);
  return withDeployLock(runtimeRoot, args.lockStaleMs, async (lockPath) => {
    const startedAt = new Date().toISOString();
    const releasesRoot = path.join(runtimeRoot, 'releases');
    const envPath = path.join(runtimeRoot, 'burrow.env');
    const revision = dependencies.revision || await gitValue(sourceRoot, ['rev-parse', 'HEAD']);
    if (!args.uiDist) throw new Error('release_ui_dist_required');
    const uiDist = path.resolve(args.uiDist);
    try { await fs.access(path.join(uiDist, 'index.html')); } catch { throw new Error('ui_dist_index_missing'); }
    const shortRevision = revision.slice(0, 7);
    const releaseId = args.releaseId || await nextCalendarReleaseId({ releasesRoot });
    const previousRelease = await readActiveRelease(envPath, runtimeRoot);
    const report = {
      ok: false, applied: false, rolledBack: false, sourceRoot, runtimeRoot, releaseId, previousRelease,
      startedAt, completedAt: null, durationMs: null, stages: [], stageDetails: [], lockPath,
      options: { apply: Boolean(args.apply), skipCheck: Boolean(args.skipCheck), exportArchive: Boolean(args.exportArchive), archiveDir: args.archiveDir || null, smokePort: args.smokePort, healthTimeoutMs: args.healthTimeoutMs, unit: args.unit, uiDist },
      preflight: { source: await pathInfo(sourceRoot), runtime: await pathInfo(runtimeRoot), env: await pathInfo(envPath), uiDist: await pathInfo(uiDist) },
    };
    const finish = async (ok) => {
      report.ok = ok;
      report.completedAt = new Date().toISOString();
      report.durationMs = Date.parse(report.completedAt) - Date.parse(report.startedAt);
      report.reportPath = await writeDeployReport(runtimeRoot, report).catch(() => null);
      return report;
    };

    try {
      if (!args.skipCheck) {
        await runStage(report, 'source-check', async () => {
          const status = await gitValue(sourceRoot, ['status', '--porcelain', '--untracked-files=all']);
          if (status) throw new Error('deploy_source_dirty');
          report.check = await run('npm', ['run', 'check'], { cwd: sourceRoot });
        });
      }

      const artifact = await runStage(report, 'artifact-built', async () => buildReleaseArtifact({ sourceRoot, releasesRoot, releaseId, sourceRevision: revision, uiDist, installProductionDependencies: true }));
      report.releaseRoot = artifact.releaseRoot;
      report.artifact = await runStage(report, 'artifact-verified', async () => verifyReleaseArtifact(artifact.releaseRoot));
      report.ui = { source: uiDist, mode: 'external-dist' };
      report.smoke = await runStage(report, 'artifact-smoked', async () => smokeRelease({ sourceRoot, releaseRoot: artifact.releaseRoot, runtimeRoot, port: args.smokePort, timeoutMs: args.healthTimeoutMs }));
      if (args.exportArchive) {
        report.archive = await runStage(report, 'archive-exported', async () => exportReleaseArchive({ releaseRoot: artifact.releaseRoot, outputDir: args.archiveDir ? path.resolve(args.archiveDir) : path.join(runtimeRoot, 'packages') }));
      }

      if (!args.apply) return finish(true);

      await runStage(report, 'active-release-updated', async () => {
        report.activeRelease = await setActiveRelease(envPath, runtimeRoot, artifact.releaseRoot);
      });
      try {
        await runStage(report, 'service-restarted', async () => { report.restart = await run('sudo', ['systemctl', 'restart', args.unit], { timeout: 60_000 }); });
        report.health = await runStage(report, 'service-verified', async () => {
          const health = await waitForHealth('http://127.0.0.1:42817/health', artifact.releaseRoot, args.healthTimeoutMs);
          const active = await run('systemctl', ['is-active', args.unit], { timeout: 10_000 });
          if (active.stdout !== 'active') throw new Error(`service_not_active:${active.stdout}`);
          report.serviceActive = active.stdout;
          return health;
        });
        report.applied = true;
        report.retention = await runStage(report, 'old-releases-pruned', async () => pruneReleases({
          releasesRoot,
          protectedReleaseRoots: [artifact.releaseRoot, previousRelease],
          retainNewest: 3,
        }));
        return finish(true);
      } catch (error) {
        report.error = String(error?.message || error);
        await runStage(report, 'rollback', async () => {
          report.rollbackActiveRelease = await setActiveRelease(envPath, runtimeRoot, previousRelease || '');
          if (previousRelease) {
            report.rollbackRestart = await run('sudo', ['systemctl', 'restart', args.unit], { timeout: 60_000 });
            report.rollbackHealth = await waitForHealth('http://127.0.0.1:42817/health', previousRelease, args.healthTimeoutMs);
          } else {
            report.rollbackStop = await run('sudo', ['systemctl', 'stop', args.unit], { timeout: 60_000 }).catch((stopError) => ({ error: String(stopError?.message || stopError) }));
          }
        });
        report.rolledBack = true;
        report.rollbackRelease = previousRelease || null;
        await finish(false);
        throw Object.assign(new Error(`deploy_failed_rolled_back:${report.error}`), { report });
      }
    } catch (error) {
      report.error = report.error || String(error?.message || error);
      await finish(false);
      if (error.report) throw error;
      throw Object.assign(error instanceof Error ? error : new Error(String(error)), { report });
    }
  });
}

function format(result) {
  return [
    `Burrow release deploy: ${result.ok ? 'ok' : 'failed'}`,
    `Release: ${result.releaseId}`,
    `Artifact: ${result.releaseRoot}`,
    `Mode: ${result.applied ? 'applied' : 'validated-only'}`,
    `Stages: ${result.stages.join(', ')}`,
    result.rolledBack ? `Rollback: ${result.rollbackRelease}` : null,
    result.archive?.archivePath ? `Archive: ${result.archive.archivePath}` : null,
    result.archive?.checksumPath ? `Checksum: ${result.archive.checksumPath}` : null,
    result.reportPath ? `Report: ${result.reportPath}` : null,
  ].filter(Boolean).join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); process.exit(0); }
  try {
    const result = await deployRelease(args);
    console.log(args.json ? JSON.stringify(result, null, 2) : format(result));
  } catch (error) {
    const output = error.report || { ok: false, error: String(error?.message || error) };
    if (args.json) console.error(JSON.stringify(output, null, 2));
    else console.error(`Burrow release deploy: failed (${output.error || error.message})`);
    process.exitCode = 1;
  }
}
