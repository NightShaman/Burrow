#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { ensureRuntimeIntegrations } from './ensure-runtime-integrations.mjs';
import { coldBackupPolicy, restoreInventory } from './portable-backup-policy.mjs';
const execFileAsync = promisify(execFile);
const ARCHIVE_ROOT = 'burrow-install';
const REQUIRED = ['app', 'bin', 'burrow.env', 'config', 'workspace', 'integrations'];
const MANIFEST = 'portable-install-manifest.json';
const TAR_LIST_MAX_BUFFER = 64 * 1024 * 1024;

function nonEmpty(value, name) { if (!value) throw new Error(`${name} is required`); return value; }

export function parseArgs(argv = []) {
  const args = { root: null, output: null, archive: null, home: process.env.HOME || os.homedir(), confirm: false, replace: false, overwrite: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--confirm') args.confirm = true;
    else if (arg === '--overwrite') args.overwrite = true;
    else if (arg === '--replace') args.replace = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--root') args.root = argv[++i];
    else if (arg === '--output') args.output = argv[++i];
    else if (arg === '--archive') args.archive = argv[++i];
    else if (arg === '--home') args.home = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

export function usage() {
  return `Usage:\n  burrow install-backup --output FILE [--root DIR] [--overwrite] [--confirm] [--json]\n  burrow install-restore --archive FILE [--home DIR] [--replace] [--confirm] [--json]\n\nCreates/restores a complete portable Burrow install. Backup is dry-run by default. Restore targets <home>/.burrow, requires explicit --mapping-file JSON for retained absolute paths/database settings, preserves modes, and assigns ownership to the target home owner.\n`;
}

async function exists(file) { try { await fs.lstat(file); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }
async function directoryIsEmpty(dir) { try { return (await fs.readdir(dir)).length === 0; } catch (error) { if (error?.code === 'ENOENT') return true; throw error; } }

export async function planPortableInstallBackup({ root, output, overwrite = false, now = new Date(), runCommand = execFileAsync } = {}) {
  const installRoot = path.resolve(nonEmpty(root, '--root'));
  const archive = path.resolve(nonEmpty(output, '--output'));
  if (await exists(archive) && !overwrite) throw new Error('backup output exists; pass --overwrite to replace it');
  const stat = await fs.stat(installRoot);
  if (!stat.isDirectory()) throw new Error(`install root is not a directory: ${installRoot}`);
  if (archive === installRoot || archive.startsWith(`${installRoot}${path.sep}`)) throw new Error('backup archive must be outside the install root');
  const policy = await exists(path.join(installRoot, 'burrow.env')) ? await coldBackupPolicy(installRoot, runCommand) : null;
  const required = [...REQUIRED];
  const present = await Promise.all(required.map(async (entry) => ({ entry, exists: await exists(path.join(installRoot, entry)) })));
  return { ok: present.every((entry) => entry.exists), dryRun: true, installRoot, archive, policy, required, missing: present.filter((entry) => !entry.exists).map((entry) => entry.entry), createdAt: now.toISOString() };
}

export async function createPortableInstallBackup({ root, output, overwrite = false, now = new Date(), runTar = execFileAsync, runCommand = execFileAsync } = {}) {
  const plan = await planPortableInstallBackup({ root, output, overwrite, now, runCommand });
  if (!plan.ok) return { ...plan, dryRun: false, created: false, error: 'incomplete_install_root' };
  await fs.mkdir(path.dirname(plan.archive), { recursive: true });
  const staging = await fs.mkdtemp(path.join(path.dirname(plan.archive), '.burrow-portable-backup-'));
  const pendingArchive = path.join(staging, 'archive.tar.gz');
  try {
    const stagedRoot = path.join(staging, ARCHIVE_ROOT);
    await fs.cp(plan.installRoot, stagedRoot, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      filter: (source) => source === plan.installRoot || !path.basename(source).startsWith('.app-staging-'),
    });
    await fs.writeFile(path.join(stagedRoot, MANIFEST), `${JSON.stringify({ format: 1, policy: plan.policy, createdAt: plan.createdAt, archiveRoot: ARCHIVE_ROOT, required: plan.required, checksums: await inventory(stagedRoot) }, null, 2)}\n`, { mode: 0o600 });
    const outputHandle = await fs.open(pendingArchive, 'wx', 0o600);
    await outputHandle.close();
    await runTar('tar', ['-czf', pendingArchive, '-C', staging, ARCHIVE_ROOT], { timeout: 300_000 });
    await coldBackupPolicy(plan.installRoot, runCommand);
    await fs.chmod(pendingArchive, 0o600);
    await validateArchive(pendingArchive, runTar);
    if (overwrite) await fs.rename(pendingArchive, plan.archive);
    else { await fs.link(pendingArchive, plan.archive); await fs.unlink(pendingArchive); }
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
  return { ...plan, dryRun: false, created: true };
}

function safeArchiveEntry(entry) {
  const normalized = entry.replace(/^\.\//, '');
  return !normalized.split('/').includes('..') && (normalized === ARCHIVE_ROOT || normalized.startsWith(`${ARCHIVE_ROOT}/`));
}

async function archiveEntries(archive, runTar) {
  const { stdout } = await runTar('tar', ['-tzf', archive], { timeout: 120_000, maxBuffer: TAR_LIST_MAX_BUFFER });
  const entries = stdout.split('\n').filter(Boolean);
  if (!entries.length || entries.some((entry) => !safeArchiveEntry(entry))) throw new Error('archive contains paths outside the portable install root');
  return entries;
}

// Validate before any manifest read, environment write, integration removal, or chown.
// Relative links within the install remain portable; external/absolute links do not.
async function validateRestoredTree(root) {
  const rootStat = await fs.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('unsafe restore root');
  const controls = new Set([MANIFEST, 'burrow.env', 'integrations', 'integrations/mcporter', 'integrations/claude-code']);
  const inside = (target) => target === root || target.startsWith(`${root}${path.sep}`);
  const walk = async (current) => {
    const stat = await fs.lstat(current);
    const relative = path.relative(root, current);
    if (stat.isSymbolicLink()) {
      const link = await fs.readlink(current);
      if (controls.has(relative) || path.isAbsolute(link) || !inside(path.resolve(path.dirname(current), link))) {
        throw new Error(`unsafe restore link: ${relative}`);
      }
      let resolved;
      try { resolved = await fs.realpath(current); }
      catch { throw new Error(`unsafe restore unresolved link: ${relative}`); }
      if (!inside(resolved)) throw new Error(`unsafe restore link: ${relative}`);
    } else if (stat.isDirectory()) {
      for (const entry of await fs.readdir(current)) await walk(path.join(current, entry));
    } else if (!stat.isFile() || stat.nlink > 1) {
      throw new Error(`unsafe restore special or hard-linked file: ${relative}`);
    }
  };
  await walk(root);
}

async function inventory(root) {
  const result = {};
  const walk = async (dir) => {
    for (const name of (await fs.readdir(dir)).sort()) {
      const file = path.join(dir, name), relative = path.relative(root, file);
      if (relative === MANIFEST) continue;
      const stat = await fs.lstat(file);
      if (stat.isDirectory()) { result[relative] = 'directory'; await walk(file); }
      else if (stat.isSymbolicLink()) result[relative] = `link:${await fs.readlink(file)}`;
      else result[relative] = `sha256:${createHash('sha256').update(await fs.readFile(file)).digest('hex')}`;
    }
  };
  await walk(root);
  return result;
}

async function validateInstall(root) {
  await validateRestoredTree(root);
  for (const entry of REQUIRED) {
    const stat = await fs.lstat(path.join(root, entry));
    if (stat.isSymbolicLink() || (entry === 'burrow.env' ? !stat.isFile() : !stat.isDirectory())) throw new Error(`invalid required asset: ${entry}`);
  }
  const backend = await exists(path.join(root, 'app/backend/package.json')) ? 'app/backend' : 'app';
  for (const file of [`${backend}/package.json`, 'bin/burrow', `${backend}/scripts/runtime-integrations.json`]) {
    if (!(await fs.stat(path.join(root, file))).isFile()) throw new Error(`invalid required asset: ${file}`);
  }
  const pkg = JSON.parse(await fs.readFile(path.join(root, backend, 'package.json'), 'utf8'));
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new Error('invalid package JSON');
  const env = await fs.readFile(path.join(root, 'burrow.env'), 'utf8');
  if (env.includes('\0') || env.split('\n').some(line => line.trim() && !line.trim().startsWith('#') && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(line))) throw new Error('invalid environment format');
}

async function validateArchiveRoot(root) {
  await validateInstall(root);
  const manifest = JSON.parse(await fs.readFile(path.join(root, MANIFEST), 'utf8'));
  if (manifest?.format !== 1 || manifest.archiveRoot !== ARCHIVE_ROOT || !Array.isArray(manifest.required) || JSON.stringify(manifest.required) !== JSON.stringify(REQUIRED)) throw new Error('unsupported portable install manifest');
  if (JSON.stringify(manifest.checksums) !== JSON.stringify(await inventory(root))) throw new Error('portable install checksum mismatch');
}

async function validateArchive(archive, runTar) {
  const entries = await archiveEntries(archive, runTar);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'burrow-archive-check-'));
  try {
    await runTar('tar', ['-xzf', archive, '-C', temporary, '--no-same-owner', '--same-permissions'], { timeout: 300_000 });
    await validateArchiveRoot(path.join(temporary, ARCHIVE_ROOT));
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  return entries;
}

async function previewEnvironment(archive, runTar) {
  const { stdout } = await runTar('tar', ['-xOzf', archive, `${ARCHIVE_ROOT}/burrow.env`], { maxBuffer: TAR_LIST_MAX_BUFFER });
  return restoreInventory(stdout);
}

async function applyOwnership(root, owner) {
  const walk = async (current) => {
    const stat = await fs.lstat(current);
    await fs.lchown(current, owner.uid, owner.gid);
    if (stat.isDirectory()) for (const entry of await fs.readdir(current)) await walk(path.join(current, entry));
  };
  await walk(root);
}

const RESTORED_INSTALL_PATHS = Object.freeze({
  BURROW_RUNTIME_ROOT: (root) => root,
  BURROW_WORKSPACE_ROOT: (root) => path.join(root, 'workspace'),
  BURROW_CACHE_ROOT: (root) => path.join(root, 'cache'),
  BURROW_CLAUDE_BIN: (root) => path.join(root, 'integrations', 'claude-code', 'node_modules', '.bin', 'claude'),
});

async function rebaseRestoredEnvironment(installRoot, finalRoot = installRoot, mapping = {}) {
  const envPath = path.join(installRoot, 'burrow.env');
  const original = await fs.readFile(envPath, 'utf8');
  const lines = original.split('\n');
  const rebased = lines.map((line) => {
    const separator = line.indexOf('=');
    if (separator < 1) return line;
    const key = line.slice(0, separator);
    if (Object.hasOwn(mapping, key)) return `${key}=${mapping[key]}`;
    const resolvePath = RESTORED_INSTALL_PATHS[key];
    if (!resolvePath) return line;
    const resolved = resolvePath(finalRoot);
    return resolved === null ? null : `${key}=${resolved}`;
  }).filter((line) => line !== null);
  await fs.writeFile(envPath, rebased.join('\n'), { mode: 0o600 });
  await fs.chmod(envPath, 0o600);
}

async function installRestoredIntegrations(installRoot, runCommand = execFileAsync) {
  const backend = await exists(path.join(installRoot, 'app/backend/package.json')) ? 'app/backend' : 'app';
  const manifest = JSON.parse(await fs.readFile(path.join(installRoot, backend, 'scripts/runtime-integrations.json'), 'utf8'));
  const integrations = Object.entries(manifest).map(([id, spec]) => {
    if (!/^[a-z0-9-]+$/.test(id) || !spec || !/^(?:@[a-z0-9-]+\/)?[a-z0-9.-]+$/.test(spec.packageName) ||
        !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(spec.version) || !/^[a-z0-9-]+$/.test(spec.executable)) {
      throw new Error('invalid pinned release integration manifest');
    }
    return { id, packageName: spec.packageName, version: spec.version, executable: spec.executable };
  });
  if (!integrations.length) throw new Error('empty release integration manifest');
  await ensureRuntimeIntegrations({ runtimeRoot: installRoot, integrations, runCommand, logger: { log() {} } });
}

export async function planPortableInstallRestore({ archive, home = process.env.HOME || os.homedir(), replace = false, runTar = execFileAsync } = {}) {
  const sourceArchive = path.resolve(nonEmpty(archive, '--archive'));
  if (!await exists(sourceArchive)) throw new Error(`archive does not exist: ${sourceArchive}`);
  const targetHome = path.resolve(nonEmpty(home, '--home'));
  if (!/^[A-Za-z0-9_./-]+$/.test(targetHome)) throw new Error('restore home contains unsupported characters (use letters, digits, _, ., /, -)');
  const homeStat = await fs.stat(targetHome);
  if (!homeStat.isDirectory()) throw new Error(`restore home is not a directory: ${targetHome}`);
  const target = path.join(targetHome, '.burrow');
  const targetExists = await exists(target);
  const targetEmpty = targetExists ? await directoryIsEmpty(target) : true;
  if (targetExists && !targetEmpty && !replace) throw new Error(`restore target exists: ${target}; pass --replace with --confirm to replace it`);
  const entries = await validateArchive(sourceArchive, runTar);
  return { ok: true, dryRun: true, archive: sourceArchive, targetHome, target, replace: Boolean(replace), targetExists, archiveEntries: entries.length, environmentInventory: await previewEnvironment(sourceArchive, runTar), owner: { uid: homeStat.uid, gid: homeStat.gid } };
}

export async function restorePortableInstall({ archive, home = process.env.HOME || os.homedir(), replace = false, mappingFile = null, runTar = execFileAsync, runCommand = execFileAsync } = {}) {
  const plan = await planPortableInstallRestore({ archive, home, replace, runTar });
  const mapping = mappingFile ? JSON.parse(await fs.readFile(mappingFile, 'utf8')) : {};
  if (!mapping || Array.isArray(mapping) || typeof mapping !== 'object' || Object.entries(mapping).some(([key, value]) => !/^[A-Z_][A-Z0-9_]*$/.test(key) || typeof value !== 'string' || /[\r\n]/.test(value))) throw new Error('invalid restore mapping');
  for (const entry of plan.environmentInventory) if (entry.requiresMapping && !Object.hasOwn(mapping, entry.key)) throw new Error(`restore requires explicit mapping for ${entry.key}; use --mapping-file JSON`);
  const staging = await fs.mkdtemp(path.join(plan.targetHome, '.burrow-restore-'));
  let preserveStaging = false;
  try {
    await runTar('tar', ['-xzf', plan.archive, '-C', staging, '--no-same-owner', '--same-permissions'], { timeout: 300_000 });
    const stagedRoot = path.join(staging, ARCHIVE_ROOT);
    await validateArchiveRoot(stagedRoot);
    const manifestPath = path.join(stagedRoot, MANIFEST);
    if (!await exists(manifestPath)) throw new Error('archive is missing portable install manifest');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (manifest?.format !== 1 || manifest?.archiveRoot !== ARCHIVE_ROOT) throw new Error('archive has an unsupported portable install manifest');
    // Preparation must not remove or mutate the previous installation (OPS-002).
    await fs.rm(manifestPath, { force: true });
    if (manifest.policy?.databaseMode === 'managed' && Object.hasOwn(mapping, 'BURROW_POSTGRES_LIFECYCLE') && mapping.BURROW_POSTGRES_LIFECYCLE !== 'managed') throw new Error('physical managed archive cannot switch database lifecycle during restore');
    if (manifest.policy?.databaseMode === 'managed' && (manifest.policy.sourceOwner !== os.userInfo().username || manifest.policy.sourceUid !== plan.owner.uid)) throw new Error('managed physical restore requires same OS owner; use logical PostgreSQL role migration separately');
    if (!manifest.policy && plan.environmentInventory.some(entry => entry.databaseIdentity)) throw new Error('legacy database archive lacks source owner evidence; create a new cold backup');
    await rebaseRestoredEnvironment(stagedRoot, plan.target, mapping);
    await installRestoredIntegrations(stagedRoot, runCommand);
    if (process.getuid?.() !== plan.owner.uid || process.getgid?.() !== plan.owner.gid) await applyOwnership(stagedRoot, plan.owner);
    const previousRoot = path.join(staging, 'previous-install');
    let previousMoved = false;
    if (plan.targetExists) {
      await fs.rename(plan.target, previousRoot);
      previousMoved = true;
    }
    try {
      await fs.rename(stagedRoot, plan.target);
    } catch (activationError) {
      if (previousMoved) {
        try { await fs.rename(previousRoot, plan.target); }
        catch (rollbackError) {
          // Never let staging cleanup destroy the only remaining old installation.
          preserveStaging = true;
          throw new AggregateError([activationError, rollbackError], `Restore activation and rollback failed; previous installation retained at ${previousRoot}`);
        }
      }
      throw activationError;
    }
    return { ...plan, dryRun: false, restored: true, serviceCommand: `${path.join(plan.target, 'bin', 'burrow')} service install` };
  } finally { if (!preserveStaging) await fs.rm(staging, { recursive: true, force: true }); }
}

export function formatPortableInstallResult(result) {
  if (result.restored) return `Burrow portable install restored to: ${result.target}\nOwnership: ${result.owner.uid}:${result.owner.gid}\nRecreate the user service: ${result.serviceCommand}`;
  if (result.created) return `Burrow cold install-tree backup created: ${result.archive}\nExclusions: ${result.policy.exclusions.join('; ')}`;
  if (result.dryRun && result.target) return `Burrow portable install restore planned: ${result.archive} → ${result.target}\nRetained environment inventory: ${JSON.stringify(result.environmentInventory)}\nDry run only. Re-run with --confirm to restore.`;
  return `Burrow cold install-tree backup ${result.ok ? 'planned' : 'failed'}: ${result.archive}\nExclusions: ${result.policy?.exclusions.join('; ') || '(incomplete source)'}\n${result.dryRun ? 'Dry run only. Re-run with --confirm to create the archive.' : ''}`;
}
