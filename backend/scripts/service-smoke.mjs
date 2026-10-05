#!/usr/bin/env node
import { execFile } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const args = { json: false, scope: 'user', timeoutMs: 5000, root: process.env.BURROW_RUNTIME_ROOT || path.join(process.env.HOME || '', '.burrow'), unit: process.env.BURROW_SERVICE_UNIT || 'burrow.service' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--scope') args.scope = argv[++i];
    else if (arg === '--root') args.root = argv[++i];
    else if (arg === '--timeout-ms') args.timeoutMs = Number(argv[++i]);
    else if (arg === '--unit') args.unit = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!['user', 'system'].includes(args.scope)) throw new Error('invalid service scope');
  if (!Number.isInteger(args.timeoutMs) || args.timeoutMs <= 0) throw new Error('invalid timeout');
  return args;
}

function usage() {
  return `Usage: node scripts/service-smoke.mjs [--unit NAME] [--scope user|system] [--root DIR] [--timeout-ms N] [--json]\n\nChecks systemd active/enabled state plus Burrow HTTP health.\n`;
}

async function run(command, commandArgs) {
  try {
    const { stdout, stderr } = await execFileAsync(command, commandArgs, { timeout: args.timeoutMs, env: managerEnv });
    return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      code: error.code ?? null,
      stdout: String(error.stdout || '').trim(),
      stderr: String(error.stderr || error.message || '').trim(),
    };
  }
}

async function fetchHealth(timeoutMs) {
  const url = process.env.BURROW_HEALTH_URL || 'http://127.0.0.1:42817/health';
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const body = await response.json();
    return {
      ok: response.ok && Boolean(body?.ok),
      status: response.status,
      url,
      ui: body?.ui || null,
      modelConfigured: (typeof body?.model?.configured === 'boolean' ? body?.model?.configured : null),
      memoryConfigured: (typeof body?.memory?.configured === 'boolean' ? body?.memory?.configured : null),
    };
  } catch (error) {
    return { ok: false, url, error: String(error?.message || error) };
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(usage());
  process.exit(0);
}

const managerEnv = { ...process.env };
if (args.scope === 'user' && !managerEnv.XDG_RUNTIME_DIR) {
  const candidate = `/run/user/${process.getuid()}`;
  if (existsSync(candidate)) managerEnv.XDG_RUNTIME_DIR = candidate;
}
const managerArgs = args.scope === 'user' ? ['--user'] : [];
const [active, enabled, status, health] = await Promise.all([
  run('systemctl', [...managerArgs, 'is-active', args.unit]),
  run('systemctl', [...managerArgs, 'is-enabled', args.unit]),
  run('systemctl', [...managerArgs, 'show', args.unit, '--property=Id,EnvironmentFiles,ExecStart,MainPID,User,Group,ExecMainStatus,NRestarts,FragmentPath', '--no-page']),
  fetchHealth(args.timeoutMs),
]);

const properties = Object.fromEntries(status.stdout.split('\n').map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)]; }));
const root = path.resolve(args.root);
const identityOk = status.ok && properties.Id === args.unit &&
  (properties.EnvironmentFiles || '').includes(`${root}/burrow.env `) &&
  (properties.ExecStart || '').includes(`path=${root}/bin/burrow ;`);
const ok = identityOk && active.ok && enabled.ok && active.stdout === 'active' && enabled.stdout === 'enabled' && health.ok;
const output = {
  ok,
  unit: args.unit,
  scope: args.scope,
  runtimeRoot: root,
  identityOk,
  active: active.stdout || active.stderr,
  enabled: enabled.stdout || enabled.stderr,
  status: status.stdout,
  health,
};

if (args.json) {
  console.log(JSON.stringify(output, null, 2));
} else {
  console.log(`Burrow service smoke: ${ok ? 'ok' : 'failed'}`);
  console.log(`Unit: ${args.unit}`);
  console.log(`Active: ${output.active}`);
  console.log(`Enabled: ${output.enabled}`);
  console.log(`Health: ${health.ok ? 'ok' : 'failed'} ${health.url}`);
  if (health.ui) console.log(`UI: ${health.ui.host}:${health.ui.port} auth=${typeof health.ui.authEnabled !== 'boolean' ? 'unknown' : health.ui.authEnabled ? 'on' : 'off'}`);
  console.log(`Model: ${health.modelConfigured === null ? 'unknown' : health.modelConfigured ? 'configured' : 'selection required'}`);
  console.log(`Memory: ${health.memoryConfigured === null ? 'unknown' : health.memoryConfigured ? 'configured' : 'missing'}`);
}

process.exit(ok ? 0 : 1);
