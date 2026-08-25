#!/usr/bin/env node
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { constants as fsConstants, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { verifyReleaseArtifact } from '../src/release-deployer.mjs';
import { ensureDefaultGlobalWorkspace } from '../src/runtime-workspace-defaults.mjs';

const execFileAsync = promisify(execFile);
const INSTALL_REPORT_DIR = 'deployments';
const DEFAULT_INSTALL_PORT = 42817;
const DEFAULT_SMOKE_PORT = 8788;
const APP_DIRECTORIES = Object.freeze(['bin', 'deploy', 'docs', 'global-skills', 'scripts', 'src', 'public', 'node_modules']);
const APP_FILES = Object.freeze(['package.json', 'package-lock.json', 'README.md', 'RELEASE_ID', 'BUILD_SOURCE', 'MANIFEST.sha256']);
const RUNTIME_DIRECTORIES = Object.freeze(['config', 'workspace', path.join('workspace', 'global'), path.join('workspace', 'global', 'skills'), path.join('workspace', 'global', 'tools'), 'agentdata', 'cache', 'reports', 'integrations', 'deployments', 'packages']);

export function parseArgs(argv = []) {
  const args = { json: false, apply: false, forceEnv: false, generateSettingsKey: null, smoke: false, smokePort: null, host: null, port: null, healthTimeoutMs: 15_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') args.json = true;
    else if (arg === '--apply') args.apply = true;
    else if (arg === '--dir' || arg === '--install-dir') args.installDir = argv[++index];
    else if (arg === '--package' || arg === '--archive') args.packagePath = argv[++index];
    else if (arg === '--checksum') args.checksumPath = argv[++index];
    else if (arg === '--force-env') args.forceEnv = true;
    else if (arg === '--generate-settings-key') args.generateSettingsKey = true;
    else if (arg === '--no-generate-settings-key') args.generateSettingsKey = false;
    else if (arg === '--host') args.host = argv[++index];
    else if (arg === '--port') args.port = Number(argv[++index]);
    else if (arg === '--smoke') args.smoke = true;
    else if (arg === '--smoke-port') args.smokePort = Number(argv[++index]);
    else if (arg === '--health-timeout-ms') args.healthTimeoutMs = Number(argv[++index]);
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

export function usage() {
  return `Usage: node scripts/install-release-package.mjs --dir DIR --package FILE.tar.gz [--apply] [--json] [--host HOST] [--port PORT]\n\nInstalls Burrow into one user-chosen directory. Default previews and validates only. --apply copies app files into DIR, creates runtime subdirectories under DIR, writes DIR/burrow.env when absent, and writes an install report under DIR/deployments. Fresh applied installs generate BURROW_SETTINGS_KEY by default unless --no-generate-settings-key is passed. No symlink release ring, no /mnt/local default, no split /opt/var/etc layout.\n`;
}

async function run(command, args, options = {}) {
  const startedAt = Date.now();
  const result = await execFileAsync(command, args, { timeout: options.timeout ?? 300_000, maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024, cwd: options.cwd, env: options.env });
  return { stdout: String(result.stdout || '').trim(), stderr: String(result.stderr || '').trim(), durationMs: Date.now() - startedAt };
}

async function exists(filePath) { try { await fs.access(filePath); return true; } catch { return false; } }
async function writable(filePath) { try { await fs.access(filePath, fsConstants.W_OK); return true; } catch { return false; } }

function normalizePort(value, fallback = DEFAULT_INSTALL_PORT) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('install_port_invalid');
  return port;
}

function normalizeHost(value, fallback = '0.0.0.0') {
  const host = String(value || fallback).trim();
  if (!host) throw new Error('install_host_invalid');
  return host;
}

function installDirFixHint(installDir) {
  return `sudo install -d -o "$USER" -g "$USER" -m 0755 ${JSON.stringify(installDir)}`;
}

async function assertInstallTargetWritable(installDir) {
  if (await exists(installDir)) {
    if (await writable(installDir)) return;
    throw new Error(`install_dir_not_writable:${installDir}; create/fix ownership first: ${installDirFixHint(installDir)}`);
  }
  const parent = path.dirname(installDir);
  if (!(await exists(parent))) throw new Error(`install_parent_missing:${parent}; create it first, then rerun`);
  if (!(await writable(parent))) throw new Error(`install_parent_not_writable:${parent}; create install dir first: ${installDirFixHint(installDir)}`);
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

async function sha256Stream(filePath) {
  const { createReadStream } = await import('node:fs');
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => createReadStream(filePath).on('data', (chunk) => hash.update(chunk)).on('error', reject).on('end', resolve));
  return hash.digest('hex');
}

async function verifyChecksum(archivePath, checksumPath) {
  const actual = await sha256Stream(archivePath);
  if (!checksumPath) return { ok: true, archivePath, checksumPath: null, sha256: actual, verified: false };
  const text = await fs.readFile(checksumPath, 'utf8');
  const line = text.trim().split('\n').find(Boolean) || '';
  const [digest, file] = line.split(/\s+/, 2);
  if (!/^[a-f0-9]{64}$/i.test(digest || '')) throw new Error('release_checksum_invalid');
  if (file && path.basename(file) !== path.basename(archivePath)) throw new Error('release_checksum_archive_mismatch');
  if (actual !== digest.toLowerCase()) throw new Error('release_checksum_mismatch');
  return { ok: true, archivePath, checksumPath, sha256: actual, verified: true };
}

function assertSafeArchiveEntry(entry) {
  const name = String(entry || '').trim();
  if (!name || name.startsWith('/') || name.includes('..') || path.isAbsolute(name)) throw new Error(`release_archive_entry_invalid:${name || 'empty'}`);
  const root = name.split('/')[0];
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(root)) throw new Error(`release_archive_root_invalid:${root}`);
  return root;
}

async function archiveRoot(archivePath) {
  const listing = await run('tar', ['-tvzf', archivePath], { timeout: 300_000 });
  const roots = new Set();
  for (const line of listing.stdout.split('\n').filter(Boolean)) {
    const type = line[0];
    if (type !== '-' && type !== 'd') throw new Error(`release_archive_entry_type_forbidden:${type || 'unknown'}`);
    const parts = line.split(/\s+/);
    const name = parts.slice(5).join(' ');
    roots.add(assertSafeArchiveEntry(name));
  }
  if (roots.size !== 1) throw new Error(`release_archive_root_invalid:${[...roots].join(',') || 'none'}`);
  return [...roots][0];
}

export async function inspectReleaseArchive(archivePath) {
  return { root: await archiveRoot(path.resolve(archivePath)) };
}

async function copyTree(source, destination) {
  const entries = await fs.readdir(source, { withFileTypes: true });
  await fs.mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`install_source_symlink_forbidden:${sourcePath}`);
    if (entry.isDirectory()) await copyTree(sourcePath, destinationPath);
    else if (entry.isFile()) await fs.copyFile(sourcePath, destinationPath);
    else throw new Error(`install_source_entry_unsupported:${sourcePath}`);
  }
}

async function writeJsonAtomic(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  await fs.rename(tmp, filePath);
}

async function writeProductUiTitle(installDir) {
  const indexPath = path.join(installDir, 'public', 'ui', 'index.html');
  const source = await fs.readFile(indexPath, 'utf8');
  const titlePattern = /<title>[^<]*<\/title>/ig;
  if (titlePattern.test(source)) {
    let replaced = false;
    const updated = source.replace(titlePattern, () => {
      if (replaced) return '';
      replaced = true;
      return '<title>Burrow</title>';
    });
    if (updated !== source) await fs.writeFile(indexPath, updated);
    return { indexPath, title: 'Burrow' };
  }
  const updated = /<head[^>]*>/i.test(source)
    ? source.replace(/<head[^>]*>/i, (head) => `${head}\n<title>Burrow</title>`)
    : `<title>Burrow</title>\n${source}`;
  await fs.writeFile(indexPath, updated);
  return { indexPath, title: 'Burrow' };
}

function envTemplate({ installDir, settingsKey = '', host = '0.0.0.0', port = 42817 }) {
  return `# Burrow single-directory runtime environment.\nBURROW_SOURCE_ROOT=${installDir}\nBURROW_RUNTIME_ROOT=${installDir}\nBURROW_WORKSPACE_ROOT=${installDir}/workspace\nBURROW_CACHE_ROOT=${installDir}/cache\nBURROW_SETTINGS_DB=${installDir}/config/settings.sqlite\nBURROW_UI_HOST=${host}\nBURROW_UI_PORT=${port}\n# Base64-encoded 32-byte SQLite encryption key.\nBURROW_SETTINGS_KEY=${settingsKey}\n`;
}

async function smokeInstall({ installDir, port, timeoutMs }) {
  const logPath = path.join(os.tmpdir(), `burrow-install-smoke-${path.basename(installDir)}-${process.pid}.log`);
  const runtimeEnv = await readEnvFile(path.join(installDir, 'burrow.env'));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('BURROW_')) delete env[key];
  Object.assign(env, runtimeEnv, { BURROW_SOURCE_ROOT: installDir, BURROW_RUNTIME_ROOT: installDir, BURROW_WORKSPACE_ROOT: path.join(installDir, 'workspace'), BURROW_CACHE_ROOT: path.join(installDir, 'cache'), BURROW_UI_HOST: '127.0.0.1', BURROW_UI_PORT: String(port) });
  const child = execFile('/usr/bin/env', ['node', path.join(installDir, 'bin', 'burrow.mjs'), 'serve', '--root', installDir], { cwd: installDir, env });
  const output = [];
  child.stdout?.on('data', (chunk) => output.push(chunk));
  child.stderr?.on('data', (chunk) => output.push(chunk));
  try {
    const deadline = Date.now() + timeoutMs;
    let lastError = null;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        const body = await response.json();
        const sourceRoot = body?.state?.sourceRoot || body?.runtimeState?.sourceRoot || body?.sourceRoot || null;
        if (response.ok && body?.ok && path.resolve(sourceRoot || '') === path.resolve(installDir)) return { ok: true, port, sourceRoot, logPath };
        lastError = new Error(`health_mismatch:${response.status}:${sourceRoot || 'unknown'}`);
      } catch (error) { lastError = error; }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw lastError || new Error('health_timeout');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => { child.once('exit', resolve); setTimeout(resolve, 5_000); });
    await fs.writeFile(logPath, Buffer.concat(output.map((value) => Buffer.from(value))));
  }
}

export async function installReleasePackage(args = {}) {
  args = { smokePort: null, healthTimeoutMs: 15_000, forceEnv: false, generateSettingsKey: null, smoke: false, host: null, port: null, ...args };
  if (!args.packagePath) throw new Error('release_package_required');
  if (!args.installDir && !args.dir) throw new Error('install_dir_required');
  const installDir = path.resolve(args.installDir || args.dir);
  const archivePath = path.resolve(args.packagePath);
  const checksumPath = args.checksumPath ? path.resolve(args.checksumPath) : (await exists(`${archivePath}.sha256`) ? `${archivePath}.sha256` : null);
  const envPath = path.join(installDir, 'burrow.env');
  const envExists = await exists(envPath);
  const host = normalizeHost(args.host);
  const port = normalizePort(args.port);
  const smokePort = normalizePort(args.smokePort ?? (args.port ? port : DEFAULT_SMOKE_PORT));
  const existingEnv = envExists ? await readEnvFile(envPath) : {};
  const generateSettingsKey = args.generateSettingsKey === null || args.generateSettingsKey === undefined ? Boolean(args.apply && (!envExists || args.forceEnv) && !existingEnv.BURROW_SETTINGS_KEY) : Boolean(args.generateSettingsKey);
  const settingsKey = generateSettingsKey ? randomBytes(32).toString('base64') : (existingEnv.BURROW_SETTINGS_KEY || '');
  const startedAt = new Date().toISOString();
  const report = { ok: false, applied: false, installDir, archivePath, checksumPath, startedAt, completedAt: null, durationMs: null, stages: [], planned: [], warnings: [], options: { apply: Boolean(args.apply), forceEnv: Boolean(args.forceEnv), generateSettingsKey, smoke: Boolean(args.smoke), host, port, smokePort } };
  const finish = async (ok) => {
    report.ok = ok;
    report.completedAt = new Date().toISOString();
    report.durationMs = Date.parse(report.completedAt) - Date.parse(report.startedAt);
    if (args.apply) {
      const reportPath = path.join(installDir, INSTALL_REPORT_DIR, `${report.releaseId || 'unknown'}-install-${ok ? 'ok' : 'failed'}.json`);
      report.reportPath = reportPath;
      await writeJsonAtomic(reportPath, report).catch(() => { report.reportPath = null; });
    }
    return report;
  };
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'burrow-install-package-'));
  try {
    if (args.apply) await assertInstallTargetWritable(installDir);
    report.checksum = await verifyChecksum(archivePath, checksumPath);
    report.stages.push('package-checksum');
    const rootName = await archiveRoot(archivePath);
    report.archiveRoot = rootName;
    await run('tar', ['-xzf', archivePath, '-C', tmp], { timeout: 300_000 });
    const packageRoot = path.join(tmp, rootName);
    report.artifact = await verifyReleaseArtifact(packageRoot);
    report.releaseId = report.artifact.releaseId;
    report.stages.push('artifact-verified');
    report.planned.push({ action: 'install-app-files', path: installDir });
    for (const dir of RUNTIME_DIRECTORIES) report.planned.push({ action: 'mkdir', path: path.join(installDir, dir) });
    report.planned.push({ action: envExists && !args.forceEnv ? 'preserve-env' : 'write-env', path: envPath, host, port });
    if (!generateSettingsKey && !(envExists && !args.forceEnv)) report.warnings.push('settings_key_not_generated:set BURROW_SETTINGS_KEY before first real start, or rerun with --generate-settings-key');
    if (envExists && !args.forceEnv && (args.host || args.port || args.generateSettingsKey !== null)) report.warnings.push(`env_preserved:requested env options were not written; edit ${envPath} or rerun with --force-env`);
    if (args.smoke && smokePort !== port && !args.port) report.warnings.push(`smoke_port_not_persistent:smoke uses ${smokePort}, but env port defaults to ${port}; pass --port ${smokePort} to persist it`);
    if (!args.apply) return finish(true);

    await fs.mkdir(installDir, { recursive: true });
    for (const dir of RUNTIME_DIRECTORIES) await fs.mkdir(path.join(installDir, dir), { recursive: true });
    for (const dir of APP_DIRECTORIES) if (await exists(path.join(packageRoot, dir))) { await fs.rm(path.join(installDir, dir), { recursive: true, force: true }); await copyTree(path.join(packageRoot, dir), path.join(installDir, dir)); }
    for (const file of APP_FILES) if (await exists(path.join(packageRoot, file))) { await fs.rm(path.join(installDir, file), { force: true }); await fs.copyFile(path.join(packageRoot, file), path.join(installDir, file)); }
    report.ui = await writeProductUiTitle(installDir);
    report.globalWorkspace = await ensureDefaultGlobalWorkspace({ installDir });
    report.stages.push('installed-files', 'global-workspace');
    if (await exists(envPath) && !args.forceEnv) report.stages.push('env-preserved');
    else { await fs.writeFile(envPath, envTemplate({ installDir, settingsKey, host, port }), { mode: 0o600 }); report.stages.push('env-written'); }
    if (args.smoke) { report.smoke = await smokeInstall({ installDir, port: smokePort, timeoutMs: args.healthTimeoutMs }); report.stages.push('smoked'); }
    report.applied = true;
    return finish(true);
  } catch (error) {
    report.error = String(error?.message || error);
    await finish(false);
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { report });
  } finally {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

function format(result) {
  const port = result.options?.port || DEFAULT_INSTALL_PORT;
  return [
    `Burrow package install: ${result.ok ? 'ok' : 'failed'}`,
    `Mode: ${result.applied ? 'applied' : 'preview'}`,
    `Install dir: ${result.installDir}`,
    result.releaseId ? `Release: ${result.releaseId}` : null,
    `Stages: ${result.stages.join(', ')}`,
    result.reportPath ? `Report: ${result.reportPath}` : null,
    result.warnings.length ? `Warnings: ${result.warnings.join('; ')}` : null,
    result.applied ? `Config: ${path.join(result.installDir, 'burrow.env')}` : null,
    result.applied ? `Start: set -a; . ${path.join(result.installDir, 'burrow.env')}; set +a; node ${path.join(result.installDir, 'bin', 'burrow.mjs')} serve --root ${result.installDir}` : null,
    result.applied ? `Health: curl http://127.0.0.1:${port}/health` : null,
  ].filter(Boolean).join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); process.exit(0); }
  try {
    const result = await installReleasePackage(args);
    console.log(args.json ? JSON.stringify(result, null, 2) : format(result));
  } catch (error) {
    const output = error.report || { ok: false, error: String(error?.message || error) };
    if (args.json) console.error(JSON.stringify(output, null, 2));
    else console.error(`Burrow package install: failed (${output.error || error.message})`);
    process.exitCode = 1;
  }
}
