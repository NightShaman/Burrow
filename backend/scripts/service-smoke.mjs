#!/usr/bin/env node
import { execFile } from 'node:child_process';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

function parseArgs(argv) {
  const args = { json: false, unit: process.env.BURROW_SERVICE_UNIT || 'burrow.service' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--json') args.json = true;
    else if (arg === '--unit') args.unit = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

function usage() {
  return `Usage: node scripts/service-smoke.mjs [--unit NAME] [--json]\n\nChecks systemd active/enabled state plus Burrow HTTP health.\n`;
}

async function run(command, args) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: 10_000 });
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

async function fetchHealth() {
  const url = process.env.BURROW_HEALTH_URL || 'http://127.0.0.1:42817/health';
  try {
    const response = await fetch(url);
    const body = await response.json();
    return {
      ok: response.ok && Boolean(body?.ok),
      status: response.status,
      url,
      ui: body?.ui || null,
      modelConfigured: Boolean(body?.model?.configured),
      memoryConfigured: Boolean(body?.memory?.configured),
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

const [active, enabled, status, health] = await Promise.all([
  run('systemctl', ['is-active', args.unit]),
  run('systemctl', ['is-enabled', args.unit]),
  run('systemctl', ['show', args.unit, '--property=MainPID,User,Group,ExecMainStatus,NRestarts,FragmentPath', '--no-page']),
  fetchHealth(),
]);

const ok = active.stdout === 'active' && enabled.stdout === 'enabled' && health.ok;
const output = {
  ok,
  unit: args.unit,
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
  if (health.ui) console.log(`UI: ${health.ui.host}:${health.ui.port} auth=${health.ui.authEnabled ? 'on' : 'off'}`);
  console.log(`Model: ${health.modelConfigured ? 'configured' : 'selection required'}`);
  console.log(`Memory: ${health.memoryConfigured ? 'configured' : 'missing'}`);
}

process.exit(ok ? 0 : 1);
