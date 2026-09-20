// Diagnostics are a separate opt-in contract, never a proxy for mod HTTP routes.
const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
const token = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,80}$/.test(value) ? value : null;
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(value) && !Number.isNaN(Date.parse(value)) ? value : null;
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const fields = Object.freeze({ id: token, kind: token, status: token, phase: token, createdAt: date, updatedAt: date, startedAt: date, finishedAt: date, phaseStartedAt: date, elapsedMs: count, resumable: value => typeof value === 'boolean' ? value : null, completeness: token });
const progressFields = Object.freeze({ phase: token, completed: count, total: count, messagesRead: count, modelCalls: count, accountsProduced: count });
function pick(source, shape) {
  const result = {};
  for (const [name, clean] of Object.entries(shape)) {
    const value = clean(source?.[name]);
    if (value !== null) result[name] = value;
  }
  return result;
}
export function sanitizeJob(job) {
  if (!job || typeof job !== 'object' || !token(job.id) || !token(job.status)) throw new Error('mod_diagnostics_invalid_result');
  const result = pick(job, fields);
  if (job.progress && typeof job.progress === 'object') result.progress = pick(job.progress, progressFields);
  if (job.collectionStats && typeof job.collectionStats === 'object') result.collectionStats = pick(job.collectionStats, progressFields);
  if (job.phaseTimings && typeof job.phaseTimings === 'object') result.phaseTimings = Object.fromEntries(Object.entries(job.phaseTimings).filter(([k,v]) => token(k) && count(v) !== null));
  return result;
}
export function diagnosticMods(mods) {
  return mods.map(mod => ({ id: mod.id, ...(typeof mod.name === 'string' && mod.name.length <= 240 ? { name: mod.name } : {}), ...(mod.status !== 'failed' && typeof mod.manifest?.version === 'string' && (/^[v]?[0-9]{4}\.[0-9]{2}\.[0-9]{2}(?:\.[0-9]+)?$/.test(mod.manifest.version) || /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(mod.manifest.version)) && mod.manifest.version.length <= 80 ? { version: mod.manifest.version } : {}), status: mod.status, diagnostics: mod.status === 'loaded' ? (mod.diagnosticsSupported ? 'supported' : 'unsupported') : 'unavailable' }));
}
export async function modJobs(mods, modId, { limit = 50, cursor, jobId } = {}) {
  if (!idPattern.test(modId || '')) throw Object.assign(new Error('invalid_mod_id'), { statusCode: 400 });
  const mod = mods.find(item => item.id === modId);
  if (!mod) throw Object.assign(new Error('mod_not_found'), { statusCode: 404 });
  if (mod.status !== 'loaded') return { modId, diagnostics: 'unavailable', status: mod.status };
  if (!mod.diagnosticsSupported) return { modId, diagnostics: 'unsupported' };
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (cursor !== undefined && (typeof cursor !== 'string' || cursor.length > 256)) || (jobId !== undefined && !idPattern.test(jobId))) throw Object.assign(new Error('invalid_diagnostics_query'), { statusCode: 400 });
  try {
    if (jobId !== undefined) {
      const raw = await mod.host.invoke('diagnostic-detail', jobId);
      return { modId, diagnostics: 'supported', job: raw == null ? null : sanitizeJob(raw) };
    }
    const raw = await mod.host.invoke('diagnostic-list', { limit, cursor });
    if (!raw || !Array.isArray(raw.jobs) || raw.jobs.length > limit || typeof raw.hasMore !== 'boolean' || (raw.hasMore && (typeof raw.nextCursor !== 'string' || raw.nextCursor.length > 256))) throw new Error('mod_diagnostics_invalid_result');
    return { modId, diagnostics: 'supported', jobs: raw.jobs.map(sanitizeJob), hasMore: raw.hasMore, nextCursor: raw.hasMore ? raw.nextCursor : null };
  } catch {
    return { modId, diagnostics: 'unavailable', status: 'diagnostic_error' };
  }
}

export function pendingModOperations(mods, modId) {
  if (!idPattern.test(modId || '')) throw Object.assign(new Error('invalid_mod_id'), { statusCode: 400 });
  const mod = mods.find(item => item.id === modId);
  if (!mod) throw Object.assign(new Error('mod_not_found'), { statusCode: 404 });
  if (mod.status !== 'loaded' || !mod.host) return { modId, diagnostics: 'unavailable', status: mod.status };
  return { modId, diagnostics: 'supported', operations: mod.host.pendingDiagnostics().map(({ kind, operation, status, elapsedMs }) => ({ kind: token(kind), operation: token(operation), status: token(status), elapsedMs: count(elapsedMs) })) };
}
