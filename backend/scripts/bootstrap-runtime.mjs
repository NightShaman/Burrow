#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { installReleasePackage } from './install-release-package.mjs';
import { ensureDefaultGlobalWorkspace } from '../src/runtime-workspace-defaults.mjs';
import { fileURLToPath } from 'node:url';

const RUNTIME_DIRECTORIES = Object.freeze(['config', 'workspace', path.join('workspace', 'global'), path.join('workspace', 'global', 'skills'), path.join('workspace', 'global', 'tools'), 'agentdata', 'cache', 'reports', 'integrations', 'deployments', 'packages']);

export function parseArgs(argv = []) {
  const args = { apply: false, json: false, generateSettingsKey: null, forceEnv: false, host: null, port: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--dir' || arg === '--install-dir') args.installDir = argv[++index];
    else if (arg === '--package' || arg === '--archive') args.packagePath = argv[++index];
    else if (arg === '--checksum') args.checksumPath = argv[++index];
    else if (arg === '--generate-settings-key') args.generateSettingsKey = true;
    else if (arg === '--no-generate-settings-key') args.generateSettingsKey = false;
    else if (arg === '--host') args.host = argv[++index];
    else if (arg === '--port') args.port = Number(argv[++index]);
    else if (arg === '--force-env') args.forceEnv = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

export function usage() {
  return `Usage: node scripts/bootstrap-runtime.mjs --dir DIR [--apply] [--json] [--package FILE.tar.gz] [--host HOST] [--port PORT]\n\nSingle-directory bootstrapper. Everything Burrow owns lives under DIR. Default previews only. --apply creates runtime subdirectories and DIR/burrow.env when absent. Fresh applied bootstraps generate BURROW_SETTINGS_KEY by default unless --no-generate-settings-key is passed. With --package, the package installer copies app files into the same DIR.\n`;
}

async function exists(filePath) { try { await fs.access(filePath); return true; } catch { return false; } }

function normalizePort(value, fallback = 42817) {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('bootstrap_port_invalid');
  return port;
}

function normalizeHost(value, fallback = '0.0.0.0') {
  const host = String(value || fallback).trim();
  if (!host) throw new Error('bootstrap_host_invalid');
  return host;
}

function envTemplate({ installDir, generateSettingsKey, host = '0.0.0.0', port = 42817 }) {
  const key = generateSettingsKey ? randomBytes(32).toString('base64') : '';
  return `# Burrow single-directory runtime environment.\nBURROW_SOURCE_ROOT=${installDir}\nBURROW_RUNTIME_ROOT=${installDir}\nBURROW_WORKSPACE_ROOT=${installDir}/workspace\nBURROW_CACHE_ROOT=${installDir}/cache\nBURROW_SETTINGS_DB=${installDir}/config/settings.sqlite\nBURROW_UI_HOST=${host}\nBURROW_UI_PORT=${port}\n# Base64-encoded 32-byte SQLite encryption key.\nBURROW_SETTINGS_KEY=${key}\n`;
}

export async function bootstrapRuntime(args = {}) {
  if (!args.installDir && !args.dir) throw new Error('install_dir_required');
  const installDir = path.resolve(args.installDir || args.dir);
  const envPath = path.join(installDir, 'burrow.env');
  const envExists = await exists(envPath);
  const host = normalizeHost(args.host);
  const port = normalizePort(args.port);
  const generateSettingsKey = args.generateSettingsKey === null || args.generateSettingsKey === undefined ? Boolean(args.apply && !envExists) : Boolean(args.generateSettingsKey);
  const startedAt = new Date().toISOString();
  const report = { ok: false, applied: false, installDir, envPath, startedAt, completedAt: null, durationMs: null, stages: [], planned: [], warnings: [], options: { apply: Boolean(args.apply), packagePath: args.packagePath || null, generateSettingsKey, forceEnv: Boolean(args.forceEnv), host, port } };
  const finish = (ok) => {
    report.ok = ok;
    report.completedAt = new Date().toISOString();
    report.durationMs = Date.parse(report.completedAt) - Date.parse(report.startedAt);
    return report;
  };
  try {
    report.planned.push({ action: 'mkdir', path: installDir });
    for (const dir of RUNTIME_DIRECTORIES) report.planned.push({ action: 'mkdir', path: path.join(installDir, dir) });
    report.planned.push({ action: envExists && !args.forceEnv ? 'preserve-env' : 'write-env', path: envPath, mode: '0600', host, port });
    if (!generateSettingsKey && !(envExists && !args.forceEnv)) report.warnings.push('settings_key_not_generated:set BURROW_SETTINGS_KEY before first real start, or rerun with --generate-settings-key');
    if (envExists && !args.forceEnv && (args.host || args.port || args.generateSettingsKey !== null)) report.warnings.push(`env_preserved:requested env options were not written; edit ${envPath} or rerun with --force-env`);
    if (!args.apply) return finish(true);

    await fs.mkdir(installDir, { recursive: true });
    for (const dir of RUNTIME_DIRECTORIES) await fs.mkdir(path.join(installDir, dir), { recursive: true });
    report.globalWorkspace = await ensureDefaultGlobalWorkspace({ installDir, defaultsRoot: path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'global-skills') });
    if (await exists(envPath) && !args.forceEnv) report.stages.push('env-preserved');
    else { await fs.writeFile(envPath, envTemplate({ installDir, generateSettingsKey, host, port }), { mode: 0o600 }); report.stages.push('env-written'); }
    report.stages.unshift('global-workspace');
    report.stages.unshift('runtime-directories');

    if (args.packagePath) {
      report.packageInstall = await installReleasePackage({ installDir, packagePath: args.packagePath, checksumPath: args.checksumPath, apply: true, forceEnv: false, generateSettingsKey: false, host, port });
      report.stages.push('package-installed');
    }
    report.applied = true;
    return finish(true);
  } catch (error) {
    report.error = String(error?.message || error);
    finish(false);
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { report });
  }
}

function format(result) {
  return [
    `Burrow runtime bootstrap: ${result.ok ? 'ok' : 'failed'}`,
    `Mode: ${result.applied ? 'applied' : 'preview'}`,
    `Install dir: ${result.installDir}`,
    result.stages.length ? `Stages: ${result.stages.join(', ')}` : `Planned: ${result.planned.length} actions`,
    result.warnings.length ? `Warnings: ${result.warnings.join('; ')}` : null,
  ].filter(Boolean).join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); process.exit(0); }
  try {
    const result = await bootstrapRuntime(args);
    console.log(args.json ? JSON.stringify(result, null, 2) : format(result));
  } catch (error) {
    const output = error.report || { ok: false, error: String(error?.message || error) };
    if (args.json) console.error(JSON.stringify(output, null, 2));
    else console.error(`Burrow runtime bootstrap: failed (${output.error || error.message})`);
    process.exitCode = 1;
  }
}
