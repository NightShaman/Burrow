import { promises as fs } from 'node:fs';
import path from 'node:path';

const STAGING_PREFIX = '.app-staging-';
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function stagingPid(name) {
  const match = name.match(/^\.app-staging-(\d+)(?:-|$)/);
  return match ? Number(match[1]) : null;
}

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code === 'EPERM'; }
}

export async function cleanupStaleInstallStaging({ runtimeRoot, maxAgeMs = DEFAULT_MAX_AGE_MS, now = Date.now(), isProcessAlive = processExists } = {}) {
  if (!runtimeRoot) throw new Error('install_staging_cleanup_runtime_root_required');
  const removed = [];
  let entries = [];
  try { entries = await fs.readdir(runtimeRoot, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return { removed }; throw error; }
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(STAGING_PREFIX)) continue;
    const target = path.join(runtimeRoot, entry.name);
    const stat = await fs.stat(target);
    if (now - stat.mtimeMs < maxAgeMs) continue;
    const pid = stagingPid(entry.name);
    if (pid && isProcessAlive(pid)) continue;
    await fs.rm(target, { recursive: true, force: true });
    removed.push(target);
  }
  return { removed };
}

export function createInstallStagingCleanupScheduler({ runtimeRoot, intervalMs = 24 * 60 * 60 * 1000, runCleanup = cleanupStaleInstallStaging } = {}) {
  let timer = null;
  async function tick() { return runCleanup({ runtimeRoot }); }
  function start() {
    if (!timer) { timer = setInterval(() => { void tick().catch(() => {}); }, intervalMs); timer.unref?.(); }
    return tick();
  }
  function stop() { if (timer) clearInterval(timer); timer = null; }
  return { start, stop, tick };
}
