#!/usr/bin/env node
import { execFile } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export function parseArgs(argv = []) {
  const args = { root: process.cwd(), json: false, unit: process.env.BURROW_SERVICE_UNIT || 'burrow.service' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--root') args.root = argv[++i];
    else if (arg === '--json') args.json = true;
    else if (arg === '--unit') args.unit = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  return args;
}

export function usage() {
  return `Usage: node scripts/operational-audit.mjs [--root DIR] [--unit NAME] [--json]\n\nRuns the Phase I operational audit: doctor, service smoke, git cleanliness, and retention dry-run.\n`;
}

export async function runCommand(command, args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(command, args, { timeout: options.timeout ?? 30_000, cwd: options.cwd });
    return { ok: true, exitCode: 0, stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (error) {
    return {
      ok: false,
      exitCode: error.code ?? 1,
      stdout: String(error.stdout || '').trim(),
      stderr: String(error.stderr || error.message || '').trim(),
    };
  }
}

function parseJsonResult(result) {
  if (!result.ok || !result.stdout) return null;
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

export function summarizeGitStatus(stdout = '') {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  return {
    ok: lines.length === 0,
    dirty: lines.length > 0,
    count: lines.length,
    entries: lines.slice(0, 25),
    truncated: lines.length > 25,
  };
}

export function summarizeRetention(body) {
  const counts = body?.counts || body?.plan?.counts || {};
  return {
    ok: Boolean(body?.ok),
    dryRun: body?.dryRun ?? (body?.confirm === false) ?? true,
    counts,
  };
}

export async function runOperationalAudit({ root = process.cwd(), unit = 'burrow.service', runCommand: runner = runCommand } = {}) {
  const resolvedRoot = path.resolve(root);
  const bin = path.join(resolvedRoot, 'bin', 'burrow.mjs');
  const serviceSmoke = path.join(resolvedRoot, 'scripts', 'service-smoke.mjs');

  const [doctorRun, serviceRun, gitRun, retentionRun] = await Promise.all([
    runner('node', [bin, 'doctor', '--root', resolvedRoot, '--check-memory', '--json'], { cwd: resolvedRoot, timeout: 60_000 }),
    runner('node', [serviceSmoke, '--unit', unit, '--json'], { cwd: resolvedRoot, timeout: 30_000 }),
    runner('git', ['-C', resolvedRoot, 'status', '--porcelain=v1'], { cwd: resolvedRoot, timeout: 10_000 }),
    runner('node', [bin, 'retention', '--root', resolvedRoot, '--json', '--summary'], { cwd: resolvedRoot, timeout: 30_000 }),
  ]);

  const doctor = parseJsonResult(doctorRun);
  const service = parseJsonResult(serviceRun);
  const retention = parseJsonResult(retentionRun);
  const git = summarizeGitStatus(gitRun.stdout);

  const checks = {
    doctor: { ok: Boolean(doctor?.ok), status: doctor?.status || null, blockers: doctor?.blockers || [], warnings: doctor?.warnings || [] },
    service: { ok: Boolean(service?.ok), active: service?.active || null, enabled: service?.enabled || null, health: service?.health || null },
    git,
    retention: summarizeRetention(retention),
  };

  const blockers = [];
  if (!checks.doctor.ok) blockers.push('doctor_failed');
  if (!checks.service.ok) blockers.push('service_smoke_failed');
  if (!checks.git.ok) blockers.push('git_dirty');
  if (!checks.retention.ok) blockers.push('retention_dry_run_failed');

  return {
    ok: blockers.length === 0,
    root: resolvedRoot,
    unit,
    blockers,
    checks,
  };
}

export function formatAuditText(audit) {
  const lines = [];
  lines.push(`Burrow operational audit: ${audit.ok ? 'ok' : 'failed'}`);
  if (audit.blockers.length) lines.push(`Blockers: ${audit.blockers.join(', ')}`);
  lines.push(`Doctor: ${audit.checks.doctor.ok ? 'ok' : 'failed'}${audit.checks.doctor.status ? ` (${audit.checks.doctor.status})` : ''}`);
  lines.push(`Service: ${audit.checks.service.ok ? 'ok' : 'failed'} active=${audit.checks.service.active || '?'} enabled=${audit.checks.service.enabled || '?'}`);
  lines.push(`Git: ${audit.checks.git.ok ? 'clean' : `dirty (${audit.checks.git.count})`}`);
  lines.push(`Retention dry-run: ${audit.checks.retention.ok ? 'ok' : 'failed'}`);
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    process.exit(0);
  }
  const audit = await runOperationalAudit(args);
  if (args.json) console.log(JSON.stringify(audit, null, 2));
  else console.log(formatAuditText(audit));
  process.exit(audit.ok ? 0 : 1);
}
