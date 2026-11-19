import { constants as fsConstants, promises as fs } from 'node:fs';
import path from 'node:path';
import { redactStructuredJsonText } from './redaction.mjs';
import { validTraceRunId } from './trace-summary.mjs';

export const PROVIDER_REQUEST_RETENTION_DAYS = 3;
export const PROVIDER_REQUEST_RETENTION_MS = PROVIDER_REQUEST_RETENTION_DAYS * 86_400_000;
export const providerRequestArtifactName = /^provider-request-[A-Za-z0-9_.-]+\.json$/;

async function readJsonLines(filePath) {
  try {
    if (!(await fs.lstat(filePath)).isFile()) return [];
    return (await fs.readFile(filePath, 'utf8')).split('\n').filter(Boolean).flatMap((line) => {
      try { return [JSON.parse(line)]; } catch { return []; }
    });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
}

function isInternalRequest(record) {
  const manifest = record?.payload?.providerMessageManifest || [];
  return manifest.length > 0 && manifest.every((message) => message?.source === 'internal-curation' || message?.source === 'internal-planner');
}

function capturePath(runDir, record, history) {
  const pointer = record.payload?.providerRequestArtifact;
  if (typeof pointer !== 'string' || !pointer) return null;
  const name = path.basename(pointer);
  const artifactsDir = path.resolve(runDir, 'artifacts');
  const requestId = record.payload.requestId;
  // Legacy absolute pointers are identity evidence, not paths to open. Only
  // rebase an exact request filename under the same run's artifacts suffix.
  if (typeof requestId === 'string' && validTraceRunId(requestId) && name === `provider-request-${requestId}.json`) {
    if (pointer === `artifacts/${name}` || (path.isAbsolute(pointer) && path.normalize(pointer) === pointer
        && path.dirname(pointer).endsWith(`${path.sep}${path.basename(runDir)}${path.sep}artifacts`))) return path.join(artifactsDir, name);
  }
  // Older live-context traces had nonstandard filenames. Keep in-place reads
  // for those, but never infer a relocated identity from them.
  if (!history && path.dirname(path.resolve(pointer)) === artifactsDir) return path.join(artifactsDir, name);
  return null;
}

async function captureForRecord(runDir, record, { includeBody, nowMs, history = false }) {
  const artifactPath = capturePath(runDir, record, history);
  if (!artifactPath) return { state: record.payload?.providerRequestArtifact === null ? 'not_captured' : 'unavailable' };
  const capturedAt = Date.parse(record.ts);
  const cutoff = nowMs - PROVIDER_REQUEST_RETENTION_MS;
  if (Number.isFinite(capturedAt) && capturedAt <= cutoff) return { state: 'expired' };
  try {
    const directory = await fs.open(path.dirname(artifactPath), fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    let raw;
    try {
      const target = `/proc/self/fd/${directory.fd}/${path.basename(artifactPath)}`;
      const file = await fs.open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
      try {
        const stat = await file.stat();
        if (!stat.isFile()) return { state: 'unavailable' };
        if (!Number.isFinite(capturedAt) && stat.mtimeMs <= cutoff) return { state: 'expired' };
        raw = await file.readFile('utf8');
      } finally { await file.close(); }
    } finally { await directory.close(); }
    // Reapply today's structured redaction to historical captures. Parse first
    // so blank/partial/corrupt artifacts never appear as captured requests.
    const body = JSON.parse(raw);
    if (!body || typeof body !== 'object' || Array.isArray(body)) return { state: 'unavailable' };
    if (!includeBody) return { state: 'available' };
    return { state: 'available', artifactPath, body: history ? JSON.parse(redactStructuredJsonText(raw)) : body };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR', 'ELOOP', 'EACCES', 'EPERM'].includes(error?.code) || error instanceof SyntaxError) return { state: 'unavailable' };
    throw error;
  }
}

/** Read the exact saved requests for one run in recorded order. */
export async function providerRequestHistory({ traceSessionRoot, sessionId, runId, requestId = null, nowMs = Date.now() }) {
  if (!validTraceRunId(runId)) return null;
  const runDir = path.join(traceSessionRoot, runId);
  try {
    if (!(await fs.lstat(runDir)).isDirectory() || !(await fs.lstat(path.join(runDir, 'events.jsonl'))).isFile()) return null;
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const records = (await readJsonLines(path.join(runDir, 'model.jsonl'))).filter((record) =>
    record?.runId === runId && record.sessionId === sessionId && record.payload?.stage === 'model-request'
      && typeof record.payload.requestId === 'string' && validTraceRunId(record.payload.requestId));
  const project = async (record, includeBody) => {
    const { requestId, provider, model, api, modelCall, continuation } = record.payload;
    const { state, body } = await captureForRecord(runDir, record, { includeBody, nowMs, history: true });
    return { requestId, ts: record.ts ?? null, provider: provider ?? null, model: model ?? null, api: api ?? null,
      modelCall: modelCall ?? null, continuation: continuation === true, state, ...(body === undefined ? {} : { body }) };
  };
  // Every record in this trace belongs to the selected session; an explicit
  // mismatch is a missing run, not an empty request list for another session.
  if (records.length === 0) {
    const events = await readJsonLines(path.join(runDir, 'events.jsonl'));
    if (!events.some((record) => record?.runId === runId && record.sessionId === sessionId)) return null;
  }
  if (requestId !== null) {
    const record = records.findLast((entry) => entry.payload.requestId === requestId);
    return record ? { ok: true, runId, request: await project(record, true) } : { ok: false, error: 'provider_request_not_found' };
  }
  const requests = [];
  for (const record of records) requests.push(await project(record, false));
  return { ok: true, runId, retentionDays: PROVIDER_REQUEST_RETENTION_DAYS, requests };
}

/**
 * Loads a persisted request body actually sent to a provider. Prefer `runId`
 * from the context meter: a later internal curation/planner request is not the
 * agent's running chat context and must not win `/context full` selection.
 */
export async function latestProviderRequest({ traceSessionRoot, sessionId = 'default', runId = null, requestId = null } = {}) {
  if (!traceSessionRoot) throw new Error('trace_session_root_required');
  let entries;
  try { entries = await fs.readdir(traceSessionRoot, { withFileTypes: true }); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  const runs = (await Promise.all(entries.filter((entry) => entry.isDirectory()).map(async (entry) => {
    const runDir = path.join(traceSessionRoot, entry.name);
    try { return { runDir, name: entry.name, mtimeMs: (await fs.stat(runDir)).mtimeMs }; } catch { return null; }
  }))).filter(Boolean).sort((left, right) => (left.name === runId ? -1 : right.name === runId ? 1 : right.mtimeMs - left.mtimeMs));
  const nowMs = Date.now();
  for (const run of runs) {
    if (runId && run.name !== runId) continue;
    const requests = (await readJsonLines(path.join(run.runDir, 'model.jsonl')))
      .filter((record) => record?.runId === run.name && record?.sessionId === sessionId && record?.payload?.stage === 'model-request' && !isInternalRequest(record) && (!requestId || record.payload?.requestId === requestId))
      .reverse();
    for (const record of requests) {
      const capture = await captureForRecord(run.runDir, record, { includeBody: true, nowMs });
      if (capture.state === 'available') return { runId: record.runId, ts: record.ts, artifactPath: capture.artifactPath, payload: record.payload, body: capture.body };
    }
  }
  return null;
}
