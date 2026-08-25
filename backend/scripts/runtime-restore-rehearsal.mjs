#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRuntimeBackup } from './runtime-backup.mjs';
import { AgentRegistryStore } from '../src/agent-registry.mjs';
import { McpSettingsStore } from '../src/mcp-settings-store.mjs';
import { getSettingsMeta, openSettingsDatabase, setSettingsMeta } from '../src/settings-database.mjs';
import { appendSessionTurn, readSessionTurns } from '../src/session-store.mjs';

const execFileAsync = promisify(execFile);

export function parseArgs(argv = []) {
  const args = { json: false, keep: false, workDir: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--keep') args.keep = true;
    else if (arg === '--work-dir') args.workDir = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

export function usage() {
  return 'Usage: node scripts/runtime-restore-rehearsal.mjs [--json] [--keep] [--work-dir DIR]\n\nRuns the real runtime backup planner against an isolated fixture, restores its archive, and validates continuity plus authoritative SQLite state.\n';
}

async function exists(filePath) { try { await fs.access(filePath); return true; } catch { return false; } }

async function writeRuntimeFixture({ sourceRoot, agentWorkspaceRoot, databasePath, key }) {
  await appendSessionTurn({ rootDir: agentWorkspaceRoot, sessionId: 'session-a', role: 'user', content: 'restore rehearsal continuity' });
  const agents = new AgentRegistryStore({ databasePath, bootstrapSampleIdentities: false });
  try { agents.create({ id: 'rehearsal', name: 'Rehearsal', enabled: true }); } finally { agents.close(); }
  const db = openSettingsDatabase({ databasePath });
  try { setSettingsMeta(db, 'restore_rehearsal_marker', { value: 'present' }); } finally { db.close(); }
  const mcp = new McpSettingsStore({ databasePath, key });
  try { mcp.save({ id: 'rehearsal-secret', name: 'Rehearsal secret', transport: 'stdio', command: 'echo', args: [], apiKey: 'rehearsal-encrypted-value' }); } finally { mcp.close(); }
  await fs.mkdir(path.join(agentWorkspaceRoot, 'artifacts', 'attachments', 'session-a'), { recursive: true });
  await fs.writeFile(path.join(agentWorkspaceRoot, 'artifacts', 'attachments', 'session-a', 'rehearsal.txt'), 'restore rehearsal attachment');
  await fs.mkdir(path.join(sourceRoot, 'src'), { recursive: true });
  await fs.writeFile(path.join(sourceRoot, 'src', 'not-runtime.mjs'), 'should not restore\n');
}

export async function runRestoreRehearsal({ workDir = null, keep = false, runTar = execFileAsync } = {}) {
  const baseDir = workDir ? path.resolve(workDir) : await fs.mkdtemp(path.join(os.tmpdir(), 'burrow-restore-rehearsal-'));
  const sourceRoot = path.join(baseDir, 'source-runtime');
  const dataRoot = path.join(sourceRoot, 'agentdata');
  const workspaceRoot = path.join(sourceRoot, 'workspace');
  const agentWorkspaceRoot = path.join(workspaceRoot, 'rehearsal');
  const databasePath = path.join(sourceRoot, 'config', 'settings.sqlite');
  const restoreRoot = path.join(baseDir, 'restored-runtime');
  const archive = path.join(baseDir, 'burrow-runtime-rehearsal.tar.gz');
  const key = randomBytes(32);

  try {
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.mkdir(restoreRoot, { recursive: true });
    await writeRuntimeFixture({ sourceRoot, agentWorkspaceRoot, databasePath, key });
    const backup = await createRuntimeBackup({ root: sourceRoot, dataRoot, workspaceRoot, settingsDatabasePath: databasePath, output: archive, runTar });
    if (!backup.created) throw new Error(`restore_rehearsal_backup_failed:${backup.error || 'unknown'}`);
    await runTar('tar', ['-xzf', archive, '-C', restoreRoot], { timeout: 120_000 });
    const restoredAgentWorkspaceRoot = path.join(restoreRoot, 'workspaces', 'rehearsal');
    const restoredDatabasePath = path.join(restoreRoot, 'config', 'settings.sqlite');
    const restoredDb = openSettingsDatabase({ databasePath: restoredDatabasePath });
    let marker;
    try { marker = getSettingsMeta(restoredDb, 'restore_rehearsal_marker'); } finally { restoredDb.close(); }
    const restoredAgents = new AgentRegistryStore({ databasePath: restoredDatabasePath, bootstrapSampleIdentities: false });
    let agent;
    try { agent = restoredAgents.get('rehearsal'); } finally { restoredAgents.close(); }
    const restoredMcp = new McpSettingsStore({ databasePath: restoredDatabasePath, key });
    let apiKey;
    try { apiKey = restoredMcp.apiKey('rehearsal-secret'); } finally { restoredMcp.close(); }
    const turns = await readSessionTurns({ rootDir: restoredAgentWorkspaceRoot, sessionId: 'session-a', limit: 0 });
    const checks = {
      archive: await exists(archive),
      settingsDatabase: await exists(restoredDatabasePath),
      settingsMeta: marker?.value === 'present',
      agent: agent?.name === 'Rehearsal',
      encryptedRecord: apiKey === 'rehearsal-encrypted-value',
      session: turns.some((turn) => turn.content === 'restore rehearsal continuity'),
      attachment: await exists(path.join(restoredAgentWorkspaceRoot, 'artifacts', 'attachments', 'session-a', 'rehearsal.txt')),
      excludesSource: !(await exists(path.join(restoreRoot, 'src', 'not-runtime.mjs'))),
    };
    return { ok: Object.values(checks).every(Boolean), liveRuntimeTouched: false, kept: keep, baseDir, sourceRoot, restoreRoot, archive, included: [...backup.included.map((entry) => entry.path), ...backup.workspaceEntries.map((entry) => entry.archivePath), 'config/settings.sqlite'], checks };
  } finally {
    if (!keep && !workDir) await fs.rm(baseDir, { recursive: true, force: true });
  }
}

export function formatRehearsalText(result) {
  const lines = [];
  lines.push(`Burrow restore rehearsal: ${result.ok ? 'ok' : 'failed'}`);
  lines.push(`Live runtime touched: ${result.liveRuntimeTouched ? 'yes' : 'no'}`);
  lines.push(`Included: ${result.included.join(', ')}`);
  lines.push(`Checks: ${Object.entries(result.checks).map(([key, value]) => `${key}=${value ? 'ok' : 'failed'}`).join(' ')}`);
  if (result.kept) lines.push(`Kept temp data: ${result.baseDir}`);
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); process.exit(0); }
  const result = await runRestoreRehearsal({ workDir: args.workDir, keep: args.keep });
  if (args.json) console.log(JSON.stringify(result, null, 2)); else console.log(formatRehearsalText(result));
  process.exit(result.ok ? 0 : 1);
}
