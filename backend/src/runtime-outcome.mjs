// `ok` on a handled response is not sufficient evidence of completed work.
const NON_SUCCESS = new Set(['blocked', 'incomplete', 'cancelled', 'canceled', 'superseded', 'failed']);
export function classifyRuntimeOutcome(result = {}, { cancelled = false } = {}) {
  const decision = String(result.decision || '').toLowerCase();
  const status = String(result.status || '').toLowerCase();
  if (cancelled || ['cancelled', 'canceled'].includes(decision) || ['cancelled', 'canceled'].includes(status)) {
    return { ok: false, status: 'cancelled' };
  }
  const ok = result.ok === true && !NON_SUCCESS.has(decision) && !NON_SUCCESS.has(status);
  return { ok, status: ok ? 'completed' : 'failed' };
}
