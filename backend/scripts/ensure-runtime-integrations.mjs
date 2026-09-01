#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const INTEGRATIONS = Object.freeze([
  Object.freeze({ id: 'mcporter', packageName: 'mcporter', version: '0.13.7', executable: 'mcporter' }),
  Object.freeze({ id: 'claude-code', packageName: '@anthropic-ai/claude-code', version: '2.1.232', executable: 'claude' }),
]);

function run(binary, args, { cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`integration_install_failed:${code ?? signal ?? 'unknown'}`)));
  });
}

async function installedVersion(root, packageName) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(root, 'node_modules', ...packageName.split('/'), 'package.json'), 'utf8'));
    return String(manifest.version || '');
  } catch { return ''; }
}

async function executableWorks(root, executable) {
  try {
    const entry = path.join(root, 'node_modules', '.bin', executable);
    const stat = await fs.stat(entry);
    return stat.isFile();
  } catch { return false; }
}

export async function ensureIntegration(spec, { integrationsRoot, runCommand = run, logger = console } = {}) {
  const destination = path.join(integrationsRoot, spec.id);
  if (await installedVersion(destination, spec.packageName) === spec.version && await executableWorks(destination, spec.executable)) {
    logger.log?.(`Burrow integration ${spec.id}@${spec.version} is ready.`);
    return { id: spec.id, version: spec.version, changed: false, root: destination };
  }

  await fs.mkdir(integrationsRoot, { recursive: true });
  const staging = await fs.mkdtemp(path.join(integrationsRoot, `.${spec.id}-staging-`));
  const previous = path.join(integrationsRoot, `.${spec.id}-previous`);
  try {
    logger.log?.(`Installing Burrow integration ${spec.id}@${spec.version}...`);
    const manifest = { private: true, dependencies: { [spec.packageName]: spec.version } };
    if (spec.packageName === '@anthropic-ai/claude-code') manifest.allowScripts = { [`${spec.packageName}@${spec.version}`]: true };
    await fs.writeFile(path.join(staging, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await runCommand('npm', ['install', '--omit=dev', '--no-package-lock', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: staging });
    if (await installedVersion(staging, spec.packageName) !== spec.version || !(await executableWorks(staging, spec.executable))) throw new Error(`integration_verification_failed:${spec.id}`);
    await fs.rm(previous, { recursive: true, force: true });
    const exists = await fs.stat(destination).then(() => true).catch(() => false);
    if (exists) await fs.rename(destination, previous);
    try { await fs.rename(staging, destination); }
    catch (error) {
      if (exists) await fs.rename(previous, destination).catch(() => {});
      throw error;
    }
    await fs.rm(previous, { recursive: true, force: true });
    return { id: spec.id, version: spec.version, changed: true, root: destination };
  } finally { await fs.rm(staging, { recursive: true, force: true }).catch(() => {}); }
}

export async function ensureRuntimeIntegrations({ runtimeRoot = process.env.BURROW_RUNTIME_ROOT, integrations = INTEGRATIONS, runCommand, logger = console } = {}) {
  if (!runtimeRoot) throw new Error('burrow_runtime_root_required');
  const integrationsRoot = path.join(path.resolve(runtimeRoot), 'integrations');
  const results = [];
  for (const spec of integrations) results.push(await ensureIntegration(spec, { integrationsRoot, runCommand, logger }));
  return results;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await ensureRuntimeIntegrations().catch((error) => { console.error(`Burrow integration bootstrap failed: ${String(error?.message || error)}`); process.exitCode = 1; });
}
