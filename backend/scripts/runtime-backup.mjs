#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadBurrowConfig, resolveRuntimeStateConfig } from '../src/config.mjs';
import { AgentRegistryStore } from '../src/agent-registry.mjs';

const execFileAsync = promisify(execFile);

export const DEFAULT_BACKUP_PATHS = ['sessions', 'handoffs', 'memory', 'profile', 'skills', 'tools', 'artifacts'];
export const SETTINGS_BACKUP_PATH = 'config/settings.sqlite';
export const WORKSPACE_BACKUP_PATHS = DEFAULT_BACKUP_PATHS;

export function parseArgs(argv = []) {
  const args = {
    root: process.cwd(),
    output: null,
    config: null,
    dataRoot: null,
    workspaceRoot: null,
    agentId: null,
    json: false,
    confirm: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') args.root = argv[++i];
    else if (arg === '--config') args.config = argv[++i];
    else if (arg === '--data-root') args.dataRoot = argv[++i];
    else if (arg === '--workspace-root') args.workspaceRoot = argv[++i];
    else if (arg === '--agent-id') args.agentId = argv[++i];
    else if (arg === '--output') args.output = argv[++i];
    else if (arg === '--json') args.json = true;
    else if (arg === '--confirm') args.confirm = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

export function usage() {
  return `Usage: node scripts/runtime-backup.mjs [--root DIR] [--config FILE] [--data-root DIR] [--workspace-root DIR] [--agent-id ID] [--output FILE] [--confirm] [--json]\n\nPlans or creates a scoped Burrow runtime-state backup from the resolved runtime data root. Dry-run by default; pass --confirm to create the archive.\n`;
}

async function pathInfo(root, relativePath) {
  const fullPath = path.join(root, relativePath);
  try {
    const stat = await fs.stat(fullPath);
    return {
      path: relativePath,
      exists: true,
      type: stat.isDirectory() ? 'directory' : stat.isFile() ? 'file' : 'other',
      size: stat.size,
      mtime: stat.mtime.toISOString(),
    };
  } catch (error) {
    if (error?.code === 'ENOENT') return { path: relativePath, exists: false, type: null, size: 0, mtime: null };
    throw error;
  }
}

function timestampFor(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

export async function resolveBackupRoots({ root = process.cwd(), config = null, dataRoot = null, workspaceRoot = null, agentId = null, settingsDatabasePath = null } = {}) {
  const resolvedRoot = path.resolve(root);
  const loaded = await loadBurrowConfig({ rootDir: resolvedRoot, configPath: config });
  const resolvedAgentId = agentId || null;
  const runtimeState = resolveRuntimeStateConfig({ rootDir: resolvedRoot, args: { ...(dataRoot ? { data_root: dataRoot } : {}), ...(workspaceRoot ? { workspace_root: workspaceRoot } : {}), ...(resolvedAgentId ? { agent_id: resolvedAgentId } : {}), ...(workspaceRoot && resolvedAgentId ? { agent_workspace_root: path.join(workspaceRoot, resolvedAgentId) } : {}), ...(settingsDatabasePath ? { settings_database_path: settingsDatabasePath } : {}) }, loadedConfig: loaded.config });
  return { sourceRoot: resolvedRoot, dataRoot: runtimeState.dataRoot, runtimeState, configPath: loaded.path, configExists: loaded.exists };
}

async function workspaceBackupRoots(runtimeState, settingsExists) {
  const roots = new Map([[runtimeState.agentId, runtimeState.agentWorkspaceRoot]]);
  if (!settingsExists) return [...roots.entries()].map(([agentId, root]) => ({ agentId, root }));
  let agents = null;
  try {
    agents = new AgentRegistryStore({ databasePath: runtimeState.settingsDatabasePath, bootstrapSampleIdentities: false });
    for (const agent of agents.list({ includeDisabled: true })) roots.set(agent.id, path.resolve(runtimeState.workspaceRoot, agent.id));
  } catch (error) {
    // The backup snapshot will still reject a corrupt SQLite database. Planning
    // can safely preserve the explicitly resolved workspace without querying it.
    if (!/file is not a database/i.test(String(error?.message || error))) throw error;
  } finally { agents?.close(); }
  return [...roots.entries()].map(([agentId, root]) => ({ agentId, root }));
}


export async function planRuntimeBackup({ root = process.cwd(), config = null, dataRoot = null, workspaceRoot = null, agentId = null, settingsDatabasePath = null, output = null, now = new Date(), paths = DEFAULT_BACKUP_PATHS } = {}) {
  const roots = await resolveBackupRoots({ root, config, dataRoot, workspaceRoot, agentId, settingsDatabasePath });
  const entries = await Promise.all(paths.map((relativePath) => pathInfo(roots.dataRoot, relativePath)));
  const settings = await pathInfo(path.dirname(roots.runtimeState.settingsDatabasePath), path.basename(roots.runtimeState.settingsDatabasePath));
  settings.path = SETTINGS_BACKUP_PATH;
  const included = entries.filter((entry) => entry.exists);
  const missing = entries.filter((entry) => !entry.exists).map((entry) => entry.path);
  const workspaceRoots = await workspaceBackupRoots(roots.runtimeState, settings.exists);
  const workspaceEntries = (await Promise.all(workspaceRoots.map(async ({ agentId, root }) => ({ agentId, root, entries: await Promise.all(WORKSPACE_BACKUP_PATHS.map((relativePath) => pathInfo(root, relativePath))) })))).flatMap(({ agentId, root, entries: candidateEntries }) => candidateEntries.filter((entry) => entry.exists).map((entry) => ({ ...entry, agentId, root, archivePath: path.posix.join('workspaces', agentId, entry.path) })));
  const archive = path.resolve(roots.runtimeState.archiveRoot, output || `burrow-runtime-${timestampFor(now)}.tar.gz`);
  return {
    ok: included.length > 0 || workspaceEntries.length > 0 || settings.exists,
    dryRun: true,
    root: roots.dataRoot,
    sourceRoot: roots.sourceRoot,
    dataRoot: roots.dataRoot,
    archive,
    included,
    workspaceRoots,
    workspaceEntries,
    settingsDatabase: { path: roots.runtimeState.settingsDatabasePath, exists: settings.exists, archivePath: SETTINGS_BACKUP_PATH },
    missing: [...missing, ...(settings.exists ? [] : [SETTINGS_BACKUP_PATH])],
    config: { path: roots.configPath, exists: roots.configExists },
  };
}

export async function createRuntimeBackup({ root = process.cwd(), config = null, dataRoot = null, workspaceRoot = null, agentId = null, settingsDatabasePath = null, output = null, now = new Date(), runTar = execFileAsync } = {}) {
  const plan = await planRuntimeBackup({ root, config, dataRoot, workspaceRoot, agentId, settingsDatabasePath, output, now });
  if (!plan.ok) return { ...plan, dryRun: false, created: false, error: 'no_backup_paths_exist' };
  await fs.mkdir(path.dirname(plan.archive), { recursive: true });
  const staging = await fs.mkdtemp(path.join(path.dirname(plan.archive), '.burrow-backup-'));
  try {
    for (const entry of plan.included) await fs.cp(path.join(plan.dataRoot, entry.path), path.join(staging, 'agentdata', entry.path), { recursive: true, dereference: false });
    for (const entry of plan.workspaceEntries) await fs.cp(path.join(entry.root, entry.path), path.join(staging, entry.archivePath), { recursive: true, dereference: false });
    if (plan.settingsDatabase.exists) {
      const snapshot = path.join(staging, SETTINGS_BACKUP_PATH);
      await fs.mkdir(path.dirname(snapshot), { recursive: true, mode: 0o700 });
      const db = new DatabaseSync(plan.settingsDatabase.path);
      try { db.exec(`VACUUM INTO '${snapshot.replace(/'/g, "''")}';`); } finally { db.close(); }
    }
    const includePaths = [...(plan.included.length ? ['agentdata'] : []), ...(plan.workspaceEntries.length ? ['workspaces'] : []), ...(plan.settingsDatabase.exists ? ['config'] : [])];
    await runTar('tar', ['-czf', plan.archive, '-C', staging, ...includePaths], { timeout: 120_000 });
  } finally { await fs.rm(staging, { recursive: true, force: true }); }
  return { ...plan, dryRun: false, created: true };
}

export function formatBackupText(result) {
  const lines = [];
  lines.push(`Burrow runtime backup: ${result.ok ? (result.dryRun ? 'planned' : 'created') : 'failed'}`);
  lines.push(`Source root: ${result.sourceRoot || result.root}`);
  lines.push(`Data root: ${result.dataRoot || result.root}`);
  lines.push(`Archive: ${result.archive}`);
  lines.push(`Included: ${[...result.included.map((entry) => entry.path), ...(result.workspaceEntries || []).map((entry) => entry.archivePath)].join(', ') || '(none)'}`);
  if (result.missing.length) lines.push(`Missing: ${result.missing.join(', ')}`);
  if (result.dryRun) lines.push('Dry run only. Re-run with --confirm to create the archive.');
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  const result = args.confirm
    ? await createRuntimeBackup(args)
    : await planRuntimeBackup(args);
  if (args.json) console.log(JSON.stringify(result, null, 2));
  else console.log(formatBackupText(result));
  process.exit(result.ok ? 0 : 1);
}
