import { classifyRuntimeOutcome } from './runtime-outcome.mjs';
import { normalizePostgresPool } from './postgres-foundation.mjs';
import { operatorTimezone } from './timezone.mjs';
import { PostgresSettingsMetadataStore } from './postgres-settings-metadata-store.mjs';
import { randomUUID } from "node:crypto";
import {
  parseCron,
  cronMatches,
  nextCronOccurrence,
  scheduledRunInstant,
} from "./scheduled-job-store.mjs";
export { parseCron, cronMatches, nextCronOccurrence };
import {
  closePostgresPool,
  withPostgresTransaction,
} from "./postgres-foundation.mjs";

export const SCHEDULED_JOB_RUN_STATUSES = Object.freeze([
  "running",
  "completed",
  "failed",
  "cancelled",
  "missed",
  "skipped",
]);
const RUN_STATUS = new Set(SCHEDULED_JOB_RUN_STATUSES);
const text = (value) => String(value ?? "").trim();
const at = (value) =>
  value instanceof Date ? value.toISOString() : String(value);
const json = (value) => JSON.stringify(value || {});
const parseJson = (value) => {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(value || "{}");
  } catch {
    return {};
  }
};
const id = (value, field) => {
  const result = text(value);
  if (!/^[A-Za-z0-9._-]{1,96}$/.test(result))
    throw new Error(`${field}_invalid`);
  return result;
};
const timestamp = (clock) => clock();
function jobRow(row) {
  return (
    row && {
      id: row.id,
      ownerModId: row.owner_mod_id || null,
      agentId: row.agent_id,
      name: row.name,
      prompt: row.prompt,
      jobKind: row.job_kind || 'prompt',
      taskId: row.task_id || null,
      extraInstructions: row.extra_instructions || '',
      scheduleKind: row.schedule_kind || 'cron',
      runAt: row.run_at ? at(row.run_at) : null,
      consumedAt: row.consumed_at ? at(row.consumed_at) : null,
      lastRun: row.last_run ? runRow(row.last_run) : null,
      cron: row.cron_expression,
      timezone: null,
      sessionId: row.session_id,
      contextMode: row.context_mode || 'continue',
      modelConnectionId: row.model_connection_id || null,
      model: row.model || null,
      enabled: Boolean(row.enabled),
      nextRunAt: row.next_run_at ? at(row.next_run_at) : null,
      lastRunAt: row.last_run_at ? at(row.last_run_at) : null,
      createdAt: at(row.created_at),
      updatedAt: at(row.updated_at),
    }
  );
}
function runRow(row) {
  return (
    row && {
      id: row.id,
      jobId: row.job_id,
      taskId: row.task_id || null,
      scheduledFor: at(row.scheduled_for),
      status: row.status,
      agentId: row.agent_id,
      sessionId: row.session_id,
      runId: row.run_id || null,
      dispatchedAt: row.dispatched_at ? at(row.dispatched_at) : null,
      completedAt: row.completed_at ? at(row.completed_at) : null,
      traceDir: row.trace_dir || null,
      decision: row.decision || null,
      ok: row.ok === null || row.ok === undefined ? null : Boolean(row.ok),
      error: row.error || null,
      result: parseJson(row.result_json),
      createdAt: at(row.created_at),
      updatedAt: at(row.updated_at),
    }
  );
}
function modelOverride(input) {
  if (input.modelConnectionId === undefined && input.model === undefined)
    return {};
  if (input.modelConnectionId === undefined || input.model === undefined)
    throw new Error("scheduled_job_model_pair_required");
  if (input.modelConnectionId === null && input.model === null)
    return { modelConnectionId: null, model: null };
  if (
    typeof input.modelConnectionId !== "string" ||
    typeof input.model !== "string" ||
    !text(input.modelConnectionId) ||
    !text(input.model) ||
    input.modelConnectionId.length > 256 ||
    input.model.length > 256
  )
    throw new Error("scheduled_job_model_pair_required");
  return {
    modelConnectionId: text(input.modelConnectionId),
    model: text(input.model),
  };
}
function jobInput(input, { timezone = 'UTC' } = {}) {
  const result = modelOverride(input);
  result.agentId = id(input.agentId, 'scheduled_job_agent_id');
  result.name = text(input.name);
  if (!result.name || result.name.length > 160) throw new Error('scheduled_job_name_invalid');
  result.jobKind = input.jobKind ?? 'prompt';
  if (!['prompt', 'task'].includes(result.jobKind)) throw new Error('scheduled_job_kind_invalid');
  result.scheduleKind = input.scheduleKind ?? 'cron';
  if (!['cron', 'once'].includes(result.scheduleKind)) throw new Error('scheduled_job_schedule_kind_invalid');
  result.contextMode = input.contextMode ?? 'continue';
  if (!['continue', 'fresh'].includes(result.contextMode)) throw new Error('scheduled_job_context_mode_invalid');
  result.sessionId = text(input.sessionId) || 'default';
  if (!/^[A-Za-z0-9._-]{1,96}$/.test(result.sessionId)) throw new Error('scheduled_job_session_id_invalid');
  result.prompt = result.jobKind === 'prompt' ? text(input.prompt) : '';
  if ((result.jobKind === 'prompt' && !result.prompt) || result.prompt.length > 20000) throw new Error('scheduled_job_prompt_invalid');
  result.taskId = result.jobKind === 'task' ? id(input.taskId, 'scheduled_job_task_id') : null;
  result.extraInstructions = result.jobKind === 'task' ? text(input.extraInstructions) : '';
  if (result.extraInstructions.length > 20000) throw new Error('scheduled_job_extra_instructions_invalid');
  if (result.jobKind === 'task') { result.sessionId = 'default'; result.contextMode = 'continue'; }
  if (result.contextMode === 'fresh' && result.sessionId === 'default') throw new Error('context_boundary_named_session_required');
  result.cron = result.scheduleKind === 'cron' ? parseCron(input.cron).expression : null;
  result.runAt = result.scheduleKind === 'once' ? scheduledRunInstant(input.runAt, timezone) : null;
  result.timezone = null; // legacy overrides are accepted but never authoritative
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('scheduled_job_enabled_invalid');
  result.enabled = input.enabled === true;
  return result;
}
const JOB_SELECT = `SELECT j.*, (SELECT json_build_object(
 'id',r.id,'job_id',r.job_id,'task_id',r.task_id,'agent_id',r.agent_id,'session_id',r.session_id,'run_id',r.run_id,
 'status',r.status,'ok',r.ok,'error',left(r.error,2000),'decision',r.decision,
 'scheduled_for',r.scheduled_for,'dispatched_at',r.dispatched_at,'completed_at',r.completed_at,'created_at',r.created_at,'updated_at',r.updated_at
) FROM scheduled_job_runs r WHERE r.job_id=j.id ORDER BY r.created_at DESC,r.scheduled_for DESC,r.id DESC LIMIT 1) AS last_run FROM scheduled_jobs j`;
function nextOccurrence(job, timezone, from, consumedAt = null) {
  return !job.enabled ? null : job.scheduleKind === 'once' ? (consumedAt ? null : job.runAt) : nextCronOccurrence(job.cron, timezone, new Date(from));
}

export const POSTGRES_SCHEDULED_JOB_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS scheduled_jobs (id TEXT PRIMARY KEY, owner_mod_id TEXT, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, name TEXT NOT NULL, prompt TEXT NOT NULL, cron_expression TEXT NOT NULL, timezone TEXT NOT NULL, session_id TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT FALSE, next_run_at TIMESTAMPTZ, last_run_at TIMESTAMPTZ, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, model_connection_id TEXT, model TEXT);
CREATE INDEX IF NOT EXISTS scheduled_jobs_due_idx ON scheduled_jobs (next_run_at) WHERE enabled;
CREATE TABLE IF NOT EXISTS scheduled_job_runs (id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE, scheduled_for TIMESTAMPTZ NOT NULL, status TEXT NOT NULL CHECK (status IN ('running','completed','failed','cancelled','missed','skipped')), agent_id TEXT NOT NULL, session_id TEXT NOT NULL, run_id TEXT, dispatched_at TIMESTAMPTZ, completed_at TIMESTAMPTZ, trace_dir TEXT, decision TEXT, ok BOOLEAN, error TEXT, result_json JSONB NOT NULL DEFAULT '{}'::jsonb, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, UNIQUE (job_id, scheduled_for));
CREATE INDEX IF NOT EXISTS scheduled_job_runs_job_idx ON scheduled_job_runs (job_id, scheduled_for DESC, created_at DESC);
`;
export const SCHEDULED_JOB_SCHEMA_SQL = POSTGRES_SCHEDULED_JOB_SCHEMA_SQL;

export class PostgresScheduledJobStore {
  constructor({
    pool,
    ownsPool = false,
    clock = () => new Date().toISOString(),
  } = {}) {
    if (!pool?.query || !pool?.connect)
      throw new Error("scheduled_job_postgres_pool_required");
    this.pool = normalizePostgresPool(pool);
    this.ownsPool = ownsPool;
    this.clock = clock;
  }
  async effective(timezone, client = this.pool) { return await operatorTimezone(new PostgresSettingsMetadataStore({ pool: client })); }
  async resolved(row, client = this.pool) { const job = jobRow(row); return job && { ...job, effectiveTimezone: await this.effective(job.timezone, client) }; }
  async reconcileInherited(client, at) {
    const zone = await this.effective(null, client);
    const rows = await client.query('SELECT * FROM scheduled_jobs WHERE effective_timezone IS DISTINCT FROM $1 ORDER BY id FOR UPDATE', [zone]);
    for (const row of rows.rows) {
      if (row.effective_timezone === zone) continue;
      const next = nextOccurrence(jobRow(row), zone, at, row.consumed_at);
      await client.query('UPDATE scheduled_jobs SET effective_timezone=$1,next_run_at=$2 WHERE id=$3', [zone, next, row.id]);
    }
  }
  async close() {
    if (this.ownsPool) await closePostgresPool(this.pool);
  }
  async validateModel(job, queryable = this.pool) {
    if (!job.modelConnectionId && !job.model) return;
    if (!job.modelConnectionId || !job.model)
      throw new Error("scheduled_job_model_pair_required");
    const result = await queryable.query(
      "SELECT models_json::text AS models_json FROM model_connections WHERE id=$1",
      [job.modelConnectionId],
    );
    const models = parseJson(result.rows[0]?.models_json);
    if (
      !Array.isArray(models) ||
      !models.some(
        (model) => model.id === job.model && model.selected !== false,
      )
    )
      throw new Error("scheduled_job_model_unavailable");
  }
  async getJob(jobId) {
    const result = await this.pool.query(
      `${JOB_SELECT} WHERE j.id=$1`,
      [id(jobId, "scheduled_job_id")],
    );
    return this.resolved(result.rows[0]);
  }
  async listJobs({
    agentId = null,
    enabled = null,
    ownerModId = undefined,
    limit = null,
    offset = 0,
  } = {}) {
    const args = [];
    const where = [];
    if (ownerModId !== undefined) {
      where.push(
        ownerModId === null
          ? "owner_mod_id IS NULL"
          : `owner_mod_id=$${args.push(id(ownerModId, "scheduled_job_owner_mod_id"))}`,
      );
    }
    if (agentId) {
      const n = args.push(agentId);
      where.push(`agent_id=$${n}`);
    }
    if (enabled !== null) {
      const n = args.push(Boolean(enabled));
      where.push(`enabled=$${n}`);
    }
    let sql = `${JOB_SELECT}${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY next_run_at IS NULL,next_run_at,translate(name,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C",id`;
    if (limit !== null) {
      sql += ` LIMIT $${args.push(Math.max(1, Math.min(Number(limit) || 50, 101)))} OFFSET $${args.push(Math.max(0, Number(offset) || 0))}`;
    }
    const result = await this.pool.query(sql, args);
    return Promise.all(result.rows.map(row => this.resolved(row)));
  }
  async getOwnedJob(ownerModId, jobId) {
    const result = await this.pool.query(
      `${JOB_SELECT} WHERE j.id=$1 AND j.owner_mod_id=$2`,
      [
        id(jobId, "scheduled_job_id"),
        id(ownerModId, "scheduled_job_owner_mod_id"),
      ],
    );
    return this.resolved(result.rows[0]);
  }
  async validateTaskTarget(job, client = this.pool) {
    if (job.jobKind !== 'task') return;
    const { rows } = await client.query('SELECT status,assigned_agent_id FROM task_board_tasks WHERE id=$1', [job.taskId]);
    if (!rows[0]) throw new Error('scheduled_job_task_not_found');
    if (rows[0].status !== 'todo') throw new Error('scheduled_job_task_not_todo');
    if (rows[0].assigned_agent_id !== job.agentId) throw new Error('scheduled_job_task_agent_mismatch');
  }
  async createJob(input = {}, { ownerModId = null } = {}) {
    const zone = await this.effective(null);
    const job = jobInput(input, { timezone: zone });
    await this.validateModel(job);
    await this.validateTaskTarget(job);
    const stamp = timestamp(this.clock);
    if (job.enabled && job.runAt && new Date(job.runAt) <= new Date(stamp)) throw new Error('scheduled_job_run_at_past');
    const jobId = input.id ? id(input.id, 'scheduled_job_id') : randomUUID();
    const next = nextOccurrence(job, zone, stamp);
    await this.pool.query(
      "INSERT INTO scheduled_jobs (id,owner_mod_id,agent_id,name,prompt,cron_expression,timezone,session_id,enabled,next_run_at,last_run_at,created_at,updated_at,model_connection_id,model,context_mode,job_kind,task_id,extra_instructions,schedule_kind,run_at,effective_timezone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)",
      [jobId, ownerModId ? id(ownerModId, 'scheduled_job_owner_mod_id') : null, job.agentId, job.name, job.prompt, job.cron, null, job.sessionId, job.enabled, next, null, stamp, job.modelConnectionId || null, job.model || null, job.contextMode, job.jobKind, job.taskId, job.extraInstructions, job.scheduleKind, job.runAt, zone]);
    return this.getJob(jobId);
  }
  async updateJob(jobId, input = {}, { ownerModId = undefined } = {}) {
    return withPostgresTransaction(this.pool, async client => {
      const args = [id(jobId, 'scheduled_job_id')];
      if (ownerModId !== undefined) args.push(id(ownerModId, 'scheduled_job_owner_mod_id'));
      const { rows } = await client.query(`SELECT * FROM scheduled_jobs WHERE id=$1${ownerModId === undefined ? '' : ' AND owner_mod_id=$2'} FOR UPDATE`, args);
      const current = jobRow(rows[0]);
      if (!current) return null;
      const zone = await this.effective(null, client);
      modelOverride(input); // reject half-pairs before merging with a saved override
      const next = jobInput({ ...current, ...input }, { timezone: zone });
      if (input.modelConnectionId !== undefined || input.model !== undefined) await this.validateModel(next, client);
      // Retain a changed/missing existing selection so it can still be paused.
      if (next.jobKind === 'task' && (current.jobKind !== 'task' || current.taskId !== next.taskId || current.agentId !== next.agentId)) await this.validateTaskTarget(next, client);
      const stamp = timestamp(this.clock);
      const changedSchedule = next.scheduleKind !== current.scheduleKind || next.cron !== current.cron || next.runAt !== current.runAt;
      let consumedAt = changedSchedule ? null : current.consumedAt;
      if (next.scheduleKind === 'once' && next.enabled && consumedAt) throw new Error('scheduled_job_once_consumed');
      if (next.scheduleKind === 'once' && next.enabled && (changedSchedule || !current.enabled) && new Date(next.runAt) <= new Date(stamp)) throw new Error('scheduled_job_run_at_past');
      const recompute = changedSchedule || next.enabled !== current.enabled || rows[0].effective_timezone !== zone;
      const nextRun = recompute ? nextOccurrence(next, zone, stamp, consumedAt) : current.nextRunAt;
      await client.query(
        "UPDATE scheduled_jobs SET agent_id=$1,name=$2,prompt=$3,cron_expression=$4,timezone=NULL,session_id=$5,enabled=$6,next_run_at=$7,updated_at=$8,model_connection_id=$9,model=$10,context_mode=$11,job_kind=$12,task_id=$13,extra_instructions=$14,schedule_kind=$15,run_at=$16,effective_timezone=$17,consumed_at=$18 WHERE id=$19",
        [next.agentId,next.name,next.prompt,next.cron,next.sessionId,next.enabled,nextRun,stamp,next.modelConnectionId || null,next.model || null,next.contextMode,next.jobKind,next.taskId,next.extraInstructions,next.scheduleKind,next.runAt,zone,consumedAt,current.id]);
      return this.resolved((await client.query(`${JOB_SELECT} WHERE j.id=$1`, [current.id])).rows[0], client);
    });
  }
  async deleteJob(jobId, { ownerModId = undefined } = {}) {
    const current =
      ownerModId === undefined
        ? await this.getJob(jobId)
        : await this.getOwnedJob(ownerModId, jobId);
    if (!current) return null;
    await this.pool.query("DELETE FROM scheduled_jobs WHERE id=$1", [
      current.id,
    ]);
    return current;
  }
  async listRuns(
    jobId,
    { limit = 50, ownerModId = undefined, offset = 0 } = {},
  ) {
    if (
      ownerModId !== undefined &&
      !(await this.getOwnedJob(ownerModId, jobId))
    )
      return [];
    const result = await this.pool.query(
      "SELECT * FROM scheduled_job_runs WHERE job_id=$1 ORDER BY scheduled_for DESC,created_at DESC LIMIT $2 OFFSET $3",
      [
        id(jobId, "scheduled_job_id"),
        Math.max(1, Math.min(Number(limit) || 50, 200)),
        Math.max(0, Number(offset) || 0),
      ],
    );
    return result.rows.map(runRow);
  }
  async getRun(runId) {
    const result = await this.pool.query(
      "SELECT * FROM scheduled_job_runs WHERE id=$1",
      [id(runId, "scheduled_job_run_id")],
    );
    return runRow(result.rows[0]);
  }
  async createManualRun(jobId, { at: when = this.clock() } = {}) {
    return withPostgresTransaction(this.pool, async (client) => {
      // Share the due-claim serialization boundary, not receipt ordering.
      const locked = await client.query("SELECT * FROM scheduled_jobs WHERE id=$1 FOR UPDATE", [id(jobId, "scheduled_job_id")]);
      const job = jobRow(locked.rows[0]);
      if (!job) return null;
      const active = await client.query("SELECT * FROM scheduled_job_runs WHERE job_id=$1 AND status='running' LIMIT 1", [job.id]);
      if (active.rows[0]) return { ...runRow(active.rows[0]), overlap: true };
      if (job.scheduleKind === 'once' && job.consumedAt) return { onceConsumed: true };
      let scheduledFor = job.scheduleKind === 'once' ? job.runAt : when;
      // Two deliberately distinct Run-now attempts can share a clock millisecond.
      // Keep the unique occurrence key without changing recurring nextRunAt.
      if (job.scheduleKind !== 'once') {
        while ((await client.query('SELECT 1 FROM scheduled_job_runs WHERE job_id=$1 AND scheduled_for=$2', [job.id,scheduledFor])).rowCount) scheduledFor = new Date(new Date(scheduledFor).getTime() + 1).toISOString();
      }
      const runId = randomUUID();
      await client.query("UPDATE scheduled_jobs SET last_run_at=$1,enabled=CASE WHEN schedule_kind='once' THEN false ELSE enabled END,next_run_at=CASE WHEN schedule_kind='once' THEN NULL ELSE next_run_at END,consumed_at=CASE WHEN schedule_kind='once' THEN $1 ELSE consumed_at END,updated_at=$1 WHERE id=$2", [when,job.id]);
      const result = await client.query(
        "INSERT INTO scheduled_job_runs (id,job_id,scheduled_for,status,agent_id,session_id,created_at,updated_at,task_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8) RETURNING *",
        [runId, job.id, scheduledFor, "running", job.agentId, job.sessionId, when, job.taskId],
      );
      return Object.defineProperty(runRow(result.rows[0]), 'job', { value: job });
    });
  }

  async markMissedRuns({ at: when = this.clock() } = {}) {
    return withPostgresTransaction(this.pool, async client => {
      // A task terminal receipt may have committed just before process loss.
      // Reuse it only for the exact same task/run owner; never infer success
      // from task status, another execution, or dispatch acceptance.
      const { rows } = await client.query("SELECT r.*,t.execution_json AS task_execution FROM scheduled_job_runs r LEFT JOIN task_board_tasks t ON t.id=r.task_id WHERE r.status='running' ORDER BY r.id FOR UPDATE OF r");
      for (const row of rows) {
        const task = row.task_execution;
        const terminal = task && row.run_id && task.runId === row.run_id && task.agentId === row.agent_id && task.sessionId === row.session_id && ['completed','failed','cancelled'].includes(task.status);
        const outcome = terminal ? classifyRuntimeOutcome(task) : { status: 'missed', ok: false };
        await client.query('UPDATE scheduled_job_runs SET status=$1,ok=$2,completed_at=$3,error=$4,trace_dir=$5,decision=$6,result_json=$7::jsonb,updated_at=$3 WHERE id=$8', [outcome.status,outcome.ok,when,terminal ? task.error || null : 'scheduler_restart_before_completion',terminal ? task.traceDir || null : null,terminal ? task.decision || null : null,json(terminal ? task.result : {}),row.id]);
      }
      return rows.length;
    });
  }
  async markMissedSchedules({
    at: when = this.clock(),
    activeOwnerModIds = [],
  } = {}) {
    const owners = [
      ...new Set(
        (Array.isArray(activeOwnerModIds) ? activeOwnerModIds : []).map(
          (value) => id(value, "scheduled_job_owner_mod_id"),
        ),
      ),
    ];
    const ownerClause = owners.length
      ? `AND (owner_mod_id IS NULL OR owner_mod_id = ANY($2::text[]))`
      : "AND owner_mod_id IS NULL";
    const result = await withPostgresTransaction(this.pool, async (client) => {
      await this.reconcileInherited(client, when);
      const jobs = await client.query(
        `SELECT * FROM scheduled_jobs WHERE enabled AND next_run_at IS NOT NULL AND next_run_at<$1 ${ownerClause} ORDER BY next_run_at FOR UPDATE`,
        owners.length ? [when, owners] : [when],
      );
      let missed = 0;
      for (const row of jobs.rows) {
        const job = await this.resolved(row, client);
        const timezone = await this.effective(job.timezone, client);
        const cron = job.scheduleKind === 'once' ? null : parseCron(job.cron);
        let scheduled = job.nextRunAt;
        while (scheduled && new Date(scheduled) < new Date(when)) {
          await client.query(
            "INSERT INTO scheduled_job_runs (id,job_id,scheduled_for,status,agent_id,session_id,completed_at,error,created_at,updated_at,task_id) VALUES ($1,$2,$3,'missed',$4,$5,$6,'scheduler_restart_missed_schedule',$6,$6,$7) ON CONFLICT DO NOTHING",
            [randomUUID(), job.id, scheduled, job.agentId, job.sessionId, when, job.taskId],
          );
          scheduled = job.scheduleKind === 'once' ? null : nextCronOccurrence(
            cron,
            timezone,
            new Date(scheduled),
          );
          missed += 1;
          // Preserve one durable receipt per occurrence, but relinquish the
          // event loop regularly even with immediately-resolved query adapters.
          if (missed % 128 === 0) await new Promise((resolve) => setImmediate(resolve));
        }
        await client.query(
          "UPDATE scheduled_jobs SET next_run_at=$1,enabled=CASE WHEN schedule_kind='once' THEN false ELSE enabled END,consumed_at=CASE WHEN schedule_kind='once' THEN $2 ELSE consumed_at END,updated_at=$2 WHERE id=$3",
          [scheduled, when, job.id],
        );
      }
      return missed;
    });
    return result;
  }
  async claimDueJobs({ at: when = this.clock(), activeOwnerModIds = [] } = {}) {
    const owners = [
      ...new Set(
        (Array.isArray(activeOwnerModIds) ? activeOwnerModIds : []).map(
          (value) => id(value, "scheduled_job_owner_mod_id"),
        ),
      ),
    ];
    return withPostgresTransaction(this.pool, async (client) => {
      await this.reconcileInherited(client, when);
      const args = owners.length ? [when, owners] : [when];
      const ownerClause = owners.length
        ? "AND (owner_mod_id IS NULL OR owner_mod_id = ANY($2::text[]))"
        : "AND owner_mod_id IS NULL";
      const due = await client.query(
        `SELECT * FROM scheduled_jobs WHERE enabled AND next_run_at IS NOT NULL AND next_run_at<=$1 ${ownerClause} ORDER BY next_run_at FOR UPDATE SKIP LOCKED`,
        args,
      );
      const claimed = [];
      for (const row of due.rows) {
        const job = await this.resolved(row, client);
        if (!job.nextRunAt || new Date(job.nextRunAt) > new Date(when))
          continue;
        const next = job.scheduleKind === 'once' ? null : nextCronOccurrence(job.cron, job.effectiveTimezone, new Date(when));
        await client.query(
          "UPDATE scheduled_jobs SET next_run_at=$1,last_run_at=$2,enabled=CASE WHEN schedule_kind='once' THEN false ELSE enabled END,consumed_at=CASE WHEN schedule_kind='once' THEN $2 ELSE consumed_at END,updated_at=$2 WHERE id=$3",
          [next, when, job.id],
        );
        const active = await client.query(
          "SELECT id FROM scheduled_job_runs WHERE job_id=$1 AND status='running' LIMIT 1",
          [job.id],
        );
        const runId = randomUUID();
        const status = active.rows[0] ? "skipped" : "running";
        await client.query(
          "INSERT INTO scheduled_job_runs (id,job_id,scheduled_for,status,agent_id,session_id,created_at,updated_at,task_id,completed_at,error) VALUES ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10) ON CONFLICT (job_id,scheduled_for) DO NOTHING",
          [
            runId,
            job.id,
            job.nextRunAt,
            status,
            job.agentId,
            job.sessionId,
            when, job.taskId, status === 'skipped' ? when : null, status === 'skipped' ? 'scheduled_job_already_running' : null,
          ],
        );
        const run = await client.query(
          "SELECT * FROM scheduled_job_runs WHERE id=$1",
          [runId],
        );
        if (run.rows[0])
          claimed.push({
            job: jobRow(
              (
                await client.query("SELECT * FROM scheduled_jobs WHERE id=$1", [
                  job.id,
                ])
              ).rows[0],
            ),
            run: runRow(run.rows[0]),
            overlap: Boolean(active.rows[0]),
          });
      }
      return claimed;
    });
  }
  async markDispatched(runId, { chatRunId, at: when = this.clock() } = {}) {
    await this.pool.query("UPDATE scheduled_job_runs SET run_id=$1,dispatched_at=$2,updated_at=$2 WHERE id=$3 AND status='running'", [chatRunId,when,id(runId,'scheduled_job_run_id')]);
  }
  async completeRun(runId, input = {}) {
    return withPostgresTransaction(this.pool, async (client) => {
      const result = await client.query(
        "SELECT * FROM scheduled_job_runs WHERE id=$1 FOR UPDATE",
        [id(runId, "scheduled_job_run_id")],
      );
      const current = runRow(result.rows[0]);
      if (!current || current.status !== "running") return current;
      if (input.status && (!["completed", "failed", "cancelled", "skipped"].includes(text(input.status)))) throw new Error("scheduled_job_run_status_invalid");
      const outcome = input.status === 'skipped' ? { status: 'skipped', ok: false } : classifyRuntimeOutcome(input);
      const status = outcome.status;
      if (
        !RUN_STATUS.has(status) ||
        ["running", "missed"].includes(status)
      )
        throw new Error("scheduled_job_run_status_invalid");
      const stamp = timestamp(this.clock);
      await client.query(
        "UPDATE scheduled_job_runs SET status=$1,run_id=$2,dispatched_at=$3,completed_at=$4,trace_dir=$5,decision=$6,ok=$7,error=$8,result_json=$9::jsonb,updated_at=$4 WHERE id=$10",
        [
          status,
          input.runId || current.runId,
          status === 'skipped' ? current.dispatchedAt : (input.dispatchedAt || current.dispatchedAt || current.createdAt),
          stamp,
          input.traceDir || null,
          input.decision || null,
          outcome.ok,
          input.error || null,
          json(input.result),
          current.id,
        ],
      );
      return runRow(
        (
          await client.query("SELECT * FROM scheduled_job_runs WHERE id=$1", [
            current.id,
          ])
        ).rows[0], client,
      );
    });
  }
  async cancelRun(runId, reason = "cancelled by operator") {
    return this.completeRun(runId, {
      status: "cancelled",
      ok: false,
      error: text(reason).slice(0, 1000) || "cancelled by operator",
    });
  }
}
export default PostgresScheduledJobStore;

export const ScheduledJobStore = PostgresScheduledJobStore;
export const validateScheduledJobModel = async (store, job) =>
  store.validateModel(job);
