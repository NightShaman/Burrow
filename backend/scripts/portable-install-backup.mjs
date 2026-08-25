#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const ARCHIVE_ROOT = 'burrow-install';
const MANIFEST = 'portable-install-manifest.json';

function nonEmpty(value, name) { if (!value) throw new Error(`${name} is required`); return value; }

export function parseArgs(argv = []) {
  const args = { root: null, output: null, archive: null, home: process.env.HOME || os.homedir(), confirm: false, replace: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--confirm') args.confirm = true;
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
  return `Usage:\n  burrow install-backup --output FILE [--root DIR] [--confirm] [--json]\n  burrow install-restore --archive FILE [--home DIR] [--replace] [--confirm] [--json]\n\nCreates/restores a complete portable Burrow install. Backup is dry-run by default. Restore targets <home>/.burrow, preserves modes, and assigns ownership to the target home owner.\n`;
}

async function exists(file) { try { await fs.lstat(file); return true; } catch (error) { if (error?.code === 'ENOENT') return false; throw error; } }
async function directoryIsEmpty(dir) { try { return (await fs.readdir(dir)).length === 0; } catch (error) { if (error?.code === 'ENOENT') return true; throw error; } }

export async function planPortableInstallBackup({ root, output, now = new Date() } = {}) {
  const installRoot = path.resolve(nonEmpty(root, '--root'));
  const archive = path.resolve(nonEmpty(output, '--output'));
  const stat = await fs.stat(installRoot);
  if (!stat.isDirectory()) throw new Error(`install root is not a directory: ${installRoot}`);
  if (archive === installRoot || archive.startsWith(`${installRoot}${path.sep}`)) throw new Error('backup archive must be outside the install root');
  const required = ['app', 'bin', 'burrow.env', 'config', 'workspace', 'agentdata', 'integrations'];
  const present = await Promise.all(required.map(async (entry) => ({ entry, exists: await exists(path.join(installRoot, entry)) })));
  return { ok: present.every((entry) => entry.exists), dryRun: true, installRoot, archive, required, missing: present.filter((entry) => !entry.exists).map((entry) => entry.entry), createdAt: now.toISOString() };
}

export async function createPortableInstallBackup({ root, output, now = new Date(), runTar = execFileAsync } = {}) {
  const plan = await planPortableInstallBackup({ root, output, now });
  if (!plan.ok) return { ...plan, dryRun: false, created: false, error: 'incomplete_install_root' };
  await fs.mkdir(path.dirname(plan.archive), { recursive: true });
  const staging = await fs.mkdtemp(path.join(path.dirname(plan.archive), '.burrow-portable-backup-'));
  try {
    const stagedRoot = path.join(staging, ARCHIVE_ROOT);
    await fs.cp(plan.installRoot, stagedRoot, { recursive: true, dereference: false, preserveTimestamps: true });
    await fs.writeFile(path.join(stagedRoot, MANIFEST), `${JSON.stringify({ format: 1, createdAt: plan.createdAt, archiveRoot: ARCHIVE_ROOT, required: plan.required }, null, 2)}\n`, { mode: 0o600 });
    await runTar('tar', ['-czf', plan.archive, '-C', staging, ARCHIVE_ROOT], { timeout: 300_000 });
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
  return { ...plan, dryRun: false, created: true };
}

function safeArchiveEntry(entry) {
  const normalized = entry.replace(/^\.\//, '');
  return normalized === ARCHIVE_ROOT || normalized.startsWith(`${ARCHIVE_ROOT}/`);
}

async function archiveEntries(archive, runTar) {
  const { stdout } = await runTar('tar', ['-tzf', archive], { timeout: 120_000 });
  const entries = stdout.split('\n').filter(Boolean);
  if (!entries.length || entries.some((entry) => !safeArchiveEntry(entry))) throw new Error('archive contains paths outside the portable install root');
  return entries;
}

async function applyOwnership(root, owner) {
  const walk = async (current) => {
    const stat = await fs.lstat(current);
    await fs.chown(current, owner.uid, owner.gid);
    if (stat.isDirectory()) for (const entry of await fs.readdir(current)) await walk(path.join(current, entry));
  };
  await walk(root);
}

export async function planPortableInstallRestore({ archive, home = process.env.HOME || os.homedir(), replace = false, runTar = execFileAsync } = {}) {
  const sourceArchive = path.resolve(nonEmpty(archive, '--archive'));
  if (!await exists(sourceArchive)) throw new Error(`archive does not exist: ${sourceArchive}`);
  const targetHome = path.resolve(nonEmpty(home, '--home'));
  const homeStat = await fs.stat(targetHome);
  if (!homeStat.isDirectory()) throw new Error(`restore home is not a directory: ${targetHome}`);
  const target = path.join(targetHome, '.burrow');
  const targetExists = await exists(target);
  const targetEmpty = targetExists ? await directoryIsEmpty(target) : true;
  if (targetExists && !targetEmpty && !replace) throw new Error(`restore target exists: ${target}; pass --replace with --confirm to replace it`);
  const entries = await archiveEntries(sourceArchive, runTar);
  return { ok: true, dryRun: true, archive: sourceArchive, targetHome, target, replace: Boolean(replace), targetExists, archiveEntries: entries.length, owner: { uid: homeStat.uid, gid: homeStat.gid } };
}

export async function restorePortableInstall({ archive, home = process.env.HOME || os.homedir(), replace = false, runTar = execFileAsync } = {}) {
  const plan = await planPortableInstallRestore({ archive, home, replace, runTar });
  const staging = await fs.mkdtemp(path.join(plan.targetHome, '.burrow-restore-'));
  try {
    await runTar('tar', ['-xzf', plan.archive, '-C', staging, '--no-same-owner', '--same-permissions'], { timeout: 300_000 });
    const stagedRoot = path.join(staging, ARCHIVE_ROOT);
    const manifestPath = path.join(stagedRoot, MANIFEST);
    if (!await exists(manifestPath)) throw new Error('archive is missing portable install manifest');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (manifest?.format !== 1 || manifest?.archiveRoot !== ARCHIVE_ROOT) throw new Error('archive has an unsupported portable install manifest');
    if (plan.targetExists) await fs.rm(plan.target, { recursive: true, force: true });
    await fs.rename(stagedRoot, plan.target);
    await fs.rm(path.join(plan.target, MANIFEST), { force: true });
    if (process.getuid?.() !== plan.owner.uid || process.getgid?.() !== plan.owner.gid) await applyOwnership(plan.target, plan.owner);
    return { ...plan, dryRun: false, restored: true, serviceCommand: `${path.join(plan.target, 'bin', 'burrow')} service install` };
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
}

export function formatPortableInstallResult(result) {
  if (result.restored) return `Burrow portable install restored to: ${result.target}\nOwnership: ${result.owner.uid}:${result.owner.gid}\nRecreate the user service: ${result.serviceCommand}`;
  if (result.created) return `Burrow portable install backup created: ${result.archive}`;
  if (result.dryRun && result.target) return `Burrow portable install restore planned: ${result.archive} → ${result.target}\nDry run only. Re-run with --confirm to restore.`;
  return `Burrow portable install backup ${result.ok ? 'planned' : 'failed'}: ${result.archive}\n${result.dryRun ? 'Dry run only. Re-run with --confirm to create the archive.' : ''}`;
}
