import { randomUUID } from 'node:crypto';
import { openSettingsDatabase, settingsDatabasePath, withSettingsTransaction } from './settings-database.mjs';

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
function jobRow(row) { return row && { id: row.id, agentId: row.agent_id, name: row.name, prompt: row.prompt, cron: row.cron_expression, timezone: row.timezone, sessionId: row.session_id, enabled: Boolean(row.enabled), nextRunAt: row.next_run_at || null, lastRunAt: row.last_run_at || null, createdAt: row.created_at, updatedAt: row.updated_at }; }
function runRow(row) { return row && { id: row.id, jobId: row.job_id, scheduledFor: row.scheduled_for, status: row.status, agentId: row.agent_id, sessionId: row.session_id, runId: row.run_id || null, dispatchedAt: row.dispatched_at || null, completedAt: row.completed_at || null, traceDir: row.trace_dir || null, decision: row.decision || null, ok: row.ok === null ? null : Boolean(row.ok), error: row.error || null, result: parseJson(row.result_json), createdAt: row.created_at, updatedAt: row.updated_at }; }
function jobInput(input, { partial = false } = {}) { const result = {}; if (!partial || input.agentId !== undefined) result.agentId = id(input.agentId, 'scheduled_job_agent_id'); if (!partial || input.name !== undefined) { result.name = text(input.name); if (!result.name || result.name.length > 160) throw new Error('scheduled_job_name_invalid'); } if (!partial || input.prompt !== undefined) { result.prompt = text(input.prompt); if (!result.prompt || result.prompt.length > 20_000) throw new Error('scheduled_job_prompt_invalid'); } if (!partial || input.cron !== undefined) result.cron = parseCron(input.cron).expression; if (!partial || input.timezone !== undefined) { result.timezone = text(input.timezone); if (!validTimezone(result.timezone)) throw new Error('scheduled_job_timezone_invalid'); } if (input.sessionId !== undefined) { result.sessionId = text(input.sessionId) || 'default'; if (!/^[A-Za-z0-9._-]{1,96}$/.test(result.sessionId)) throw new Error('scheduled_job_session_id_invalid'); } if (input.enabled !== undefined) { if (typeof input.enabled !== 'boolean') throw new Error('scheduled_job_enabled_invalid'); result.enabled = input.enabled; } return result; }

export class ScheduledJobStore {
  constructor({ databasePath, clock = now } = {}) { this.db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() }); this.clock = clock; }
  close() { this.db.close(); }
  getJob(jobId) { return jobRow(this.db.prepare('SELECT * FROM scheduled_jobs WHERE id=?').get(id(jobId, 'scheduled_job_id'))); }
  listJobs({ agentId = null, enabled = null } = {}) { return this.db.prepare('SELECT * FROM scheduled_jobs WHERE (? IS NULL OR agent_id=?) AND (? IS NULL OR enabled=?) ORDER BY next_run_at IS NULL,next_run_at,name COLLATE NOCASE').all(agentId || null, agentId || null, enabled === null ? null : Number(Boolean(enabled)), enabled === null ? null : Number(Boolean(enabled))).map(jobRow); }
  createJob(input = {}) { const job = jobInput(input); const enabled = job.enabled === true; const timestamp = this.clock(); const jobId = input.id ? id(input.id, 'scheduled_job_id') : randomUUID(); const nextRunAt = enabled ? nextCronOccurrence(job.cron, job.timezone, new Date(timestamp)) : null; this.db.prepare('INSERT INTO scheduled_jobs (id,agent_id,name,prompt,cron_expression,timezone,session_id,enabled,next_run_at,last_run_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(jobId, job.agentId, job.name, job.prompt, job.cron, job.timezone, job.sessionId || 'default', Number(enabled), nextRunAt, null, timestamp, timestamp); return this.getJob(jobId); }
  updateJob(jobId, input = {}) { const current = this.getJob(jobId); if (!current) return null; const patch = jobInput(input, { partial: true }); const next = { ...current, ...patch }; const timestamp = this.clock(); const recompute = patch.cron !== undefined || patch.timezone !== undefined || patch.enabled !== undefined; const nextRunAt = !next.enabled ? null : (recompute ? nextCronOccurrence(next.cron, next.timezone, new Date(timestamp)) : current.nextRunAt); this.db.prepare('UPDATE scheduled_jobs SET agent_id=?,name=?,prompt=?,cron_expression=?,timezone=?,session_id=?,enabled=?,next_run_at=?,updated_at=? WHERE id=?').run(next.agentId, next.name, next.prompt, next.cron, next.timezone, next.sessionId || 'default', Number(next.enabled), nextRunAt, timestamp, current.id); return this.getJob(current.id); }
  deleteJob(jobId) { const current = this.getJob(jobId); if (!current) return null; this.db.prepare('DELETE FROM scheduled_jobs WHERE id=?').run(current.id); return current; }
  listRuns(jobId, { limit = 50 } = {}) { return this.db.prepare('SELECT * FROM scheduled_job_runs WHERE job_id=? ORDER BY scheduled_for DESC,created_at DESC LIMIT ?').all(id(jobId, 'scheduled_job_id'), Math.max(1, Math.min(Number(limit) || 50, 200))).map(runRow); }
  getRun(runId) { return runRow(this.db.prepare('SELECT * FROM scheduled_job_runs WHERE id=?').get(id(runId, 'scheduled_job_run_id'))); }
  createManualRun(jobId, { at = this.clock() } = {}) { const job = this.getJob(jobId); if (!job) return null; const runId = randomUUID(); this.db.prepare('INSERT INTO scheduled_job_runs (id,job_id,scheduled_for,status,agent_id,session_id,dispatched_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)').run(runId, job.id, at, 'running', job.agentId, job.sessionId, at, at, at); return this.getRun(runId); }
  markMissedRuns({ at = this.clock() } = {}) { const timestamp = String(at); const rows = this.db.prepare("SELECT id FROM scheduled_job_runs WHERE status='running'").all(); for (const row of rows) this.db.prepare("UPDATE scheduled_job_runs SET status='missed',completed_at=?,error='scheduler_restart_before_completion',updated_at=? WHERE id=?").run(timestamp, timestamp, row.id); return rows.length; }
  markMissedSchedules({ at = this.clock() } = {}) { const timestamp = new Date(at); const jobs = this.db.prepare('SELECT * FROM scheduled_jobs WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<? ORDER BY next_run_at').all(timestamp.toISOString()).map(jobRow); let missed = 0; for (const job of jobs) { let scheduledFor = job.nextRunAt; while (scheduledFor && new Date(scheduledFor) < timestamp) { const runId = randomUUID(); this.db.prepare("INSERT INTO scheduled_job_runs (id,job_id,scheduled_for,status,agent_id,session_id,completed_at,error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)").run(runId, job.id, scheduledFor, 'missed', job.agentId, job.sessionId, String(at), 'scheduler_restart_missed_schedule', String(at), String(at)); scheduledFor = nextCronOccurrence(job.cron, job.timezone, new Date(scheduledFor)); missed += 1; } this.db.prepare('UPDATE scheduled_jobs SET next_run_at=?,updated_at=? WHERE id=?').run(scheduledFor, String(at), job.id); } return missed; }
  claimDueJobs({ at = this.clock() } = {}) {
    const timestamp = new Date(at);
    return withSettingsTransaction(this.db, () => {
      const due = this.db.prepare('SELECT * FROM scheduled_jobs WHERE enabled=1 AND next_run_at IS NOT NULL AND next_run_at<=? ORDER BY next_run_at').all(timestamp.toISOString()).map(jobRow);
      const claimed = [];
      for (const job of due) {
        const scheduledFor = job.nextRunAt;
        const nextRunAt = nextCronOccurrence(job.cron, job.timezone, timestamp);
        const advanced = this.db.prepare('UPDATE scheduled_jobs SET next_run_at=?,last_run_at=?,updated_at=? WHERE id=? AND enabled=1 AND next_run_at=?').run(nextRunAt, at, at, job.id, scheduledFor);
        if (advanced.changes !== 1) continue;
        const active = this.db.prepare("SELECT id FROM scheduled_job_runs WHERE job_id=? AND status='running' LIMIT 1").get(job.id);
        const runId = randomUUID();
        const status = active ? 'skipped' : 'running';
        try {
          this.db.prepare('INSERT INTO scheduled_job_runs (id,job_id,scheduled_for,status,agent_id,session_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(runId, job.id, scheduledFor, status, job.agentId, job.sessionId, at, at);
        } catch (error) {
          if (/UNIQUE constraint failed/i.test(String(error?.message || error))) continue;
          throw error;
        }
        claimed.push({ job: this.getJob(job.id), run: this.getRun(runId), overlap: Boolean(active) });
      }
      return claimed;
    });
  }
  completeRun(runId, input = {}) { const current = this.getRun(runId); if (!current || current.status !== 'running') return current; const status = text(input.status) || (input.ok ? 'completed' : 'failed'); if (!RUN_STATUS.has(status) || ['running', 'missed', 'skipped'].includes(status)) throw new Error('scheduled_job_run_status_invalid'); const timestamp = this.clock(); this.db.prepare('UPDATE scheduled_job_runs SET status=?,run_id=?,dispatched_at=?,completed_at=?,trace_dir=?,decision=?,ok=?,error=?,result_json=?,updated_at=? WHERE id=?').run(status, input.runId || current.runId, input.dispatchedAt || current.dispatchedAt || current.createdAt, timestamp, input.traceDir || null, input.decision || null, input.ok === undefined ? null : Number(Boolean(input.ok)), input.error || null, json(input.result), timestamp, current.id); return this.getRun(current.id); }
  cancelRun(runId, reason = 'cancelled by operator') { return this.completeRun(runId, { status: 'cancelled', ok: false, error: text(reason).slice(0, 1000) || 'cancelled by operator' }); }
}
