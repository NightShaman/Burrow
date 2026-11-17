import { boundaryDiagnostic } from './diagnostic-boundary.mjs';
import { operationalEvent, operationalId } from './operational-log.mjs';
import { safeOperationalError } from './runtime-server-log.mjs';
// One retained poll, drained before PostgreSQL shutdown. No overlapping ticks.
const RESET_STAGES = new Set(['reset_inventory', 'reset_inventory_json', 'reset_ledger_reconcile',
  'reset_ledger_claim', 'reset_ledger_settle', 'reset_consume', 'reset_consume_json', 'reset_poll']);
const boundedCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : undefined;
function resultDiagnostic(result) {
  const diagnostic = result?.diagnostic && typeof result.diagnostic === 'object' ? result.diagnostic : {};
  const connectionId = operationalId(result?.connectionId);
  const projected = safeOperationalError({ ...diagnostic, errorCode: diagnostic.errorCode || result?.error }, 'openai_reset_poll_failed');
  const resultStatus = Number.isInteger(result?.status) && result.status >= 400 && result.status <= 599 ? result.status : undefined;
  const httpStatus = Number.isInteger(diagnostic.httpStatus) && diagnostic.httpStatus >= 100 && diagnostic.httpStatus <= 599 ? diagnostic.httpStatus : undefined;
  return { errorCode: projected.errorCode, errorType: projected.errorType,
    stage: RESET_STAGES.has(diagnostic.stage) ? diagnostic.stage : 'scheduled_poll_result',
    ...(httpStatus ? { httpStatus } : {}), ...(resultStatus ? { resultStatus } : {}),
    ...(boundedCount(result?.pendingCount) !== undefined ? { pendingCount: boundedCount(result.pendingCount) } : {}),
    ...(boundedCount(result?.unobservedPendingCount) !== undefined ? { unobservedPendingCount: boundedCount(result.unobservedPendingCount) } : {}),
    ...(result?.redemptionResultKnown === true ? { redemptionResultKnown: true } : {}),
    ...(['reset', 'nothing_to_reset', 'no_credit', 'already_redeemed'].includes(result?.redemptionResult) ? { redemptionResult: result.redemptionResult } : {}),
    ...(result?.ambiguous === true ? { ambiguous: true } : {}),
    ...(result?.outcomeRecorded === false ? { outcomeRecorded: false } : {}),
    ...(connectionId ? { connectionId } : {}),
    ...(result?.causeDiagnostic && typeof result.causeDiagnostic === 'object' ? {
      causeErrorCode: safeOperationalError(result.causeDiagnostic, 'operation_failed').errorCode,
      causeErrorType: safeOperationalError(result.causeDiagnostic, 'operation_failed').errorType,
      causeStage: RESET_STAGES.has(result.causeDiagnostic.stage) ? result.causeDiagnostic.stage : 'reset_consume',
      ...(Number.isInteger(result.causeDiagnostic.httpStatus) && result.causeDiagnostic.httpStatus >= 100 && result.causeDiagnostic.httpStatus <= 599 ? { upstreamStatus: result.causeDiagnostic.httpStatus } : {}),
    } : {}) };
}
export function startOpenAiResetScheduler(poll, { intervalMs = 60_000, logger = console } = {}) {
  let stopped = false;
  let running = null;
  const tick = () => {
    if (stopped || running) return;
    running = Promise.resolve().then(poll).then(results => { for (const result of Array.isArray(results) ? results : []) if (result?.ok === false || result?.outcomeRecorded === false) operationalEvent(logger, 'openai_reset_poll_failed', resultDiagnostic(result), { component: 'provider-usage' }); }).catch(error => { operationalEvent(logger, 'openai_reset_poll_failed', boundaryDiagnostic(error, 'reset_poll', 'openai_reset_poll_failed'), { component: 'provider-usage' }); }).finally(() => { running = null; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return { stop() { stopped = true; clearInterval(timer); }, async close() { this.stop(); await running; } };
}
