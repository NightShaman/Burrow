import { classifyRuntimeOutcome } from './runtime-outcome.mjs';
import { normalizePostgresPool } from './postgres-foundation.mjs';
import { operatorTimezone } from './timezone.mjs';
import { PostgresSettingsMetadataStore } from './postgres-settings-metadata-store.mjs';
import { randomUUID } from "node:crypto";
import {
  parseCron,
  cronMatches,
  nextCronOccurrence,
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
function validTimezone(value) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}
function jobRow(row) {
  return (
    row && {
      id: row.id,
      ownerModId: row.owner_mod_id || null,
      agentId: row.agent_id,
      name: row.name,
      prompt: row.prompt,
      cron: row.cron_expression,
      timezone: row.timezone,
      sessionId: row.session_id,
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
function jobInput(input, { partial = false } = {}) {
  const result = modelOverride(input);
  if (!partial || input.agentId !== undefined)
    result.agentId = id(input.agentId, "scheduled_job_agent_id");
  if (!partial || input.name !== undefined) {
    result.name = text(input.name);
    if (!result.name || result.name.length > 160)
      throw new Error("scheduled_job_name_invalid");
  }
  if (!partial || input.prompt !== undefined) {
    result.prompt = text(input.prompt);
    if (!result.prompt || result.prompt.length > 20000)
      throw new Error("scheduled_job_prompt_invalid");
  }
  if (!partial || input.cron !== undefined)
    result.cron = parseCron(input.cron).expression;
  if (!partial || input.timezone !== undefined) {
    result.timezone = input.timezone == null ? null : text(input.timezone);
    if (result.timezone !== null && !validTimezone(result.timezone))
      throw new Error("scheduled_job_timezone_invalid");
  }
  if (input.sessionId !== undefined) {
    result.sessionId = text(input.sessionId) || "default";
    if (!/^[A-Za-z0-9._-]{1,96}$/.test(result.sessionId))
      throw new Error("scheduled_job_session_id_invalid");
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean")
      throw new Error("scheduled_job_enabled_invalid");
    result.enabled = input.enabled;
  }
  return result;
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
  async effective(timezone, client = this.pool) { return timezone ?? await operatorTimezone(new PostgresSettingsMetadataStore({ pool: client })); }
  async resolved(row, client = this.pool) { const job = jobRow(row); return job && { ...job, effectiveTimezone: await this.effective(job.timezone, client) }; }
  async reconcileInherited(client, at) {
    const zone = await this.effective(null, client);
    const rows = await client.query('SELECT * FROM scheduled_jobs WHERE timezone IS NULL AND effective_timezone IS DISTINCT FROM $1 ORDER BY id FOR UPDATE', [zone]);
    for (const row of rows.rows) {
      if (row.effective_timezone === zone) continue;
      const next = row.enabled ? nextCronOccurrence(row.cron_expression, zone, new Date(at)) : null;
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
      "SELECT * FROM scheduled_jobs WHERE id=$1",
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
    let sql = `SELECT * FROM scheduled_jobs${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY next_run_at IS NULL,next_run_at,translate(name,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C",id`;
    if (limit !== null) {
      sql += ` LIMIT $${args.push(Math.max(1, Math.min(Number(limit) || 50, 101)))} OFFSET $${args.push(Math.max(0, Number(offset) || 0))}`;
    }
    const result = await this.pool.query(sql, args);
    return Promise.all(result.rows.map(row => this.resolved(row)));
  }
  async getOwnedJob(ownerModId, jobId) {
    const result = await this.pool.query(
      "SELECT * FROM scheduled_jobs WHERE id=$1 AND owner_mod_id=$2",
      [
        id(jobId, "scheduled_job_id"),
        id(ownerModId, "scheduled_job_owner_mod_id"),
      ],
    );
    return this.resolved(result.rows[0]);
  }
  async createJob(input = {}, { ownerModId = null } = {}) {
    const job = jobInput({ ...input, timezone: input.timezone ?? null });
    await this.validateModel(job);
    const enabled = job.enabled === true;
    const stamp = timestamp(this.clock);
    const jobId = input.id ? id(input.id, "scheduled_job_id") : randomUUID();
    const effectiveTimezone = await this.effective(job.timezone);
    const next = enabled
      ? nextCronOccurrence(job.cron, effectiveTimezone, new Date(stamp))
      : null;
    await this.pool.query(
      "INSERT INTO scheduled_jobs (id,owner_mod_id,agent_id,name,prompt,cron_expression,timezone,session_id,enabled,next_run_at,last_run_at,created_at,updated_at,model_connection_id,model) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,$13,$14)",
      [
        jobId,
        ownerModId ? id(ownerModId, "scheduled_job_owner_mod_id") : null,
        job.agentId,
        job.name,
        job.prompt,
        job.cron,
        job.timezone,
        job.sessionId || "default",
        enabled,
        next,
        null,
        stamp,
        job.modelConnectionId || null,
        job.model || null,
      ],
    );
    await this.pool.query("UPDATE scheduled_jobs SET effective_timezone=$1 WHERE id=$2", [effectiveTimezone, jobId]);
    return this.getJob(jobId);
  }
  async updateJob(jobId, input = {}, { ownerModId = undefined } = {}) {
    return withPostgresTransaction(this.pool, async (client) => {
      const args =
        ownerModId === undefined
          ? [id(jobId, "scheduled_job_id")]
          : [
              id(jobId, "scheduled_job_id"),
              id(ownerModId, "scheduled_job_owner_mod_id"),
            ];
      const result = await client.query(
        `SELECT * FROM scheduled_jobs WHERE id=$1${ownerModId === undefined ? "" : " AND owner_mod_id=$2"} FOR UPDATE`,
        args,
      );
      const current = jobRow(result.rows[0]);
      if (!current) return null;
      const patch = jobInput(input, { partial: true });
      const next = { ...current, ...patch };
      if (patch.modelConnectionId !== undefined)
        await this.validateModel(next, client);
      const stamp = timestamp(this.clock);
      const recompute =
        patch.cron !== undefined ||
        patch.timezone !== undefined ||
        patch.enabled !== undefined;
      const nextRun = !next.enabled
        ? null
        : recompute
          ? nextCronOccurrence(next.cron, await this.effective(next.timezone, client), new Date(stamp))
          : current.nextRunAt;
      await client.query(
        "UPDATE scheduled_jobs SET agent_id=$1,name=$2,prompt=$3,cron_expression=$4,timezone=$5,session_id=$6,enabled=$7,next_run_at=$8,updated_at=$9,model_connection_id=$10,model=$11 WHERE id=$12",
        [
          next.agentId,
          next.name,
          next.prompt,
          next.cron,
          next.timezone,
          next.sessionId || "default",
          next.enabled,
          nextRun,
          stamp,
          next.modelConnectionId || null,
          next.model || null,
          current.id,
        ],
      );
      if (recompute) await client.query("UPDATE scheduled_jobs SET effective_timezone=$1 WHERE id=$2", [await this.effective(next.timezone, client), current.id]);
      return this.resolved(
        (
          await client.query("SELECT * FROM scheduled_jobs WHERE id=$1", [
            current.id,
          ])
        ).rows[0], client,
      );
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
      const runId = randomUUID();
      const result = await client.query(
        "INSERT INTO scheduled_job_runs (id,job_id,scheduled_for,status,agent_id,session_id,dispatched_at,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$3,$3,$3) RETURNING *",
        [runId, job.id, when, "running", job.agentId, job.sessionId],
      );
      return runRow(result.rows[0]);
    });
  }

  async markMissedRuns({ at: when = this.clock() } = {}) {
    const result = await this.pool.query(
      "UPDATE scheduled_job_runs SET status='missed',completed_at=$1,error='scheduler_restart_before_completion',updated_at=$1 WHERE status='running'",
      [when],
    );
    return result.rowCount;
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
        const cron = parseCron(job.cron);
        let scheduled = job.nextRunAt;
        while (scheduled && new Date(scheduled) < new Date(when)) {
          await client.query(
            "INSERT INTO scheduled_job_runs (id,job_id,scheduled_for,status,agent_id,session_id,completed_at,error,created_at,updated_at) VALUES ($1,$2,$3,'missed',$4,$5,$6,'scheduler_restart_missed_schedule',$6,$6) ON CONFLICT DO NOTHING",
            [randomUUID(), job.id, scheduled, job.agentId, job.sessionId, when],
          );
          scheduled = nextCronOccurrence(
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
          "UPDATE scheduled_jobs SET next_run_at=$1,updated_at=$2 WHERE id=$3",
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
        const next = nextCronOccurrence(job.cron, job.effectiveTimezone, new Date(when));
        await client.query(
          "UPDATE scheduled_jobs SET next_run_at=$1,last_run_at=$2,updated_at=$2 WHERE id=$3",
          [next, when, job.id],
        );
        const active = await client.query(
          "SELECT id FROM scheduled_job_runs WHERE job_id=$1 AND status='running' LIMIT 1",
          [job.id],
        );
        const runId = randomUUID();
        const status = active.rows[0] ? "skipped" : "running";
        await client.query(
          "INSERT INTO scheduled_job_runs (id,job_id,scheduled_for,status,agent_id,session_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$7) ON CONFLICT (job_id,scheduled_for) DO NOTHING",
          [
            runId,
            job.id,
            job.nextRunAt,
            status,
            job.agentId,
            job.sessionId,
            when,
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
  async completeRun(runId, input = {}) {
    return withPostgresTransaction(this.pool, async (client) => {
      const result = await client.query(
        "SELECT * FROM scheduled_job_runs WHERE id=$1 FOR UPDATE",
        [id(runId, "scheduled_job_run_id")],
      );
      const current = runRow(result.rows[0]);
      if (!current || current.status !== "running") return current;
      if (input.status && (!["completed", "failed", "cancelled"].includes(text(input.status)))) throw new Error("scheduled_job_run_status_invalid");
      const outcome = classifyRuntimeOutcome(input);
      const status = outcome.status;
      if (
        !RUN_STATUS.has(status) ||
        ["running", "missed", "skipped"].includes(status)
      )
        throw new Error("scheduled_job_run_status_invalid");
      const stamp = timestamp(this.clock);
      await client.query(
        "UPDATE scheduled_job_runs SET status=$1,run_id=$2,dispatched_at=$3,completed_at=$4,trace_dir=$5,decision=$6,ok=$7,error=$8,result_json=$9::jsonb,updated_at=$4 WHERE id=$10",
        [
          status,
          input.runId || current.runId,
          input.dispatchedAt || current.dispatchedAt || current.createdAt,
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
