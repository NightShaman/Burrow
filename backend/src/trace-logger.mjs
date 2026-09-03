import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function nowIso() {
  return new Date().toISOString();
}

function safeId(value) {
  return String(value || '')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120) || randomUUID();
}

function jsonLine(value) {
  return `${JSON.stringify(value)}\n`;
}

// Trace events are operational evidence, not a second unbounded copy of a
// session, subagent record, or tool artifact. Large evidence belongs in
// its artifact/receipt file; keeping it inline makes trace polling and the
// aggregate events.jsonl file grow geometrically.
const TRACE_PAYLOAD_CHAR_BUDGET = 96_000;
const TRACE_STRING_CHAR_BUDGET = 8_000;
const TRACE_ARRAY_ITEM_BUDGET = 40;
const TRACE_OBJECT_KEY_BUDGET = 60;
const TRACE_DEPTH_BUDGET = 10;

function boundedTraceValue(value, state, depth = 0) {
  if (value === null || value === undefined || typeof value === 'boolean' || typeof value === 'number') return value;
  if (state.remaining <= 0) return '[trace payload truncated]';
  if (typeof value === 'string') {
    const limit = Math.max(0, Math.min(TRACE_STRING_CHAR_BUDGET, state.remaining));
    state.remaining -= Math.min(value.length, limit);
    return value.length > limit ? `${value.slice(0, limit)}… [${value.length - limit} chars omitted]` : value;
  }
  if (depth >= TRACE_DEPTH_BUDGET) return '[trace payload depth truncated]';
  if (Array.isArray(value)) {
    const items = value.slice(0, TRACE_ARRAY_ITEM_BUDGET).map((item) => boundedTraceValue(item, state, depth + 1));
    if (value.length > TRACE_ARRAY_ITEM_BUDGET) items.push(`[${value.length - TRACE_ARRAY_ITEM_BUDGET} items omitted]`);
    return items;
  }
  if (typeof value === 'object') {
    const result = {};
    let count = 0;
    let omitted = false;
    for (const key in value) {
      if (!Object.hasOwn(value, key)) continue;
      if (count >= TRACE_OBJECT_KEY_BUDGET || state.remaining <= 0) { omitted = true; break; }
      count += 1;
      try { result[key] = boundedTraceValue(value[key], state, depth + 1); }
      catch { result[key] = '[trace field unreadable]'; }
    }
    if (omitted) result.__traceTruncated = 'keys or aggregate content omitted';
    return result;
  }
  return String(value);
}

export function compactTracePayload(payload = {}) {
  return boundedTraceValue(payload, { remaining: TRACE_PAYLOAD_CHAR_BUDGET });
}

export function createTraceLogger({ rootDir, runId, sessionId, clock = nowIso, onRecord = null } = {}) {
  if (!rootDir) throw new Error('rootDir is required');
  const resolvedRunId = safeId(runId || `${clock()}-${randomUUID()}`);
  const traceDir = path.join(rootDir, resolvedRunId);
  let toolSequence = 0;

  async function ensureDir() {
    await fs.mkdir(traceDir, { recursive: true });
    await fs.mkdir(path.join(traceDir, 'artifacts'), { recursive: true });
  }

  async function append(fileName, event) {
    await ensureDir();
    const record = {
      ts: clock(),
      runId: resolvedRunId,
      sessionId: sessionId || null,
      ...event,
      ...(event.payload === undefined ? {} : { payload: compactTracePayload(event.payload) }),
    };
    const filePath = path.join(traceDir, fileName);
    await fs.appendFile(filePath, jsonLine(record), 'utf8');
    await fs.appendFile(path.join(traceDir, 'events.jsonl'), jsonLine({ ...record, stream: fileName }), 'utf8');
    // Observers are transport-only. Trace persistence remains authoritative.
    // Never await an observer here: a stalled UI/A2A progress projection must
    // not strand the run between a persisted plan and its tool dispatch.
    try {
      const notification = onRecord?.({ ...record, stream: fileName });
      if (notification && typeof notification.then === 'function') void notification.catch(() => {});
    } catch {}
    return record;
  }

  async function event(type, payload = {}) {
    return append('events-stream.jsonl', { type, payload });
  }

  async function router(payload = {}) {
    return append('router.jsonl', { type: 'router', payload });
  }

  async function memory(payload = {}) {
    return append('memory.jsonl', { type: 'memory', payload });
  }

  async function model(payload = {}) {
    return append('model.jsonl', { type: 'model', payload });
  }

  async function tool(payload = {}) {
    return append('tool-calls.jsonl', { type: 'tool', payload });
  }

  async function toolStart(payload = {}) {
    const activityId = safeId(payload.activityId || `tool-${++toolSequence}-${randomUUID().slice(0, 8)}`);
    return tool({ ...payload, activityId, phase: 'start' });
  }

  async function toolEnd(payload = {}) {
    return tool({ ...payload, phase: 'result' });
  }

  async function verifier(payload = {}) {
    return append('verifier.jsonl', { type: 'verifier', payload });
  }

  async function artifact(name, content, { encoding = 'utf8' } = {}) {
    await ensureDir();
    const cleanName = safeId(name);
    const filePath = path.join(traceDir, 'artifacts', cleanName);
    await fs.writeFile(filePath, content, encoding);
    await event('artifact', { name: cleanName, path: filePath });
    return filePath;
  }

  return {
    rootDir,
    runId: resolvedRunId,
    traceDir,
    event,
    router,
    memory,
    model,
    tool,
    toolStart,
    toolEnd,
    verifier,
    artifact,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const rootDir = process.argv[2] || process.cwd();
  const logger = createTraceLogger({ rootDir, runId: process.argv[3] || 'manual-smoke' });
  await logger.event('smoke', { ok: true });
  await logger.tool({ tool: 'manual', ok: true, stdout: 'hello trace' });
  console.log(JSON.stringify({ runId: logger.runId, traceDir: logger.traceDir }, null, 2));
}
