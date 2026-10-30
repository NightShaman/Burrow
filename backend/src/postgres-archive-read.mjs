import { normalizePostgresPool, withPostgresTransaction } from './postgres-foundation.mjs';

// Interactive Archive work must not consume every connection needed by chat,
// health, or widgets. The gate belongs to the shared pool, not to a page/agent.
export const ARCHIVE_READ_TIMEOUT_MS = 15_000;
export const ARCHIVE_LOCK_TIMEOUT_MS = 1_000;
const gates = new WeakMap();
export const archiveReadTimeout = cause => Object.assign(new Error('archive_query_timeout', { cause }), { status: 504 });

export function archiveReadBudget({ signal, deadline, timeoutMs = ARCHIVE_READ_TIMEOUT_MS } = {}) {
  signal?.throwIfAborted();
  const end = Math.min(deadline ?? Infinity, performance.now() + timeoutMs);
  if (!Number.isFinite(end) || end <= performance.now()) throw archiveReadTimeout();
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(archiveReadTimeout()), Math.max(0, end - performance.now()));
  timer.unref?.();
  return { signal: controller.signal, deadline: end,
    dispose() { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
}

function acquire(pool, signal) {
  signal.throwIfAborted();
  let gate = gates.get(pool);
  if (!gate) {
    const max = Number(pool.options?.max) || 10;
    gate = { active: 0, limit: Math.max(1, Math.min(2, max - 1)), queue: [] };
    gates.set(pool, gate);
  }
  return new Promise((resolve, reject) => {
    const item = { start: null, abort: null };
    item.abort = () => {
      const index = gate.queue.indexOf(item);
      if (index !== -1) gate.queue.splice(index, 1);
      reject(signal.reason);
    };
    item.start = () => {
      signal.removeEventListener('abort', item.abort);
      if (signal.aborted) { reject(signal.reason); drain(); return; }
      gate.active++;
      let released = false;
      resolve(() => { if (released) return; released = true; gate.active--; drain(); });
    };
    function drain() { while (gate.active < gate.limit && gate.queue.length) gate.queue.shift().start(); }
    signal.addEventListener('abort', item.abort, { once: true });
    if (gate.active < gate.limit && !gate.queue.length) item.start();
    else gate.queue.push(item);
  });
}

// One owned checkout. CancelRequest and rollback settle before either the pool
// slot or gate permit is released; cancellation requires no second pool client.
// Legacy list count-cache writes are explicitly opted in, never made read-only.
export async function withArchiveRead(rawPool, work, options = {}) {
  const pool = normalizePostgresPool(rawPool);
  const budget = archiveReadBudget(options);
  let release;
  try {
    release = await acquire(pool, budget.signal);
    return await withPostgresTransaction(pool, async client => {
      await client.query(options.readOnly === false
        ? 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED'
        : 'SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query('SET LOCAL jit=off');
      const remaining = Math.ceil(budget.deadline - performance.now());
      if (remaining <= 0) throw archiveReadTimeout();
      await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true)",
        [String(remaining), String(Math.min(remaining, ARCHIVE_LOCK_TIMEOUT_MS))]);
      return work(client);
    }, budget);
  } catch (error) {
    if (budget.signal.aborted) throw budget.signal.reason;
    if (['57014', '55P03'].includes(error?.code) || error?.message === 'history_query_budget_exceeded') throw archiveReadTimeout(error);
    throw error;
  } finally { release?.(); budget.dispose(); }
}

export function archiveReadQuery(pool, sql, values, options = {}) {
  return withArchiveRead(pool, client => client.query(sql, values), options);
}
