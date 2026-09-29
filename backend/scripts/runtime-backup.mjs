#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveRuntimeStateConfig } from '../src/config.mjs';

const execFileAsync = promisify(execFile);
export const WORKSPACE_BACKUP_PATHS = ['skills', 'tools', 'artifacts'];
export const POSTGRES_BACKUP_PATH = 'postgres/burrow.dump';

export function parseArgs(argv = []) {
  const args = { root: process.cwd(), output: null, workspaceRoot: null, json: false, confirm: false };
  for (let i = 0; i < argv.length; i++) { const arg = argv[i]; if (arg === '--root') args.root = argv[++i]; else if (arg === '--workspace-root') args.workspaceRoot = argv[++i]; else if (arg === '--output') args.output = argv[++i]; else if (arg === '--json') args.json = true; else if (arg === '--confirm') args.confirm = true; else if (arg === '--help' || arg === '-h') args.help = true; else throw new Error(`unknown argument: ${arg}`); }
  return args;
}
export function usage() { return 'Usage: node scripts/runtime-backup.mjs [--root DIR] [--workspace-root DIR] [--output FILE] [--confirm] [--json]\n\nCreates a PostgreSQL dump plus file-backed workspace artifacts. Dry-run by default.\n'; }
function timestampFor(date = new Date()) { return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); }
async function exists(file) { try { await fs.access(file); return true; } catch { return false; } }
export async function planRuntimeBackup({ root = process.cwd(), workspaceRoot = null, output = null, now = new Date() } = {}) {
  const sourceRoot = path.resolve(root);
  const runtimeState = resolveRuntimeStateConfig({ rootDir: sourceRoot, args: { runtime_root: sourceRoot, ...(workspaceRoot ? { workspace_root: workspaceRoot } : {}) } });
  const agents = await fs.readdir(runtimeState.workspaceRoot, { withFileTypes: true }).catch(() => []);
  const workspaceEntries = [];
  for (const agent of agents.filter((entry) => entry.isDirectory() && entry.name !== 'global')) for (const relative of WORKSPACE_BACKUP_PATHS) {
    const source = path.join(runtimeState.workspaceRoot, agent.name, relative);
    if (await exists(source)) workspaceEntries.push({ agentId: agent.name, root: path.join(runtimeState.workspaceRoot, agent.name), path: relative, archivePath: path.posix.join('workspaces', agent.name, relative) });
  }
  const archive = path.resolve(runtimeState.archiveRoot, output || `burrow-runtime-${timestampFor(now)}.tar.gz`);
  return { ok: true, dryRun: true, sourceRoot, archive, postgres: { archivePath: POSTGRES_BACKUP_PATH }, workspaceEntries, included: [], missing: [] };
}
export async function createRuntimeBackup({ runCommand = execFileAsync, runTar = execFileAsync, ...options } = {}) {
  const plan = await planRuntimeBackup(options); await fs.mkdir(path.dirname(plan.archive), { recursive: true });
  const staging = await fs.mkdtemp(path.join(path.dirname(plan.archive), '.burrow-backup-'));
  try {
    const dump = path.join(staging, POSTGRES_BACKUP_PATH); await fs.mkdir(path.dirname(dump), { recursive: true, mode: 0o700 });
    await runCommand('pg_dump', ['--format=custom', '--file', dump, process.env.BURROW_POSTGRES_URL || 'postgresql://postgres@127.0.0.1:5432/postgres'], { timeout: 300_000 });
    for (const entry of plan.workspaceEntries) await fs.cp(path.join(entry.root, entry.path), path.join(staging, entry.archivePath), { recursive: true, dereference: false });
    await runTar('tar', ['-czf', plan.archive, '-C', staging, 'postgres', ...(plan.workspaceEntries.length ? ['workspaces'] : [])], { timeout: 300_000 });
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
  return { ...plan, dryRun: false, created: true };
}
export function formatBackupText(result) { return [`Burrow runtime backup: ${result.dryRun ? 'planned' : 'created'}`, `Archive: ${result.archive}`, `PostgreSQL: ${POSTGRES_BACKUP_PATH}`, `Files: ${result.workspaceEntries.map((entry) => entry.archivePath).join(', ') || '(none)'}`].join('\n'); }
if (import.meta.url === `file://${process.argv[1]}`) { const args = parseArgs(process.argv.slice(2)); if (args.help) console.log(usage()); else { const result = args.confirm ? await createRuntimeBackup(args) : await planRuntimeBackup(args); console.log(args.json ? JSON.stringify(result, null, 2) : formatBackupText(result)); } }
