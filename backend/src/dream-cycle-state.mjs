import { nextCronOccurrence } from './scheduled-job-store.mjs';

/** Purely reconcile persisted Dream scheduling state with current settings. */
export function reconciledDreamCycleState({ agentId, settings, current = {}, at }) {
  const enabled = settings?.enabled === true || settings?.enabled === 1;
  const cron = settings?.cron || settings?.cron_expression || '0 4 * * *';
  const timezone = settings?.timezone || 'UTC';
  const scheduleChanged = current.enabled !== enabled || current.cron !== cron || current.timezone !== timezone;
  return { version: 1, agentId, enabled, cron, timezone,
    nextRunAt: !enabled ? null : (scheduleChanged || !current.nextRunAt ? nextCronOccurrence(cron, timezone, new Date(at)) : current.nextRunAt),
    lastRunAt: current.lastRunAt || null, updatedAt: at };
}
