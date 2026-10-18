import { randomUUID } from 'node:crypto';

const MOD_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const VERSION = /^v?(\d{4}\.\d{2}\.\d{2}(?:\.\d+)?|\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;
const ACTIONS = new Set(['install', 'update', 'enable', 'disable', 'uninstall', 'refresh']);
const STATUSES = new Set(['queued', 'running', 'succeeded', 'failed', 'interrupted']);
const ERRORS = new Set(['mod_not_found', 'mod_id_invalid', 'mod_source_not_resolved', 'mod_version_unavailable', 'mod_install_in_progress', 'mod_archive_resources_exceeded', 'mod_archive_resources_unavailable', 'mod_source_authentication_failed', 'mod_source_timeout', 'mod_source_git_failed', 'mod_management_failed', 'mod_management_interrupted']);
const invalid = () => Object.assign(new Error('mod_management_input_invalid'), { statusCode: 400 });
const unavailable = () => Object.assign(new Error('mod_management_unavailable'), { statusCode: 503 });
function object(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Object.keys(value).some(key => !keys.includes(key))) throw invalid();
}
function modId(value) { if (typeof value !== 'string' || value.length > 128 || value === 'mod-data' || !MOD_ID.test(value)) throw invalid(); return value; }
function identity(value, required = false) {
  if (value == null && !required) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > 256 || /[\x00-\x1f\x7f]/.test(value)) throw invalid();
  return value;
}
function text(value, max = 160) {
  if (typeof value !== 'string') return null;
  // Byte caps (not just code units) keep the two 100-item inventory pages well
  // below the 256 KiB capability envelope, including hostile manifest strings.
  return Buffer.from(value.replace(/[\x00-\x1f\x7f]/g, ''), 'utf8').subarray(0, max).toString('utf8');
}
function timestamp(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) ? value.slice(0, 32) : null;
}
function version(value) { return typeof value === 'string' && value.length <= 128 && VERSION.test(value) ? value : null; }
function safeResult(value) {
  if (!value || typeof value !== 'object') return null;
  const result = {};
  for (const key of ['ok', 'enabled', 'uninstalled', 'settingsPreserved', 'restartRequired']) if (typeof value[key] === 'boolean') result[key] = value[key];
  if (version(value.version)) result.version = value.version;
  if (['succeeded', 'failed', 'unknown'].includes(value.outcome)) result.outcome = value.outcome;
  return result;
}
function safeOperation(row) {
  return {
    id: text(row.id, 36), ownerModId: text(row.owner_mod_id, 128),
    actor: { agentId: text(row.agent_id, 256), sessionId: text(row.session_id, 256), conversationId: text(row.conversation_id, 256), runId: text(row.run_id, 256) },
    action: ACTIONS.has(row.action) ? row.action : null, modId: text(row.mod_id, 128), version: version(row.version),
    status: STATUSES.has(row.status) ? row.status : 'interrupted',
    createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at), startedAt: timestamp(row.started_at), finishedAt: timestamp(row.finished_at),
    result: safeResult(row.result), error: row.error_code ? { code: ERRORS.has(row.error_code) ? row.error_code : 'mod_management_failed' } : null,
  };
}

/** Core singleton. Its worker deliberately has no provider scope or caller signal.
 * Call close() before closing distribution or the repository pool. Only queued
 * work is replayable; an interrupted running operation has an unknown outcome.
 */
export function createModManagement({ distribution, repositoryFactory } = {}) {
  if (!distribution || typeof repositoryFactory !== 'function' || !['list', 'install', 'enable', 'disable', 'uninstall', 'refresh'].every(key => typeof distribution[key] === 'function')) throw new Error('mod_management_configuration_required');
  let closed = false;
  let scheduled = null;
  let worker = null;
  let wake = false;
  let workerError = null;
  let closing = null;
  const admissions = new Set();
  const callerBarriers = new Map();
  let gate = Promise.resolve();
  // Claims cannot see an admitted row until its submit promise has resolved,
  // even when another long-lived worker was already processing the queue.
  async function exclusive(fn, deferRelease = false) {
    const previous = gate;
    let release;
    gate = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await fn(); }
    finally { if (deferRelease) setImmediate(release); else release(); }
  }
  async function repository(fn) {
    const db = await repositoryFactory();
    try { return await fn(db); } finally { await db.close(); }
  }
  function schedule() {
    wake = true;
    if (scheduled || worker || workerError) return;
    scheduled = setImmediate(() => {
      scheduled = null;
      worker = drain().catch(() => { workerError = unavailable(); }).finally(() => {
        worker = null;
        if (wake && !workerError) schedule();
      });
    });
  }
  async function drain() {
    for (;;) {
      wake = false;
      const row = await exclusive(() => repository(db => db.claimManagementOperation(new Date().toISOString())));
      if (!row) return;
      // A self-update cannot retire its host until the receipt-producing tool
      // invocation settles. This barrier is supplied only by the trusted host.
      const barrier = callerBarriers.get(row.id);
      if (barrier) { await barrier; callerBarriers.delete(row.id); }
      let result; let errorCode = null; let status = 'succeeded';
      try {
        const value = row.action === 'refresh' ? await distribution.refresh()
          : ['install', 'update'].includes(row.action) ? await distribution.install(row.mod_id, row.version)
            : await distribution[row.action](row.mod_id);
        if (value?.ok === false) { status = 'failed'; errorCode = 'mod_management_failed'; }
        result = { ...safeResult(value), outcome: status === 'succeeded' ? 'succeeded' : 'unknown' };
      } catch (error) {
        status = 'failed';
        errorCode = ERRORS.has(error?.message) ? error.message : 'mod_management_failed';
        // Distribution may have committed before cleanup failed. Never assert
        // that a thrown exception proves the mutation was rolled back.
        result = { outcome: 'unknown' };
      }
      await repository(db => db.finishManagementOperation(row.id, { status, result, errorCode, timestamp: new Date().toISOString() }));
    }
  }
  const ready = (async () => {
    await distribution.ready;
    await repository(async db => {
      await db.ensureManagementSchema();
      await db.interruptManagementOperations(new Date().toISOString());
    });
    schedule();
  })().catch(() => { throw unavailable(); });
  void ready.catch(() => {});

  async function inventory(input = {}, { assertCallerActive } = {}) {
    object(input, ['offset', 'limit']);
    const offset = input.offset ?? 0; const limit = input.limit ?? 50;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw invalid();
    await ready;
    if (closed) throw unavailable();
    assertCallerActive?.();
    let value;
    try { value = await distribution.list(); } catch { throw unavailable(); }
    assertCallerActive?.();
    const mods = Array.isArray(value?.mods) ? value.mods : [];
    const sources = Array.isArray(value?.sources) ? value.sources : [];
    return {
      ok: true,
      mods: mods.slice(offset, offset + limit).map(row => ({
        id: text(row.id, 128), name: text(row.name), version: version(row.version), latestVersion: version(row.latestVersion),
        status: ['installed', 'available', 'failed'].includes(row.status) ? row.status : 'unknown',
        enabled: row.enabled === true, system: row.system === true, updateAvailable: row.updateAvailable === true, canInstall: row.canInstall === true,
      })),
      sources: sources.slice(offset, offset + limit).map(row => ({ id: text(row.id, 128), status: ['pending', 'ready', 'failed'].includes(row.status) ? row.status : 'unknown', lastCheckedAt: timestamp(row.lastCheckedAt) })),
      pagination: { offset, limit, totalMods: mods.length, totalSources: sources.length, nextOffset: offset + limit < Math.max(mods.length, sources.length) ? offset + limit : null },
    };
  }
  function submit(input, { ownerModId, caller, waitForCaller, assertCallerActive } = {}) {
    // Synchronous admission tracking lets close fence even pending persistence.
    if (closed || workerError) return Promise.reject(unavailable());
    const pending = (async () => {
      object(input, ['action', 'modId', 'version']);
      const owner = modId(ownerModId);
      if (!ACTIONS.has(input.action)) throw invalid();
      if (input.action === 'refresh') {
        if (Object.hasOwn(input, 'modId') || Object.hasOwn(input, 'version')) throw invalid();
      } else modId(input.modId);
      if (Object.hasOwn(input, 'version') && (!['install', 'update'].includes(input.action) || !version(input.version))) throw invalid();
      if (!caller || typeof caller !== 'object') throw invalid();
      const actor = { agent_id: identity(caller.agentId, true), session_id: identity(caller.sessionId), conversation_id: identity(caller.conversationId), run_id: identity(caller.runId) };
      const requested = { action: input.action, mod_id: input.modId ?? null, version: input.version ?? null };
      await ready;
      if (workerError) throw unavailable();
      const timestamp = new Date().toISOString();
      const row = { id: randomUUID(), owner_mod_id: owner, ...actor, ...requested, status: 'queued', created_at: timestamp, updated_at: timestamp, started_at: null, finished_at: null, result: null, error_code: null };
      if (waitForCaller) callerBarriers.set(row.id, Promise.resolve(waitForCaller).catch(() => {}));
      try { await exclusive(() => repository(db => { assertCallerActive?.(); return db.createManagementOperation(row); }), true); } catch { callerBarriers.delete(row.id); throw unavailable(); }
      // Never run an installer in the submitting invocation (including self-update).
      schedule();
      return { ok: true, operation: safeOperation(row) };
    })();
    admissions.add(pending);
    void pending.finally(() => admissions.delete(pending)).catch(() => {});
    return pending;
  }
  async function operation(input, { ownerModId, assertCallerActive } = {}) {
    object(input, ['operationId']);
    const owner = modId(ownerModId);
    if (typeof input.operationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.operationId)) throw invalid();
    await ready;
    if (closed) throw unavailable();
    assertCallerActive?.();
    let row;
    try { row = await repository(db => db.managementOperation(input.operationId, owner)); } catch { throw unavailable(); }
    assertCallerActive?.();
    if (!row || row.owner_mod_id !== owner) throw Object.assign(new Error('mod_management_operation_not_found'), { statusCode: 404 });
    return { ok: true, operation: safeOperation(row) };
  }
  function close() {
    if (closing) return closing;
    closed = true;
    closing = (async () => {
      await Promise.allSettled([...admissions]);
      await ready;
      while (scheduled || worker) {
        if (scheduled) await new Promise(resolve => setImmediate(resolve));
        if (worker) await worker;
      }
      if (workerError) throw workerError;
    })();
    return closing;
  }
  return { ready, inventory, submit, operation, close };
}

export default createModManagement;
