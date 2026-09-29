import { randomUUID } from 'node:crypto';

export const SCHEDULED_JOB_RUN_STATUSES = Object.freeze(['running', 'completed', 'failed', 'cancelled', 'missed', 'skipped']);
const RUN_STATUS = new Set(SCHEDULED_JOB_RUN_STATUSES);
const text = (value) => String(value ?? '').trim();
const now = () => new Date().toISOString();
const json = (value) => JSON.stringify(value || {});
const parseJson = (value) => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
const id = (value, field) => { const result = text(value); if (!/^[A-Za-z0-9._-]{1,96}$/.test(result)) throw new Error(`${field}_invalid`); return result; };

function validTimezone(timezone) { try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); return true; } catch { return false; } }
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
function localParts(date, timezone) { const values = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' }).formatToParts(date).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value])); return { minute: Number(values.minute), hour: Number(values.hour), day: Number(values.day), month: Number(values.month), weekday: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(values.weekday) }; }
export function cronMatches(expression, date, timezone) { const cron = typeof expression === 'string' ? parseCron(expression) : expression; const local = localParts(date, timezone); return cron.minute.has(local.minute) && cron.hour.has(local.hour) && cron.day.has(local.day) && cron.month.has(local.month) && cron.weekday.has(local.weekday); }
export function nextCronOccurrence(expression, timezone, from = new Date()) { const cron = typeof expression === 'string' ? parseCron(expression) : expression; let candidate = new Date(Math.floor(from.getTime() / 60_000) * 60_000 + 60_000); const limit = candidate.getTime() + 366 * 24 * 60 * 60_000; while (candidate.getTime() <= limit) { if (cronMatches(cron, candidate, timezone)) return candidate.toISOString(); candidate = new Date(candidate.getTime() + 60_000); } throw new Error('scheduled_job_next_run_unresolvable'); }
function jobRow(row) { return row && { id: row.id, ownerModId: row.owner_mod_id || null, agentId: row.agent_id, name: row.name, prompt: row.prompt, cron: row.cron_expression, timezone: row.timezone, sessionId: row.session_id, modelConnectionId: row.model_connection_id || null, model: row.model || null, enabled: Boolean(row.enabled), nextRunAt: row.next_run_at || null, lastRunAt: row.last_run_at || null, createdAt: row.created_at, updatedAt: row.updated_at }; }
function runRow(row) { return row && { id: row.id, jobId: row.job_id, scheduledFor: row.scheduled_for, status: row.status, agentId: row.agent_id, sessionId: row.session_id, runId: row.run_id || null, dispatchedAt: row.dispatched_at || null, completedAt: row.completed_at || null, traceDir: row.trace_dir || null, decision: row.decision || null, ok: row.ok === null ? null : Boolean(row.ok), error: row.error || null, result: parseJson(row.result_json), createdAt: row.created_at, updatedAt: row.updated_at }; }
function modelOverride(input) {
  if (input.modelConnectionId === undefined && input.model === undefined) return {};
  if (input.modelConnectionId === undefined || input.model === undefined) throw new Error('scheduled_job_model_pair_required');
  if (input.modelConnectionId === null && input.model === null) return { modelConnectionId: null, model: null };
  if (typeof input.modelConnectionId !== 'string' || typeof input.model !== 'string' || !text(input.modelConnectionId) || !text(input.model) || input.modelConnectionId.length > 256 || input.model.length > 256) throw new Error('scheduled_job_model_pair_required');
  return { modelConnectionId: text(input.modelConnectionId), model: text(input.model) };
}

export function validateScheduledJobModel() { throw new Error('postgres_required'); }
function jobInput(input, { partial = false } = {}) { const result = modelOverride(input); if (!partial || input.agentId !== undefined) result.agentId = id(input.agentId, 'scheduled_job_agent_id'); if (!partial || input.name !== undefined) { result.name = text(input.name); if (!result.name || result.name.length > 160) throw new Error('scheduled_job_name_invalid'); } if (!partial || input.prompt !== undefined) { result.prompt = text(input.prompt); if (!result.prompt || result.prompt.length > 20_000) throw new Error('scheduled_job_prompt_invalid'); } if (!partial || input.cron !== undefined) result.cron = parseCron(input.cron).expression; if (!partial || input.timezone !== undefined) { result.timezone = text(input.timezone); if (!validTimezone(result.timezone)) throw new Error('scheduled_job_timezone_invalid'); } if (input.sessionId !== undefined) { result.sessionId = text(input.sessionId) || 'default'; if (!/^[A-Za-z0-9._-]{1,96}$/.test(result.sessionId)) throw new Error('scheduled_job_session_id_invalid'); } if (input.enabled !== undefined) { if (typeof input.enabled !== 'boolean') throw new Error('scheduled_job_enabled_invalid'); result.enabled = input.enabled; } return result; }

// Compatibility export only; persistence requires the PostgreSQL store.
export class ScheduledJobStore {
  constructor() { throw new Error('postgres_required'); }
}
