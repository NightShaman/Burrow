import { randomUUID } from 'node:crypto';

export const SCHEDULED_JOB_RUN_STATUSES = Object.freeze(['running', 'completed', 'failed', 'cancelled', 'missed', 'skipped']);
const text = (value) => String(value ?? '').trim();
function cronField(value, min, max) {
  const source = text(value); if (!source) throw new Error('scheduled_job_cron_invalid'); const selected = new Set();
  for (const part of source.split(',')) {
    const [range, stepText] = part.split('/'); if (part.split('/').length > 2) throw new Error('scheduled_job_cron_invalid');
    const step = stepText === undefined ? 1 : Number(stepText); if (!Number.isInteger(step) || step < 1 || step > max - min + 1) throw new Error('scheduled_job_cron_invalid');
    let start = min; let end = max;
    if (range !== '*') { const match = /^(\d+)(?:-(\d+))?$/.exec(range); if (!match) throw new Error('scheduled_job_cron_invalid'); start = Number(match[1]); end = match[2] === undefined ? start : Number(match[2]); if (start < min || end > max || end < start) throw new Error('scheduled_job_cron_invalid'); }
    for (let item = start; item <= end; item += step) selected.add(item);
  }
  return selected;
}
export function parseCron(expression) { const fields = text(expression).split(/\s+/); if (fields.length !== 5) throw new Error('scheduled_job_cron_invalid'); return { expression: fields.join(' '), minute: cronField(fields[0], 0, 59), hour: cronField(fields[1], 0, 23), day: cronField(fields[2], 1, 31), month: cronField(fields[3], 1, 12), weekday: cronField(fields[4], 0, 6) }; }
// Bounded formatter cache: callers can supply arbitrary valid timezone aliases.
const formatters = new Map();
function formatter(timezone) {
  if (formatters.has(timezone)) return formatters.get(timezone);
  const value = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
  if (formatters.size >= 64) formatters.delete(formatters.keys().next().value);
  formatters.set(timezone, value);
  return value;
}
function localParts(date, timezone) {
  const values = Object.fromEntries(formatter(timezone).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return { year: Number(values.year), minute: Number(values.minute), hour: Number(values.hour), day: Number(values.day), month: Number(values.month), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday) };
}
export function cronMatches(expression, date, timezone) { const cron = typeof expression === 'string' ? parseCron(expression) : expression; const local = localParts(date, timezone); return cron.minute.has(local.minute) && cron.hour.has(local.hour) && cron.day.has(local.day) && cron.month.has(local.month) && cron.weekday.has(local.weekday); }
export function nextCronOccurrence(expression, timezone, from = new Date()) {
  const cron = typeof expression === 'string' ? parseCron(expression) : expression;
  const start = Math.floor(from.getTime() / 60_000) * 60_000 + 60_000;
  const limit = start + 366 * 86400_000;
  if (!Number.isFinite(start)) throw new Error('scheduled_job_next_run_unresolvable');
  formatter(timezone);
  // An IANA civil date is within one day of its UTC date (offset <24h).
  // Reject entire UTC days only when none of those three civil dates is
  // calendar-eligible. On eligible days scan UTC minutes: no assumptions
  // about transition times, offset granularity, gaps or repeated hours.
  // Sparse annual/impossible schedules therefore inspect days, not a year
  // of minutes; dense schedules return immediately as before.
  let candidate = start;
  while (candidate <= limit) {
    const midnight = Math.floor(candidate / 86400_000) * 86400_000;
    const eligible = [-1, 0, 1].some((delta) => {
      const date = new Date(midnight + delta * 86400_000);
      return cron.month.has(date.getUTCMonth() + 1) && cron.day.has(date.getUTCDate()) && cron.weekday.has(date.getUTCDay());
    });
    if (!eligible) { candidate = midnight + 86400_000; continue; }
    const end = Math.min(midnight + 86400_000 - 60_000, limit);
    while (candidate <= end) {
      if (cronMatches(cron, new Date(candidate), timezone)) return new Date(candidate).toISOString();
      candidate += 60_000;
    }
  }
  throw new Error('scheduled_job_next_run_unresolvable');
}
export function validateScheduledJobModel() { throw new Error('postgres_required'); }
// Compatibility export only; persistence requires the PostgreSQL store.
export class ScheduledJobStore {
  constructor() { throw new Error('postgres_required'); }
}
