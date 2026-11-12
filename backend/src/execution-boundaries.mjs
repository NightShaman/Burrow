import { Worker } from 'node:worker_threads';

export const EXECUTION_BOUNDARIES_META_KEY = 'execution_boundaries';
export const BOUNDARY_OPERATIONS = Object.freeze(['read', 'write', 'delete', 'execute', 'delegate']);
export const BOUNDARY_TYPES = Object.freeze(['path', 'command']);
export const BOUNDARY_MATCHES = Object.freeze(['exact', 'prefix', 'glob', 'regex', 'contains']);

const OPERATION_SET = new Set(BOUNDARY_OPERATIONS);
const TYPE_SET = new Set(BOUNDARY_TYPES);
const MATCH_SET = new Set(BOUNDARY_MATCHES);

function text(value) { return String(value || '').trim(); }
function asArray(value) { return Array.isArray(value) ? value : []; }
function unique(values = []) { return [...new Set(asArray(values).filter(Boolean))]; }
function safeId(value) { return text(value).replace(/[^a-zA-Z0-9_.:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120); }

export function emptyExecutionBoundaries() { return { version: 1, hardBlocks: [] }; }

function normalizeRule(rule = {}, index = 0, errors = []) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    errors.push(`hardBlocks.${index}_must_be_object`);
    return null;
  }
  const id = safeId(rule.id || rule.name);
  const type = text(rule.type).toLowerCase();
  const pattern = text(rule.pattern);
  const match = text(rule.match || (type === 'command' ? 'regex' : 'glob')).toLowerCase();
  const operations = unique(asArray(rule.operations).map((item) => text(item).toLowerCase()).filter(Boolean));
  if (!id) errors.push(`hardBlocks.${index}.id_required`);
  if (!TYPE_SET.has(type)) errors.push(`hardBlocks.${index}.type_invalid`);
  if (!pattern) errors.push(`hardBlocks.${index}.pattern_required`);
  if (!MATCH_SET.has(match)) errors.push(`hardBlocks.${index}.match_invalid`);
  if (!operations.length) errors.push(`hardBlocks.${index}.operations_required`);
  for (const op of operations) if (!OPERATION_SET.has(op)) errors.push(`hardBlocks.${index}.operations_invalid:${op}`);
  if (rule.enabled !== undefined && typeof rule.enabled !== 'boolean') errors.push(`hardBlocks.${index}.enabled_must_be_boolean`);
  if (rule.reason !== undefined && rule.reason !== null && typeof rule.reason !== 'string') errors.push(`hardBlocks.${index}.reason_must_be_string`);
  if (match === 'regex' && pattern) {
    try { new RegExp(pattern); } catch { errors.push(`hardBlocks.${index}.pattern_regex_invalid`); }
  }
  if (!id || !TYPE_SET.has(type) || !pattern || !MATCH_SET.has(match) || !operations.length || operations.some((op) => !OPERATION_SET.has(op))) return null;
  return {
    id,
    enabled: rule.enabled !== false,
    type,
    pattern,
    match,
    operations,
    ...(text(rule.reason) ? { reason: text(rule.reason) } : {}),
  };
}

export function validateExecutionBoundaries(input = {}) {
  const source = input?.boundaries && typeof input.boundaries === 'object' ? input.boundaries : input;
  const errors = [];
  const rawRules = source?.hardBlocks ?? [];
  if (!Array.isArray(rawRules)) return { ok: false, errors: ['hardBlocks_must_be_array'], boundaries: emptyExecutionBoundaries() };
  const seen = new Set();
  const hardBlocks = [];
  rawRules.forEach((rule, index) => {
    const normalized = normalizeRule(rule, index, errors);
    if (!normalized) return;
    if (seen.has(normalized.id)) {
      errors.push(`hardBlocks.${index}.id_duplicate`);
      return;
    }
    seen.add(normalized.id);
    hardBlocks.push(normalized);
  });
  return { ok: errors.length === 0, errors, boundaries: { version: 1, hardBlocks } };
}

export async function readExecutionBoundaries({ metadataStore } = {}) {
  if (!metadataStore?.get) throw new Error('execution_boundaries_metadata_store_required');
  const stored = await metadataStore.get(EXECUTION_BOUNDARIES_META_KEY);
  const checked = validateExecutionBoundaries(stored || emptyExecutionBoundaries());
  return checked.ok ? checked.boundaries : emptyExecutionBoundaries();
}

export async function saveExecutionBoundaries(input = {}, { metadataStore } = {}) {
  if (!metadataStore?.set) throw new Error('execution_boundaries_metadata_store_required');
  const checked = validateExecutionBoundaries(input);
  if (!checked.ok) return { ok: false, status: 400, errors: checked.errors, boundaries: checked.boundaries };
  await metadataStore.set(EXECUTION_BOUNDARIES_META_KEY, checked.boundaries);
  return { ok: true, boundaries: checked.boundaries, validation: { ok: true, errors: [] } };
}

// A wall-clock evaluation budget, not a pattern/target content cap. Include
// worker startup and all rules/targets so pathological JS regexes (or globs)
// cannot monopolize the main loop. Trusted callers may supply a different
// budget; an existing monotonic request deadline and cancellation win earlier.
export const DEFAULT_BOUNDARY_EVALUATION_TIMEOUT_MS = 1000;

function evaluationFailure(status, timeoutMs) {
  return { ok: false, blockers: [`blast_radius:hard_policy_block:execution_boundary_evaluation_${status}`], matches: [], evaluation: { status, timeoutMs } };
}

export async function evaluateExecutionBoundaries({ boundaries = null, operation = null, command = '', paths = [], baseRoot = null, signal = null, deadline = null, timeoutMs = DEFAULT_BOUNDARY_EVALUATION_TIMEOUT_MS } = {}) {
  const budget = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_BOUNDARY_EVALUATION_TIMEOUT_MS;
  const end = Math.min(performance.now() + budget, Number.isFinite(deadline) ? deadline : Infinity);
  const remaining = end - performance.now();
  if (signal?.aborted) return evaluationFailure('cancelled', budget);
  if (remaining <= 0) return evaluationFailure('timeout', budget);
  // No matching work exists in this case. Do not start a worker for the default
  // empty policy, but do not treat malformed/nonempty policies as empty.
  const source = boundaries?.boundaries && typeof boundaries.boundaries === 'object' ? boundaries.boundaries : boundaries;
  if (boundaries == null || (Array.isArray(source?.hardBlocks) && source.hardBlocks.length === 0)) return { ok: true, blockers: [], matches: [] };

  let worker;
  let timer;
  let onAbort;
  try {
    return await new Promise((resolve) => {
      let settled = false;
      const finish = async (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        // Await actual termination even after timeout/error/success: no stuck
        // matching worker may survive a returned safety review.
        try { await worker?.terminate(); }
        catch { result = evaluationFailure('worker_error', budget); }
        resolve(result);
      };
      onAbort = () => { void finish(evaluationFailure('cancelled', budget)); };
      try {
        worker = new Worker(new URL('./execution-boundary-worker.mjs', import.meta.url), {
          workerData: { boundaries, operation, command, paths, baseRoot },
        });
        worker.once('message', (result) => { void finish(performance.now() >= end ? evaluationFailure('timeout', budget) : signal?.aborted ? evaluationFailure('cancelled', budget) : result); });
        worker.once('error', () => { void finish(evaluationFailure('worker_error', budget)); });
        worker.once('exit', () => { void finish(evaluationFailure('worker_error', budget)); });
        timer = setTimeout(() => { void finish(evaluationFailure('timeout', budget)); }, Math.max(1, end - performance.now()));
        signal?.addEventListener('abort', onAbort, { once: true });
        if (signal?.aborted) onAbort();
      } catch {
        void finish(evaluationFailure('worker_error', budget));
      }
    });
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    worker?.removeAllListeners();
  }
}

export function executionBoundaryStatus(boundaries = null) {
  const checked = validateExecutionBoundaries(boundaries || emptyExecutionBoundaries());
  const hardBlocks = checked.boundaries.hardBlocks;
  return { enabled: hardBlocks.some((rule) => rule.enabled), hardBlockCount: hardBlocks.length, enabledHardBlockCount: hardBlocks.filter((rule) => rule.enabled).length, hardBlocks };
}
