import { promises as fs } from 'node:fs';
import path from 'node:path';

const HOUR_MS = 60 * 60 * 1000;
const WARN_RUNS_PER_HOUR = 100;
const WARN_BYTES_PER_HOUR = 100 * 1024 * 1024;

async function directoryUsage(root) {
  let logicalBytes = 0;
  let allocatedBytes = 0;
  async function walk(filePath) {
    let stat;
    try { stat = await fs.lstat(filePath); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) return;
    if (stat.isFile()) {
      logicalBytes += stat.size;
      allocatedBytes += Number.isFinite(stat.blocks) ? stat.blocks * 512 : stat.size;
      return;
    }
    if (!stat.isDirectory()) return;
    let entries = [];
    try { entries = await fs.readdir(filePath, { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    for (const entry of entries) await walk(path.join(filePath, entry.name));
  }
  await walk(root);
  return { logicalBytes, allocatedBytes };
}

async function listTraceRuns(traceRoot) {
  const runs = [];
  async function walk(dir) {
    let entries = [];
    try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    if (entries.some((entry) => entry.isFile() && entry.name === 'events.jsonl')) {
      const stat = await fs.stat(dir);
      runs.push({ id: path.relative(traceRoot, dir) || '.', path: dir, mtimeMs: stat.mtimeMs, updatedAt: new Date(stat.mtimeMs).toISOString(), ...(await directoryUsage(dir)) });
      return;
    }
    for (const entry of entries) if (entry.isDirectory()) await walk(path.join(dir, entry.name));
  }
  await walk(traceRoot);
  return runs;
}

export function retentionStatePath(traceRoot) {
  // Keep state adjacent to, not inside, the trace tree so retention traversal
  // never mistakes it for trace data and independent roots never collide.
  return `${path.resolve(traceRoot)}.retention-state.json`;
}

export async function readTraceRetentionState(traceRoot) {
  try { return JSON.parse(await fs.readFile(retentionStatePath(traceRoot), 'utf8')); }
  catch (error) { if (error?.code === 'ENOENT') return null; return { ok: false, error: String(error?.message || error) }; }
}

export async function writeTraceRetentionState(traceRoot, result, now = new Date()) {
  const state = {
    ok: Boolean(result?.ok),
    completedAt: now.toISOString(),
    deletedTraceRuns: result?.deleted?.traces?.length || 0,
    deletedAllocatedBytes: result?.counts?.deleteTraceBytes || 0,
    retention: result?.retention || null,
  };
  const filePath = retentionStatePath(traceRoot);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return state;
}

export async function collectTraceObservability({ traceRoot, now = new Date() } = {}) {
  if (!traceRoot) throw new Error('traceRoot is required');
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const runs = await listTraceRuns(traceRoot);
  const totals = runs.reduce((result, run) => ({ allocatedBytes: result.allocatedBytes + run.allocatedBytes, logicalBytes: result.logicalBytes + run.logicalBytes }), { allocatedBytes: 0, logicalBytes: 0 });
  const recent = runs.filter((run) => run.mtimeMs >= nowMs - HOUR_MS);
  const recentBytes = recent.reduce((total, run) => total + run.allocatedBytes, 0);
  const warnings = [];
  if (recent.length > WARN_RUNS_PER_HOUR) warnings.push(`trace_rate_runs_per_hour:${recent.length}`);
  if (recentBytes > WARN_BYTES_PER_HOUR) warnings.push(`trace_rate_allocated_bytes_per_hour:${recentBytes}`);
  const ordered = [...runs].sort((a, b) => a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id));
  return {
    ok: true,
    traceRoot: path.resolve(traceRoot),
    count: runs.length,
    allocatedBytes: totals.allocatedBytes,
    logicalBytes: totals.logicalBytes,
    oldestAt: ordered[0]?.updatedAt || null,
    newestAt: ordered.at(-1)?.updatedAt || null,
    rateLastHour: { runs: recent.length, allocatedBytes: recentBytes },
    thresholds: { runsPerHour: WARN_RUNS_PER_HOUR, allocatedBytesPerHour: WARN_BYTES_PER_HOUR },
    warnings,
    retention: await readTraceRetentionState(traceRoot),
  };
}
