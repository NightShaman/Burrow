import { boundaryDiagnostic } from './diagnostic-boundary.mjs';
import { operationalEvent } from './operational-log.mjs';
// One retained poll, drained before PostgreSQL shutdown. No overlapping ticks.
export function startOpenAiResetScheduler(poll, { intervalMs = 60_000, logger = console } = {}) {
  let stopped = false;
  let running = null;
  const tick = () => {
    if (stopped || running) return;
    running = Promise.resolve().then(poll).then(results => { for (const result of Array.isArray(results) ? results : []) if (result?.ok === false) operationalEvent(logger, 'openai_reset_poll_failed', boundaryDiagnostic(result.diagnostic || {}, 'scheduled_poll_result', 'openai_reset_poll_failed'), { component:'provider-usage' }); }).catch(error => { operationalEvent(logger, 'openai_reset_poll_failed', boundaryDiagnostic(error, 'scheduled_poll'), { component:'provider-usage' }); }).finally(() => { running = null; });
  };
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();
  return { stop() { stopped = true; clearInterval(timer); }, async close() { this.stop(); await running; } };
}
