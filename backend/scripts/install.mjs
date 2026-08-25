#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { ensureDefaultGlobalWorkspace } from '../src/runtime-workspace-defaults.mjs';

const execFileAsync = promisify(execFile);
const DEFAULT_PORT = 42817;
const APP_DIRECTORIES = Object.freeze(['bin', 'deploy', 'docs', 'global-skills', 'public', 'scripts', 'src']);
const APP_FILES = Object.freeze(['package.json', 'package-lock.json', 'README.md', 'RUNTIME_LAWS.md']);
const RUNTIME_DIRECTORIES = Object.freeze(['config', 'workspace', 'agentdata', 'cache', 'reports', 'integrations']);
const RUNTIME_INTEGRATIONS = Object.freeze([
  { directory: 'mcporter', packageName: 'mcporter', packageVersion: '0.13.7' },
  { directory: 'claude-code', packageName: '@anthropic-ai/claude-code', packageVersion: '2.1.232' },
]);

async function exists(filePath) { try { await fs.access(filePath); return true; } catch { return false; } }

export function parseArgs(argv = []) {
  const args = { mode: null, host: '0.0.0.0', port: DEFAULT_PORT, service: 'user', installDependencies: true, start: true, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--headless') args.mode = 'headless';
    else if (arg === '--ui') args.mode = 'ui';
    else if (arg === '--dir' || arg === '--install-dir') args.installDir = argv[++index];
    else if (arg === '--source-dir') args.sourceDir = argv[++index];
    else if (arg === '--ui-dist') args.uiDist = argv[++index];
    else if (arg === '--host') args.host = argv[++index];
    else if (arg === '--port') args.port = Number(argv[++index]);
    else if (arg === '--service') args.service = argv[++index];
    else if (arg === '--service-user') args.serviceUser = argv[++index];
    else if (arg === '--no-service') args.service = 'none';
    else if (arg === '--no-start') args.start = false;
    else if (arg === '--no-install-dependencies') args.installDependencies = false;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

export function usage() {
  return `Usage: ./install.sh (--headless | --ui --ui-dist DIR) --dir DIR [options]\n\nInstalls or updates one native Burrow installation without release rings or Docker.\n\nModes:\n  --headless              Install the complete runtime and API without web UI assets\n  --ui --ui-dist DIR      Install the runtime/API and an already-built Burrow UI dist\n\nOptions:\n  --dir DIR               Installation root (required); app goes in DIR/app, state stays in DIR\n  --source-dir DIR        Burrow source checkout (defaults to the checkout containing this script)\n  --host HOST             Listener host (default: 0.0.0.0)\n  --port PORT             Listener port (default: 42817)\n  --service user|system|none\n                           Install a user service (default), system service, or no service\n  --service-user USER     Account for --service system (defaults to SUDO_USER/current user)\n  --no-start              Install the service but do not enable/start it\n  --no-install-dependencies\n                           Skip npm ci; intended for development/testing only\n  --json                   Print the result as JSON\n`;
}

function validate(args) {
  if (!['headless', 'ui'].includes(args.mode)) throw new Error('install_mode_required: pass --headless or --ui');
  if (!args.installDir) throw new Error('install_dir_required');
  if (args.mode === 'ui' && !args.uiDist) throw new Error('ui_dist_required');
  if (!['user', 'system', 'none'].includes(args.service)) throw new Error('install_service_invalid');
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error('install_port_invalid');
  if (!String(args.host || '').trim()) throw new Error('install_host_invalid');
  if (args.serviceUser && !/^[a-z_][a-z0-9_-]*[$]?$/i.test(args.serviceUser)) throw new Error('install_service_user_invalid');
}

async function copyTree(source, destination) {
  const entries = await fs.readdir(source, { withFileTypes: true });
  await fs.mkdir(destination, { recursive: true });
  for (const entry of entries) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`install_source_symlink_forbidden:${from}`);
    if (entry.isDirectory()) await copyTree(from, to);
    else if (entry.isFile()) await fs.copyFile(from, to);
    else throw new Error(`install_source_entry_unsupported:${from}`);
  }
}

async function copyApplication(sourceDir, stagingDir) {
  await fs.mkdir(stagingDir, { recursive: true });
  for (const directory of APP_DIRECTORIES) {
    const source = path.join(sourceDir, directory);
    if (!(await exists(source))) throw new Error(`install_source_missing:${directory}`);
    await copyTree(source, path.join(stagingDir, directory));
  }
  for (const file of APP_FILES) {
    const source = path.join(sourceDir, file);
    if (await exists(source)) await fs.copyFile(source, path.join(stagingDir, file));
  }
}

async function readEnv(filePath) {
  const values = {};
  const text = await fs.readFile(filePath, 'utf8').catch(() => '');
  for (const line of text.split('\n')) {
    if (!line || line.trimStart().startsWith('#')) continue;
    const split = line.indexOf('=');
    if (split > 0) values[line.slice(0, split)] = line.slice(split + 1);
  }
  return values;
}

async function resolveSettingsKey({ installDir, envPath }) {
  const existingEnv = await readEnv(envPath);
  const keyFile = path.join(installDir, 'config', 'settings.key');
  const candidates = [
    existingEnv.BURROW_SETTINGS_KEY,
    existingEnv.HATCHETCLAW_SETTINGS_KEY,
    (await fs.readFile(keyFile, 'utf8').catch(() => '')).trim(),
  ].filter(Boolean);
  const distinct = [...new Set(candidates)];
  if (distinct.length > 1) throw new Error('settings_key_mismatch');
  if (distinct.length === 1) return distinct[0];
  if (await exists(path.join(installDir, 'config', 'settings.sqlite'))) throw new Error('settings_key_missing_for_existing_database');
  return randomBytes(32).toString('base64');
}

function envText({ installDir, appDir, key, host, port }) {
  return `# Burrow native runtime environment. Keep this file private.\nBURROW_SOURCE_ROOT=${appDir}\nBURROW_RUNTIME_ROOT=${installDir}\nBURROW_CLAUDE_BIN=${installDir}/integrations/claude-code/node_modules/.bin/claude\nBURROW_UI_HOST=${host}\nBURROW_UI_PORT=${port}\nBURROW_SETTINGS_KEY=${key}\n`;
}

async function provisionRuntimeIntegrations({ appDir, stagingDir }) {
  const manifest = JSON.parse(await fs.readFile(path.join(appDir, 'package.json'), 'utf8'));
  const packages = { ...(manifest.dependencies || {}), ...(manifest.devDependencies || {}) };
  const stagedRoot = path.join(stagingDir, '.runtime-integrations');
  const results = [];
  for (const integration of RUNTIME_INTEGRATIONS) {
    if (!packages[integration.packageName]) throw new Error(`install_integration_package_missing:${integration.packageName}`);
    const staged = path.join(stagedRoot, integration.directory);
    await fs.mkdir(staged, { recursive: true, mode: 0o755 });
    const packageManifest = { private: true, dependencies: { [integration.packageName]: integration.packageVersion } };
    // npm 11 requires an explicit approval for install scripts. Only Claude's
    // pinned postinstall is approved; no broad allow-scripts policy is emitted.
    if (integration.packageName === '@anthropic-ai/claude-code') packageManifest.allowScripts = { [`${integration.packageName}@${integration.packageVersion}`]: true };
    await fs.writeFile(path.join(staged, 'package.json'), `${JSON.stringify(packageManifest, null, 2)}\n`, { mode: 0o644 });
    await execFileAsync('npm', ['install', '--omit=dev', '--no-package-lock', '--ignore-scripts=false'], { cwd: staged, timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
    if (integration.packageName === '@anthropic-ai/claude-code') await execFileAsync(path.join(staged, 'node_modules', '.bin', 'claude'), ['--version'], { timeout: 60_000, maxBuffer: 1024 * 1024 });
    results.push({ ...integration, staged });
  }
  return results;
}

async function activateRuntimeIntegrations({ installDir, integrations }) {
  for (const integration of integrations) {
    const target = path.join(installDir, 'integrations', integration.directory);
    await fs.mkdir(target, { recursive: true, mode: 0o755 });
    await fs.rm(path.join(target, 'node_modules'), { recursive: true, force: true });
    await fs.rename(path.join(integration.staged, 'node_modules'), path.join(target, 'node_modules'));
    await fs.copyFile(path.join(integration.staged, 'package.json'), path.join(target, 'package.json'));
  }
}

export const runtimeIntegrations = RUNTIME_INTEGRATIONS;

export function serviceUnit({ installDir, appDir, serviceUser = null, system = false }) {
  const userLines = system ? `User=${serviceUser}\nGroup=${serviceUser}\n` : '';
  return `[Unit]\nDescription=Burrow runtime\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nType=simple\n${userLines}WorkingDirectory=${appDir}\nEnvironment=NODE_ENV=production\nEnvironmentFile=${path.join(installDir, 'burrow.env')}\nExecStart=/usr/bin/env node ${path.join(appDir, 'bin', 'burrow.mjs')} serve --root ${appDir}\nRestart=on-failure\nRestartSec=3\nKillSignal=SIGTERM\nTimeoutStopSec=20\n\n[Install]\nWantedBy=${system ? 'multi-user.target' : 'default.target'}\n`;
}

async function installService({ type, installDir, appDir, serviceUser, start }) {
  if (type === 'none') return { type, installed: false, started: false };
  const system = type === 'system';
  if (system && process.getuid?.() !== 0) throw new Error('system_service_requires_root');
  const unit = serviceUnit({ installDir, appDir, serviceUser, system });
  const unitPath = system
    ? '/etc/systemd/system/burrow.service'
    : path.join(os.homedir(), '.config', 'systemd', 'user', 'burrow.service');
  await fs.mkdir(path.dirname(unitPath), { recursive: true });
  await fs.writeFile(unitPath, unit, { mode: 0o644 });
  const base = system ? ['systemctl'] : ['systemctl', '--user'];
  await execFileAsync(base[0], [...base.slice(1), 'daemon-reload']);
  if (start) await execFileAsync(base[0], [...base.slice(1), 'enable', '--now', 'burrow.service'], { timeout: 30_000 });
  return { type, installed: true, started: start, unitPath };
}

export async function installBurrow(input = {}) {
  const scriptSource = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const args = { mode: null, host: '0.0.0.0', port: DEFAULT_PORT, service: 'user', installDependencies: true, start: true, ...input };
  validate(args);
  const installDir = path.resolve(args.installDir);
  const sourceDir = path.resolve(args.sourceDir || scriptSource);
  const appDir = path.join(installDir, 'app');
  const stagingDir = path.join(installDir, `.app-staging-${process.pid}-${Date.now()}`);
  const previousDir = path.join(installDir, '.app-previous');
  const envPath = path.join(installDir, 'burrow.env');
  const uiDist = args.uiDist ? path.resolve(args.uiDist) : null;
  if (args.mode === 'ui' && !(await exists(path.join(uiDist, 'index.html')))) throw new Error('ui_dist_index_missing');

  await fs.mkdir(installDir, { recursive: true });
  for (const directory of RUNTIME_DIRECTORIES) await fs.mkdir(path.join(installDir, directory), { recursive: true });
  try {
    await copyApplication(sourceDir, stagingDir);
    await fs.rm(path.join(stagingDir, 'public', 'ui'), { recursive: true, force: true });
    if (args.mode === 'ui') await copyTree(uiDist, path.join(stagingDir, 'public', 'ui'));
    const runtimeIntegrations = args.installDependencies
      ? await provisionRuntimeIntegrations({ appDir: stagingDir, stagingDir })
      : [];
    if (args.installDependencies) {
      await execFileAsync('npm', ['ci', '--omit=dev'], { cwd: stagingDir, timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
      await execFileAsync('node', ['-e', "import('node-llama-cpp')"], { cwd: stagingDir, timeout: 60_000, maxBuffer: 1024 * 1024 });
    }

    const key = await resolveSettingsKey({ installDir, envPath });
    await fs.writeFile(envPath, envText({ installDir, appDir, key, host: args.host, port: args.port }), { mode: 0o600 });
    await fs.chmod(envPath, 0o600);
    await ensureDefaultGlobalWorkspace({ installDir, defaultsRoot: path.join(stagingDir, 'global-skills') });

    await fs.rm(previousDir, { recursive: true, force: true });
    if (await exists(appDir)) await fs.rename(appDir, previousDir);
    try { await fs.rename(stagingDir, appDir); }
    catch (error) {
      if (await exists(previousDir)) await fs.rename(previousDir, appDir);
      throw error;
    }
    await activateRuntimeIntegrations({ installDir, integrations: runtimeIntegrations });
    const serviceUser = args.serviceUser || process.env.SUDO_USER || os.userInfo().username;
    const service = await installService({ type: args.service, installDir, appDir, serviceUser, start: args.start });
    await fs.rm(previousDir, { recursive: true, force: true });
    return { ok: true, mode: args.mode, installDir, appDir, envPath, uiInstalled: args.mode === 'ui', host: args.host, port: args.port, service };
  } catch (error) {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function format(result) {
  return [
    `Burrow install: ok`,
    `Mode: ${result.mode}`,
    `Application: ${result.appDir}`,
    `State: ${result.installDir}`,
    `Listener: http://${result.host}:${result.port}`,
    result.service.installed ? `Service: ${result.service.type} (${result.service.started ? 'started' : 'installed, not started'})` : 'Service: not installed',
  ].join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) { console.log(usage()); process.exit(0); }
  try {
    const result = await installBurrow(args);
    console.log(args.json ? JSON.stringify(result, null, 2) : format(result));
  } catch (error) {
    const result = { ok: false, error: String(error?.message || error) };
    if (args.json) console.error(JSON.stringify(result, null, 2));
    else console.error(`Burrow install: failed (${result.error})`);
    process.exitCode = 1;
  }
}
