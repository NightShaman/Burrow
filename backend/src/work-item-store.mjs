import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactValue } from './redaction.mjs';
import { observeCompatibilityRead } from './compatibility-observability.mjs';

function safeId(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || randomUUID();
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

function workItemsDir(dataRoot) {
  if (!dataRoot) throw new Error('dataRoot is required');
  return path.join(dataRoot, 'work-items');
}

function workItemDir(dataRoot, id) {
  return path.join(workItemsDir(dataRoot), safeId(id));
}

function workItemFile(dataRoot, id) {
  return path.join(workItemDir(dataRoot, id), 'work-item.json');
}

async function readJson(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function deriveStatus(item) {
  const last = item.steps?.at(-1) || null;
  if (!last) return 'new';
  if (last.ok === false || last.decision === 'blocked') {
    if (last.step === 'verify') return 'verification_failed';
    return 'blocked';
  }
  if (last.step === 'verify' && last.ok) return 'verified';
  if (last.step === 'factory') return 'factory_previewed';
  if (last.step === 'propose') return 'proposed';
  if (last.step === 'inspect') return 'inspected';
  return last.decision || 'active';
}

const STEP_ORDER = ['inspect', 'propose', 'verify', 'factory'];

function completedStep(item, step) {
  return Boolean((item.steps || []).find((entry) => entry.step === step && entry.ok));
}

function lastFailed(item) {
  const last = item.steps?.at(-1) || null;
  return last && last.ok === false ? last : null;
}

const DEFAULT_ACTIVE_WORK_ITEM_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const ACTIVE_WORK_ITEM_STATUSES = new Set(['new', 'proposed', 'changed', 'verification_failed', 'blocked']);

function sameWorkspace(a = null, b = null) {
  if (!a || !b) return false;
  return path.resolve(String(a)) === path.resolve(String(b));
}

function itemAgeMs(item = {}, now = Date.now()) {
  const ts = Date.parse(item.updatedAt || item.createdAt || '');
  if (!Number.isFinite(ts)) return Infinity;
  return Math.max(0, Number(now) - ts);
}

function isActiveWorkItem(item = {}, { sessionId = null, workspaceRoot = null, now = Date.now(), maxAgeMs = DEFAULT_ACTIVE_WORK_ITEM_MAX_AGE_MS } = {}) {
  if (sessionId && item.sessionId !== sessionId) return false;
  if (workspaceRoot && !sameWorkspace(item.workspaceRoot, workspaceRoot)) return false;
  if (!ACTIVE_WORK_ITEM_STATUSES.has(item.status || 'new')) return false;
  if (Number.isFinite(Number(maxAgeMs)) && Number(maxAgeMs) >= 0 && itemAgeMs(item, now) > Number(maxAgeMs)) return false;
  return true;
}

export function workItemEligibility(item = {}, step = 'inspect', { override = false } = {}) {
  if (['done', 'archived', 'completed', 'running'].includes(item.status)) return { ok: false, step, blockers: [`work_item_${item.status}`], allowedNextSteps: [] };
  if (override) return { ok: true, step, override: true, blockers: [], allowedNextSteps: allowedNextSteps(item, { override: true }) };
  if (!STEP_ORDER.includes(step)) return { ok: false, step, blockers: [`unsupported_step:${step}`], allowedNextSteps: allowedNextSteps(item) };
  const failed = lastFailed(item);
  if (failed) return { ok: false, step, blockers: ['previous_step_failed'], failedStep: failed.step, allowedNextSteps: allowedNextSteps(item) };
  if (step === 'inspect') return { ok: true, step, blockers: [], allowedNextSteps: allowedNextSteps(item) };
  if (step === 'propose' && !completedStep(item, 'inspect')) return { ok: false, step, blockers: ['inspect_required'], allowedNextSteps: allowedNextSteps(item) };
  if (step === 'verify' && !completedStep(item, 'propose')) return { ok: false, step, blockers: ['proposal_required'], allowedNextSteps: allowedNextSteps(item) };
  if (step === 'factory' && !completedStep(item, 'verify')) return { ok: false, step, blockers: ['verification_required'], allowedNextSteps: allowedNextSteps(item) };
  return { ok: true, step, blockers: [], allowedNextSteps: allowedNextSteps(item) };
}

export function allowedNextSteps(item = {}, { override = false } = {}) {
  if (['done', 'archived', 'completed', 'running'].includes(item.status)) return [];
  if (override) return [...STEP_ORDER];
  if (lastFailed(item)) return ['inspect'];
  if (!completedStep(item, 'inspect')) return ['inspect'];
  if (!completedStep(item, 'propose')) return ['inspect', 'propose'];
  if (!completedStep(item, 'verify')) return ['inspect', 'propose', 'verify'];
  return ['inspect', 'propose', 'verify', 'factory'];
}

export async function createWorkItem({ dataRoot, message, workspaceRoot = null, title = null, id = null, sessionId = null, kind = null, clock = nowIso } = {}) {
  if (!dataRoot) throw new Error('dataRoot is required');
  if (!message) throw new Error('message is required');
  const workItemId = safeId(id || `work-${clock()}-${randomUUID()}`);
  const item = {
    version: 1,
    id: workItemId,
    title: title || String(message).slice(0, 80),
    kind: kind || null,
    message: String(message),
    workspaceRoot: workspaceRoot || null,
    sessionId: sessionId || null,
    status: 'new',
    createdAt: clock(),
    updatedAt: clock(),
    currentStep: null,
    allowedNextSteps: ['inspect'],
    steps: [],
  };
  await fs.mkdir(workItemDir(dataRoot, workItemId), { recursive: true });
  await atomicWriteJson(workItemFile(dataRoot, workItemId), redactValue(item));
  return item;
}

export async function readWorkItem({ dataRoot, id, legacyDataRoot = null, compatibilityObserver = null, sessionId = null, runId = null } = {}) {
  if (!dataRoot) throw new Error('dataRoot is required');
  if (!id) throw new Error('id is required');
  const current = await readJson(workItemFile(dataRoot, id));
  if (current || !legacyDataRoot) return current;
  const legacyPath = workItemFile(legacyDataRoot, id);
  const legacy = await readJson(legacyPath);
  if (legacy) observeCompatibilityRead(compatibilityObserver, { operation: 'read-work-item', legacyPath, replacementPath: workItemFile(dataRoot, id), sessionId, runId });
  return legacy;
}

export async function writeWorkItem({ dataRoot, item } = {}) {
  if (!dataRoot) throw new Error('dataRoot is required');
  if (!item?.id) throw new Error('item.id is required');
  return withRecordLock(item.id, async () => {
    const derivedStatus = item.status === 'archived' || item.status === 'done' ? item.status : deriveStatus(item);
    const normalized = redactValue({ ...item, status: derivedStatus, allowedNextSteps: allowedNextSteps({ ...item, status: derivedStatus }), updatedAt: item.updatedAt || nowIso() });
    await fs.mkdir(workItemDir(dataRoot, normalized.id), { recursive: true });
    await atomicWriteJson(workItemFile(dataRoot, normalized.id), normalized);
    return normalized;
  });
}

export async function listWorkItems({ dataRoot, legacyDataRoot = null, compatibilityObserver = null, sessionId = null, runId = null, includeDone = true, limit = 100 } = {}) {
  if (!dataRoot) throw new Error('dataRoot is required');
  let entries = [];
  try {
    entries = await fs.readdir(workItemsDir(dataRoot), { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const items = [];
  for (const entry of entries.filter((item) => item.isDirectory())) {
    const item = await readWorkItem({ dataRoot, legacyDataRoot, compatibilityObserver, sessionId, runId, id: entry.name });
    if (!item) continue;
    if (!includeDone && ['done', 'archived'].includes(item.status)) continue;
    items.push(item);
  }
  if (legacyDataRoot) {
    const legacyItems = await listWorkItems({ dataRoot: legacyDataRoot, includeDone, limit, sessionId, runId });
    const seen = new Set(items.map((item) => item.id));
    for (const item of legacyItems) {
      if (seen.has(item.id)) continue;
      observeCompatibilityRead(compatibilityObserver, { operation: 'list-work-items', legacyPath: workItemFile(legacyDataRoot, item.id), replacementPath: workItemFile(dataRoot, item.id), sessionId, runId });
      items.push(item);
    }
  }
  return items.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))).slice(0, limit);
}

export async function findActiveWorkItem({ dataRoot, sessionId = null, workspaceRoot = null, now = Date.now(), maxAgeMs = DEFAULT_ACTIVE_WORK_ITEM_MAX_AGE_MS } = {}) {
  const items = await listWorkItems({ dataRoot, includeDone: true, limit: 200 });
  return items.find((item) => isActiveWorkItem(item, { sessionId, workspaceRoot, now, maxAgeMs })) || null;
}

export async function archiveWorkItem({ dataRoot, id, archived = true, clock = nowIso } = {}) {
  const item = await readWorkItem({ dataRoot, id });
  if (!item) return null;
  return writeWorkItem({
    dataRoot,
    item: {
      ...item,
      status: archived ? 'archived' : deriveStatus({ ...item, status: item.status }),
      archivedAt: archived ? clock() : null,
      updatedAt: clock(),
    },
  });
}

export async function appendWorkItemStep({ dataRoot, id, step, result, clock = nowIso } = {}) {
  if (!step) throw new Error('step is required');
  return withRecordLock(id, async () => {
    const item = await readWorkItem({ dataRoot, id });
    if (!item) throw new Error(`work item not found: ${safeId(id)}`);
    const entry = redactValue({
      step,
      ts: clock(),
      ok: result?.ok ?? false,
      decision: result?.decision || null,
      runId: result?.runId || result?.result?.runId || null,
      traceDir: result?.traceDir || result?.result?.traceDir || null,
      blockers: result?.blockers || result?.result?.blockers || [],
      warnings: result?.warnings || result?.result?.warnings || [],
      proposedActionCount: result?.result?.proposedActionCount ?? result?.proposedActionCount ?? 0,
      verification: result?.verification || result?.result?.verification || null,
      commit: result?.commit || result?.result?.commit || null,
      result,
    });
    const updated = {
      ...item,
      currentStep: step,
      updatedAt: clock(),
      steps: [...(item.steps || []), entry],
    };
    const derivedStatus = deriveStatus(updated);
    const normalized = redactValue({ ...updated, status: derivedStatus, allowedNextSteps: allowedNextSteps({ ...updated, status: derivedStatus }) });
    await atomicWriteJson(workItemFile(dataRoot, normalized.id), normalized);
    return normalized;
  });
}

export const __test__ = { safeId, workItemsDir, workItemDir, workItemFile, deriveStatus, workItemEligibility, allowedNextSteps, sameWorkspace, itemAgeMs, isActiveWorkItem, DEFAULT_ACTIVE_WORK_ITEM_MAX_AGE_MS };
