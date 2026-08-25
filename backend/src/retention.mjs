import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { writeTraceRetentionState } from './trace-observability.mjs';
import { listSessionRecords, readSessionMetadata } from './session-store.mjs';
import { TaskBoardStore } from './task-board-store.mjs';

function finitePositive(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// `main` is the historical session id; normal chat commonly uses `default`.
// Treat both as the active main session unless explicit metadata says otherwise,
// and preserve the metadata flags for migrated/custom session stores.
function isCurrentMain(recordOrMetadata, sessionId = null) {
  const metadata = recordOrMetadata?.metadata || recordOrMetadata || {};
  const id = recordOrMetadata?.id || sessionId;
  return metadata.current === true || metadata.currentMain === true
    || ((id === 'main' || id === 'default') && (!metadata.kind || metadata.kind === 'main'));
}

async function directoryUsage(root) {
  let logicalBytes = 0;
  let allocatedBytes = 0;
  async function walk(filePath) {
    let stat;
    try { stat = await fs.lstat(filePath); } catch (error) { if (error?.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) return;
    logicalBytes += stat.isFile() ? stat.size : 0;
    allocatedBytes += Number.isFinite(stat.blocks) ? stat.blocks * 512 : stat.isFile() ? stat.size : 0;
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
  return runs.sort((a, b) => b.mtimeMs - a.mtimeMs || a.id.localeCompare(b.id));
}

function ageCutoffMs(maxAgeDays, nowMs) {
  if (!Number.isFinite(nowMs)) throw new Error('retention_now_invalid');
  const days = finitePositive(maxAgeDays);
  return days ? nowMs - days * 24 * 60 * 60 * 1000 : null;
}

function isContainedPath(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

async function validatedTraceRunPath(traceRoot, candidate) {
  if (!isContainedPath(traceRoot, candidate)) throw new Error('retention_trace_path_outside_root');
  const stat = await fs.lstat(candidate);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('retention_trace_path_invalid');
  const events = await fs.lstat(path.join(candidate, 'events.jsonl'));
  if (!events.isFile() || events.isSymbolicLink()) throw new Error('retention_trace_signature_invalid');
}

function traceCandidates(runs, { maxAgeDays = null, maxBytes = null, nowMs = Date.now() } = {}) {
  const cutoff = ageCutoffMs(maxAgeDays, nowMs);
  const selected = new Map();
  for (const run of runs) {
    if (cutoff && run.mtimeMs < cutoff) selected.set(run.path, { ...run, reasons: ['age'] });
  }
  const quota = finitePositive(maxBytes);
  if (quota) {
    let retainedBytes = runs.filter((run) => !selected.has(run.path)).reduce((total, run) => total + run.allocatedBytes, 0);
    for (const run of [...runs].reverse()) {
      if (retainedBytes <= quota) break;
      if (selected.has(run.path)) continue;
      selected.set(run.path, { ...run, reasons: ['quota'] });
      retainedBytes -= run.allocatedBytes;
    }
  }
  return [...selected.values()].sort((a, b) => a.mtimeMs - b.mtimeMs || a.id.localeCompare(b.id));
}

export async function planRetentionCleanup({ dataRoot, traceRoot = null, settingsDatabasePath = null, retention = {}, now = new Date() } = {}) {
  if (!dataRoot) throw new Error('dataRoot is required');
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  const resolvedTraceRoot = traceRoot || path.join(dataRoot, 'traces');
  const traces = await listTraceRuns(resolvedTraceRoot);
  const sessionRetentionEnabled = ['mainMaxAgeDays', 'taskMaxAgeDays', 'subagentMaxAgeDays'].some((key) => retention[key] != null);
  const sessions = sessionRetentionEnabled ? await listSessionRecords({ rootDir: dataRoot, includeArchived: true, limit: 100000 }) : [];
  const sessionPolicies = { main: retention.mainMaxAgeDays ?? 60, task: retention.taskMaxAgeDays ?? 30, subagent: retention.subagentMaxAgeDays ?? 7 };
  const nowDate = new Date(nowMs);
  const taskBoard = sessionRetentionEnabled ? new TaskBoardStore({ databasePath: settingsDatabasePath || undefined }) : null;
  const sessionCandidates = (await Promise.all(sessions.map(async (record) => {
    const meta = record.metadata || {};
    const kind = meta.kind || 'main';
    if (kind === 'main' && isCurrentMain(record)) return null;
    // Task retention is anchored to the owning board task reaching a terminal
    // status, not merely to the end of a chat run. Missing or active ownership
    // is fail-closed so an orphan cannot be deleted accidentally.
    let eligibility = meta.retentionEligibleAt || meta.completedAt || meta.archivedAt || record.updatedAt;
    if (kind === 'task') {
      if (!meta.ownerTaskId) return null;
      const task = taskBoard?.getTask(meta.ownerTaskId);
      if (!task || !['done', 'cancelled'].includes(task.status)) return null;
      eligibility = task.terminalAt || task.metadata?.terminalAt || null;
    } else if (kind !== 'main' && !meta.completedAt) {
      return null;
    }
    const completed = new Date(eligibility).getTime();
    const days = sessionPolicies[kind];
    return Number.isFinite(completed) && Number.isFinite(days) && completed <= nowMs - days * 86400000
      ? { id: record.id, path: path.join(dataRoot, 'sessions', record.id), kind, reasons: ['age'] }
      : null;
  }))).filter(Boolean);
  taskBoard?.close();
  const traceMaxAgeDays = retention.traceMaxAgeDays ?? retention.maxAgeDays ?? null;
  const traceMaxBytes = retention.traceMaxBytes ?? null;
  const candidates = traceCandidates(traces, { maxAgeDays: traceMaxAgeDays, maxBytes: traceMaxBytes, nowMs });
  const totalTraceBytes = traces.reduce((total, trace) => total + trace.allocatedBytes, 0);
  const totalTraceLogicalBytes = traces.reduce((total, trace) => total + trace.logicalBytes, 0);
  const deleteTraceBytes = candidates.reduce((total, trace) => total + trace.allocatedBytes, 0);
  const deleteTraceLogicalBytes = candidates.reduce((total, trace) => total + trace.logicalBytes, 0);
  return {
    ok: true,
    dryRun: true,
    dataRoot,
    traceRoot: resolvedTraceRoot,
    retention: {
      traceMaxAgeDays,
      traceMaxBytes,
      legacySessionsMaxIgnored: retention.sessionsMax ?? null,
      legacyTracesMaxIgnored: retention.tracesMax ?? null,
      sessionPolicies,
    },
    counts: {
      sessions: sessionRetentionEnabled ? sessions.length : null,
      traces: traces.length,
      traceBytes: totalTraceBytes,
      traceLogicalBytes: totalTraceLogicalBytes,
      deleteSessions: sessionRetentionEnabled ? sessionCandidates.length : 0,
      deleteTraces: candidates.length,
      deleteTraceBytes,
      deleteTraceLogicalBytes,
    },
    delete: {
      sessions: sessionRetentionEnabled ? sessionCandidates : [],
      traces: candidates,
    },
  };
}

async function rmDir(dir) {
  await fs.rm(dir, { recursive: true, force: true });
  return dir;
}

// The trace retention state is deliberately kept beside the trace root. Keep
// the lease there too: all supported destructive entry points resolve the same
// trace root, including an externally launched systemd CLI invocation.
export function retentionCleanupLeasePath(traceRoot) {
  return `${path.resolve(traceRoot)}.retention-lock`;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error?.code !== 'ESRCH'; }
}

async function readRetentionLeaseOwner(lockPath) {
  try { return JSON.parse(await fs.readFile(path.join(lockPath, 'owner.json'), 'utf8')); }
  catch { return null; }
}

// mkdir is the cross-process atomic primitive. Publish from a fully initialized
// pending directory so contenders do not remove a just-created owner record.
// A lease left by a dead process is recovered on the next attempt.
export async function acquireRetentionCleanupLease(traceRoot) {
  if (!traceRoot) throw new Error('traceRoot is required');
  const lockPath = retentionCleanupLeasePath(traceRoot);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  const token = randomUUID();
  const pendingPath = `${lockPath}.${process.pid}.${token}.pending`;
  const owner = { pid: process.pid, token, acquiredAt: new Date().toISOString() };
  try {
    await fs.mkdir(pendingPath);
    await fs.writeFile(path.join(pendingPath, 'owner.json'), `${JSON.stringify(owner)}\n`, 'utf8');
    await fs.rename(pendingPath, lockPath);
    let released = false;
    return {
      acquired: true,
      lockPath,
      owner,
      async release() {
        if (released) return;
        released = true;
        // Never remove a lock that was recovered/replaced after this owner.
        const current = await readRetentionLeaseOwner(lockPath);
        if (current?.token === token) await fs.rm(lockPath, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fs.rm(pendingPath, { recursive: true, force: true });
    if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
    const current = await readRetentionLeaseOwner(lockPath);
    if (current && processIsAlive(current.pid)) return { acquired: false, lockPath, owner: current, reason: 'already_running' };
    // An incomplete legacy lock or a dead owner cannot make cleanup permanent.
    // Removal is safe only after a failed atomic publication proves we are not
    // the owner; retry once to acquire the newly vacant lease.
    await fs.rm(lockPath, { recursive: true, force: true });
    return acquireRetentionCleanupLease(traceRoot);
  }
}

export async function runRetentionCleanup({ dataRoot, traceRoot = null, settingsDatabasePath = null, retention = {}, confirm = false, now = new Date() } = {}) {
  const resolvedTraceRoot = traceRoot || path.join(dataRoot, 'traces');
  if (!confirm) return planRetentionCleanup({ dataRoot, traceRoot: resolvedTraceRoot, settingsDatabasePath, retention, now });
  const lease = await acquireRetentionCleanupLease(resolvedTraceRoot);
  if (!lease.acquired) {
    return {
      ok: true,
      dryRun: false,
      skipped: true,
      reason: 'already_running',
      dataRoot,
      traceRoot: resolvedTraceRoot,
      deleted: { sessions: [], traces: [] },
    };
  }
  try {
    const plan = await planRetentionCleanup({ dataRoot, traceRoot: resolvedTraceRoot, settingsDatabasePath, retention, now });
    const deletedSessions = [];
    for (const entry of plan.delete.sessions) {
      const metadata = await readSessionMetadata({ rootDir: dataRoot, sessionId: entry.id });
      if (isCurrentMain(metadata, entry.id)) throw new Error('retention_refused_current_main');
      await fs.rm(entry.path, { recursive: true, force: true });
      deletedSessions.push(entry.path);
    }
    const deletedTraces = [];
    for (const entry of plan.delete.traces) {
      await validatedTraceRunPath(plan.traceRoot, entry.path);
      deletedTraces.push(await rmDir(entry.path));
    }
    const result = {
      ...plan,
      dryRun: false,
      deleted: {
        sessions: deletedSessions,
        traces: deletedTraces,
      },
    };
    await writeTraceRetentionState(plan.traceRoot, result, now);
    return result;
  } finally {
    await lease.release();
  }
}
