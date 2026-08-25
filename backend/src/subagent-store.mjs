import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createSubagentContract, subagentTransition, isFinalSubagentStatus } from './subagent-contracts.mjs';
import { redactValue } from './redaction.mjs';
import { observeCompatibilityRead } from './compatibility-observability.mjs';

function safeId(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 160);
}

function nowIso() {
  return new Date().toISOString();
}

const writeLocks = new Map();

async function withRecordLock(key, fn) {
  const normalizedKey = String(key || 'global');
  const previous = writeLocks.get(normalizedKey) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const queued = previous.catch(() => {}).then(() => current);
  writeLocks.set(normalizedKey, queued);
  await previous.catch(() => {});
  try {
    return await fn();
  } finally {
    release();
    if (writeLocks.get(normalizedKey) === queued) writeLocks.delete(normalizedKey);
  }
}

async function atomicWriteJson(filePath, value) {
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, filePath);
}

function subagentRoot(dataRoot) {
  if (!dataRoot) throw new Error('dataRoot is required');
  return path.join(dataRoot, 'subagents');
}

function subagentDir(dataRoot, id) {
  const normalized = safeId(id);
  if (!normalized) throw new Error('id is required');
  return path.join(subagentRoot(dataRoot), normalized);
}

function subagentFile(dataRoot, id) {
  return path.join(subagentDir(dataRoot, id), 'subagent.json');
}

function historicalDelegatedFile(dataRoot, id) {
  return path.join(dataRoot, 'delegated-runs', safeId(id), 'delegated-work.json');
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeSubagentFile({ dataRoot, record }) {
  await fs.mkdir(subagentDir(dataRoot, record.id), { recursive: true });
  const redacted = redactValue(record);
  await atomicWriteJson(subagentFile(dataRoot, record.id), redacted);
  return redacted;
}

export async function createSubagentRecord({ dataRoot, clock = nowIso, ...input } = {}) {
  if (!dataRoot) throw new Error('dataRoot is required');
  const ts = clock();
  const record = createSubagentContract({
    ...input,
    status: input.status || 'queued',
    createdAt: input.createdAt || ts,
    updatedAt: input.updatedAt || ts,
  });
  return writeSubagentFile({ dataRoot, record });
}

export async function readSubagentRecord({ dataRoot, id, legacyDataRoot = null, compatibilityObserver = null, sessionId = null, runId = null } = {}) {
  if (!dataRoot) throw new Error('dataRoot is required');
  if (!id) throw new Error('id is required');
  const current = await readJson(subagentFile(dataRoot, id));
  if (current || !legacyDataRoot) return current;
  const legacyPath = historicalDelegatedFile(legacyDataRoot, id);
  const legacy = await readJson(legacyPath);
  if (legacy) observeCompatibilityRead(compatibilityObserver, { operation: 'read-historical-delegated-run', legacyPath, replacementPath: subagentFile(dataRoot, id), sessionId, runId });
  return legacy;
}

// Exact structural lookup only. The caller supplies the deterministic key;
// this store never attempts to interpret whether two task descriptions match.
export async function findSubagentBySpawnRequestKey({ dataRoot, key, legacyDataRoot = null } = {}) {
  const normalizedKey = String(key || '').trim();
  if (!normalizedKey) return null;
  const records = await listSubagentRecords({ dataRoot, legacyDataRoot, includeFinal: true, limit: Number.MAX_SAFE_INTEGER });
  return records.find((record) => record.spawnRequest?.key === normalizedKey) || null;
}

export async function listSubagentRecords({ dataRoot, legacyDataRoot = null, compatibilityObserver = null, sessionId = null, runId = null, includeFinal = true, limit = 100 } = {}) {
  if (!dataRoot) throw new Error('dataRoot is required');
  let entries = [];
  try {
    entries = await fs.readdir(subagentRoot(dataRoot), { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const record = await readSubagentRecord({ dataRoot, legacyDataRoot, compatibilityObserver, sessionId, runId, id: entry.name });
    if (!record) continue;
    if (!includeFinal && isFinalSubagentStatus(record.status)) continue;
    records.push(record);
  }
  if (legacyDataRoot) {
    const legacyRecords = await listSubagentRecords({ dataRoot: legacyDataRoot, includeFinal, limit, sessionId, runId });
    const seen = new Set(records.map((record) => record.id));
    for (const record of legacyRecords) {
      if (seen.has(record.id)) continue;
      observeCompatibilityRead(compatibilityObserver, { operation: 'list-subagents', legacyPath: subagentFile(legacyDataRoot, record.id), replacementPath: subagentFile(dataRoot, record.id), sessionId, runId });
      records.push(record);
    }
  }
  return records
    .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))
    .slice(0, limit);
}

export async function updateSubagentStatus({ dataRoot, id, status, phase = null, trace = null, model = null, result = null, provenance = null, clock = nowIso } = {}) {
  if (!dataRoot) throw new Error('dataRoot is required');
  if (!id) throw new Error('id is required');
  if (!status) throw new Error('status is required');
  return withRecordLock(id, async () => {
    const current = await readSubagentRecord({ dataRoot, id });
    if (!current) throw new Error(`delegated work not found: ${safeId(id)}`);
    const transition = subagentTransition({ current: current.status, next: status });
    if (!transition.ok) {
      return { ok: false, record: current, transition };
    }
    const updated = createSubagentContract({
      ...current,
      status,
      phase: phase || current.phase || null,
      trace: trace ? { ...current.trace, ...trace } : current.trace,
      model: model === null ? current.model : model,
      result: result === null ? current.result : result,
      provenance: provenance ? [...(current.provenance || []), ...(Array.isArray(provenance) ? provenance : [provenance])] : current.provenance,
      updatedAt: clock(),
    });
    return { ok: true, record: await writeSubagentFile({ dataRoot, record: updated }), transition };
  });
}

export async function updateSubagentRecord({ dataRoot, id, patch = {}, clock = nowIso } = {}) {
  if (!dataRoot) throw new Error('dataRoot is required');
  if (!id) throw new Error('id is required');
  const currentForStatus = await readSubagentRecord({ dataRoot, id });
  if (!currentForStatus) throw new Error(`delegated work not found: ${safeId(id)}`);
  if (patch.status && patch.status !== currentForStatus.status) {
    return updateSubagentStatus({
      dataRoot,
      id,
      status: patch.status,
      phase: patch.phase || null,
      trace: patch.trace || null,
      model: Object.hasOwn(patch, 'model') ? patch.model : null,
      result: Object.hasOwn(patch, 'result') ? patch.result : null,
      provenance: patch.provenance || null,
      clock,
    });
  }
  return withRecordLock(id, async () => {
    const current = await readSubagentRecord({ dataRoot, id });
    if (!current) throw new Error(`delegated work not found: ${safeId(id)}`);
    const updated = createSubagentContract({
      ...current,
      ...patch,
      id: current.id,
      owner: patch.owner ? { ...current.owner, ...patch.owner } : current.owner,
      scope: patch.scope ? { ...current.scope, ...patch.scope } : current.scope,
      permissions: patch.permissions ? { ...current.permissions, ...patch.permissions } : current.permissions,
      trace: patch.trace ? { ...current.trace, ...patch.trace } : current.trace,
      provenance: patch.provenance ? [...(current.provenance || []), ...(Array.isArray(patch.provenance) ? patch.provenance : [patch.provenance])] : current.provenance,
      updatedAt: clock(),
    });
    return { ok: true, record: await writeSubagentFile({ dataRoot, record: updated }), transition: { ok: true, blockers: [] } };
  });
}

export async function cancelSubagentRecord({ dataRoot, id, reason, clock = nowIso } = {}) {
  if (!reason || !String(reason).trim()) throw new Error('cancel reason is required');
  return updateSubagentStatus({
    dataRoot,
    id,
    status: 'cancelled',
    result: {
      ok: false,
      summary: `Cancelled: ${String(reason).trim()}`,
      blockers: ['subagent_cancelled'],
      warnings: [],
      evidence: [],
      artifacts: [],
      changedFiles: [],
      memoryWrites: [],
    },
    provenance: { source: 'parent-runtime', reason: 'cancelled', detail: String(reason).trim() },
    clock,
  });
}

export function mergeSubagentResult(record = {}) {
  if (!record?.id) throw new Error('delegated work record is required');
  if (!isFinalSubagentStatus(record.status)) {
    return { ok: false, id: record.id, status: record.status, blockers: ['subagent_not_final'] };
  }
  const result = record.result || {};
  return {
    ok: Boolean(result.ok),
    id: record.id,
    status: record.status,
    purpose: record.purpose || '',
    summary: result.summary || '',
    blockers: Array.isArray(result.blockers) ? result.blockers : [],
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    evidence: Array.isArray(result.evidence) ? result.evidence : [],
    artifacts: Array.isArray(result.artifacts) ? result.artifacts : [],
    changedFiles: Array.isArray(result.changedFiles) ? result.changedFiles : [],
    memoryWrites: Array.isArray(result.memoryWrites) ? result.memoryWrites : [],
    trace: record.trace || {},
    provenance: record.provenance || [],
    sideEffectsApplied: Boolean(result.sideEffectsApplied),
  };
}

export function subagentVisibilitySummary(record = {}) {
  return {
    id: record.id || null,
    status: record.status || null,
    phase: record.phase || (isFinalSubagentStatus(record.status) ? 'idle' : record.status === 'running' ? 'thinking' : 'idle'),
    final: isFinalSubagentStatus(record.status),
    createdAt: record.createdAt || null,
    updatedAt: record.updatedAt || null,
    purpose: record.purpose || '',
    label: record.label || null,
    owner: {
      sessionId: record.owner?.sessionId || null,
      conversationId: record.owner?.conversationId || null,
      turnId: record.owner?.turnId || null,
      parentRunId: record.owner?.parentRunId || null,
    },
    ...(record.model ? { model: record.model } : {}),
    trace: {
      runId: record.trace?.runId || null,
      traceDir: record.trace?.traceDir || null,
      childSessionId: record.trace?.childSessionId || null,
    },
    result: record.result ? {
      ok: Boolean(record.result.ok),
      summary: record.result.summary || '',
      blockers: Array.isArray(record.result.blockers) ? record.result.blockers.length : 0,
      warnings: Array.isArray(record.result.warnings) ? record.result.warnings.length : 0,
      evidence: Array.isArray(record.result.evidence) ? record.result.evidence.length : 0,
      artifacts: Array.isArray(record.result.artifacts) ? record.result.artifacts.length : 0,
      changedFiles: Array.isArray(record.result.changedFiles) ? record.result.changedFiles.length : 0,
      memoryWrites: Array.isArray(record.result.memoryWrites) ? record.result.memoryWrites.length : 0,
      sideEffectsApplied: Boolean(record.result.sideEffectsApplied),
    } : null,
  };
}

export const __subagentStore__ = { safeId, subagentRoot, subagentDir, subagentFile };
