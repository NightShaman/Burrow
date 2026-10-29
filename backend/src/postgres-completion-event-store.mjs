import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';
import { archiveCursorBoundary, archiveCursor, archiveUtcDay, archiveUtcMonth } from './archive-pagination.mjs';
import { validateTimezone } from './timezone.mjs';
import { createContinuityOwner } from './postgres-continuity-owner.mjs';
import { withPostgresTransaction } from './postgres-foundation.mjs';

// Additive migration only: earlier manifest SQL/checksums must remain immutable.
export const POSTGRES_COMPLETION_EVENT_SCHEMA_SQL = `
CREATE TABLE github_workflow_watches (
  id UUID PRIMARY KEY,
  repository TEXT NOT NULL CHECK (char_length(repository) BETWEEN 3 AND 255),
  workflow TEXT NOT NULL CHECK (char_length(workflow) BETWEEN 1 AND 255),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  session_id TEXT NOT NULL CHECK (char_length(session_id) BETWEEN 1 AND 255),
  instruction TEXT NOT NULL CHECK (char_length(instruction) BETWEEN 1 AND 20000),
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX github_workflow_watches_match_idx ON github_workflow_watches(repository,workflow) WHERE enabled;
CREATE TABLE github_completion_events (
  id UUID PRIMARY KEY,
  watch_id UUID NOT NULL,
  repository TEXT NOT NULL,
  workflow TEXT NOT NULL,
  run_id TEXT NOT NULL,
  run_attempt INTEGER NOT NULL CHECK (run_attempt >= 1),
  head_sha TEXT NOT NULL,
  conclusion TEXT NOT NULL,
  url TEXT NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  session_id TEXT NOT NULL,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','succeeded','failed','interrupted')),
  owner_id TEXT,
  owner_lock_id UUID,
  chat_run_id TEXT NOT NULL,
  result JSONB,
  error TEXT,
  trace_dir TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TIMESTAMPTZ,
  finished_at TIMESTAMPTZ,
  CONSTRAINT github_completion_event_identity UNIQUE (repository,run_id,run_attempt,watch_id),
  CONSTRAINT github_completion_event_ownership CHECK ((status = 'running') = (owner_id IS NOT NULL AND owner_lock_id IS NOT NULL))
);
CREATE INDEX github_completion_events_pending_idx ON github_completion_events(created_at,id) WHERE status='pending';
CREATE UNIQUE INDEX github_completion_events_running_lane_idx ON github_completion_events(agent_id,session_id) WHERE status='running';
-- Automated provider-role=user turns must not claim operator presence. Keep
-- the published v48 projection unchanged; amend its trigger in this successor.
CREATE OR REPLACE FUNCTION burrow_project_operator_instant() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF burrow_history_key(burrow_json_member(burrow_json_member(NEW.entry,'metadata'),'source')::text) = burrow_history_text('workflow-event') THEN
  NEW.operator_at := NULL; NEW.operator_ts_fallback := NULL;
 ELSE
  SELECT at,fallback INTO NEW.operator_at,NEW.operator_ts_fallback FROM burrow_operator_projection(NEW.entry);
 END IF;
 NEW.operator_projected := true;
 RETURN NEW;
END $$;
`;

function bounded(value, field, max, { pattern } = {}) {
  if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > max || (pattern && !pattern.test(value))) throw new Error(`completion_event_invalid_${field}`);
  return value;
}
const repositoryValue = value => bounded(value, 'repository', 255, { pattern: /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/ });
const uuidValue = value => bounded(value, 'id', 36, { pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i });
function watchRow(r) { return { id: r.id, repository: r.repository, workflow: r.workflow, agentId: r.agent_id, sessionId: r.session_id, instruction: r.instruction, enabled: r.enabled, createdAt: r.created_at, updatedAt: r.updated_at }; }
function eventRow(r) { return { id: r.id, watchId: r.watch_id, repository: r.repository, workflow: r.workflow, runId: r.run_id, runAttempt: r.run_attempt, headSha: r.head_sha, conclusion: r.conclusion, url: r.url, completedAt: r.completed_at, agentId: r.agent_id, sessionId: r.session_id, instruction: r.instruction, status: r.status, ownerId: r.owner_id, chatRunId: r.chat_run_id, result: r.result, error: r.error, traceDir: r.trace_dir, createdAt: r.created_at, startedAt: r.started_at, finishedAt: r.finished_at }; }

export class PostgresCompletionEventStore {
  constructor({ pool } = {}) {
    if (!pool?.query || !pool?.connect) throw new Error('completion_event_postgres_pool_required');
    this.pool = pool;
    this.owners = new Map();
    this.uncertainClaims = new Map();
  }
  async listWatches() {
    const { rows } = await this.pool.query('SELECT * FROM github_workflow_watches ORDER BY created_at,id');
    return rows.map(watchRow);
  }
  async saveWatch({ id, repository, workflow, agentId, sessionId = 'ci-releases', instruction, enabled = true } = {}) {
    id = id == null ? randomUUID() : uuidValue(id);
    repository = repositoryValue(repository);
    workflow = bounded(workflow, 'workflow', 255);
    agentId = bounded(agentId, 'agentId', 255);
    sessionId = bounded(sessionId, 'sessionId', 255);
    instruction = bounded(instruction, 'instruction', 20000);
    if (typeof enabled !== 'boolean') throw new Error('completion_event_invalid_enabled');
    const { rows } = await this.pool.query(`INSERT INTO github_workflow_watches(id,repository,workflow,agent_id,session_id,instruction,enabled)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET repository=EXCLUDED.repository,workflow=EXCLUDED.workflow,
      agent_id=EXCLUDED.agent_id,session_id=EXCLUDED.session_id,instruction=EXCLUDED.instruction,enabled=EXCLUDED.enabled,updated_at=CURRENT_TIMESTAMP RETURNING *`,
    [id, repository, workflow, agentId, sessionId, instruction, enabled]);
    return watchRow(rows[0]);
  }
  async deleteWatch(id) {
    // Historical event snapshots retain watch identity after deletion.
    const { rowCount } = await this.pool.query('DELETE FROM github_workflow_watches WHERE id=$1', [uuidValue(id)]);
    return rowCount > 0;
  }
  async accept({ repository, workflow, runId, runAttempt, headSha, conclusion, url, completedAt } = {}) {
    repository = repositoryValue(repository);
    workflow = bounded(workflow, 'workflow', 255);
    runId = bounded(String(runId ?? ''), 'runId', 128, { pattern: /^[0-9]+$/ });
    if (!Number.isSafeInteger(runAttempt) || runAttempt < 1 || runAttempt > 2147483647) throw new Error('completion_event_invalid_runAttempt');
    headSha = bounded(headSha, 'headSha', 64, { pattern: /^[0-9a-f]{40,64}$/i });
    conclusion = bounded(conclusion, 'conclusion', 128);
    url = bounded(url, 'url', 2048, { pattern: /^https:\/\// });
    if (typeof completedAt !== 'string' || !Number.isFinite(Date.parse(completedAt))) throw new Error('completion_event_invalid_completedAt');
    const completed = new Date(completedAt).toISOString();
    return withPostgresTransaction(this.pool, async client => {
      const { rows: watches } = await client.query('SELECT * FROM github_workflow_watches WHERE enabled AND repository=$1 AND workflow=$2 ORDER BY id', [repository, workflow]);
      const accepted = [];
      for (const watch of watches) {
        const id = randomUUID();
        const { rows } = await client.query(`INSERT INTO github_completion_events(id,watch_id,repository,workflow,run_id,run_attempt,head_sha,conclusion,url,completed_at,agent_id,session_id,instruction,chat_run_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::timestamptz,$11,$12,$13,$14)
          ON CONFLICT (repository,run_id,run_attempt,watch_id) DO NOTHING RETURNING *`,
        [id, watch.id, repository, workflow, runId, runAttempt, headSha, conclusion, url, completed, watch.agent_id, watch.session_id, watch.instruction, `event-${id}`]);
        if (rows.length) { accepted.push({ ...eventRow(rows[0]), accepted: true }); continue; }
        const { rows: existing } = await client.query('SELECT * FROM github_completion_events WHERE repository=$1 AND run_id=$2 AND run_attempt=$3 AND watch_id=$4', [repository, runId, runAttempt, watch.id]);
        const prior = existing[0];
        if (!prior || prior.workflow !== workflow || prior.head_sha !== headSha || prior.conclusion !== conclusion || prior.url !== url || new Date(prior.completed_at).getTime() !== new Date(completed).getTime()) throw new Error('completion_event_conflict');
        accepted.push({ ...eventRow(prior), accepted: false });
      }
      return accepted;
    });
  }
  async list({ limit = 50, agentId } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('completion_event_invalid_limit');
    if (agentId !== undefined) agentId = bounded(agentId, 'agentId', 255);
    const { rows } = await this.pool.query(`SELECT * FROM github_completion_events WHERE ($1::text IS NULL OR agent_id=$1) ORDER BY created_at DESC,id DESC LIMIT $2`, [agentId ?? null, limit]);
    return rows.map(eventRow);
  }
  // Archive reads retained snapshots, not the bounded Settings latest-N list.
  async listArchive({ agentId = null, date = null, timezone = 'UTC', query = '', limit = 100, cursor = null } = {}) {
    timezone = validateTimezone(timezone || 'UTC', 'archive_timezone_invalid');
    if (date) archiveUtcDay(date);
    query = String(query || '').trim().toLowerCase();
    const size = Number(limit);
    if (!Number.isSafeInteger(size) || size < 1 || size > 500) throw new Error('archive_limit_invalid');
    const scope = JSON.stringify(['workflow-events', agentId || null, date || null, timezone, query]);
    const boundary = archiveCursorBoundary(cursor, { scope });
    if (boundary && (boundary.t.startsWith('0000-') || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3,6}Z$/.test(boundary.t) || !Number.isFinite(Date.parse(boundary.t)) || new Date(boundary.t).toISOString().slice(0,19) !== boundary.t.slice(0,19) || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(boundary.i))) throw new Error('archive_cursor_invalid');
    const { rows } = await this.pool.query(`SELECT id,watch_id,repository,workflow,run_id,run_attempt,head_sha,conclusion,url,completed_at,
      agent_id,session_id,instruction,status,chat_run_id,result,error,created_at,started_at,finished_at,
      to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS archive_cursor_timestamp
      FROM github_completion_events
      WHERE ($1::text IS NULL OR agent_id=$1)
      AND ($2::text IS NULL OR to_char(created_at AT TIME ZONE $3,'YYYY-MM-DD')=$2)
      AND ($4::text='' OR strpos(lower(concat_ws(' ',repository,workflow,run_id,head_sha,conclusion,agent_id,session_id,instruction,status,chat_run_id,error,result::text)), $4)>0)
      AND ($5::timestamptz IS NULL OR (created_at,id)<($5::timestamptz,$6::uuid))
      ORDER BY created_at DESC,id DESC LIMIT $7`,
    [agentId || null, date || null, timezone, query, boundary?.t ?? null, boundary?.i ?? null, size + 1]);
    const events = rows.slice(0, size).map(eventRow);
    const hasMore = rows.length > size;
    const last = events.at(-1);
    return { events, hasMore, nextCursor: hasMore && last ? archiveCursor({ scope, timestamp: rows[size - 1].archive_cursor_timestamp, identity: last.id }) : null };
  }
  async listArchiveCalendarDates({ agentId = null, month, timezone = 'UTC' } = {}) {
    timezone = validateTimezone(timezone || 'UTC', 'archive_timezone_invalid');
    month = archiveUtcMonth(month);
    const { rows } = await this.pool.query(`SELECT DISTINCT to_char(created_at AT TIME ZONE $3,'YYYY-MM-DD') AS day
      FROM github_completion_events WHERE ($1::text IS NULL OR agent_id=$1)
      AND to_char(created_at AT TIME ZONE $3,'YYYY-MM')=$2 ORDER BY day`, [agentId || null, month, timezone]);
    return rows.map(row => row.day);
  }
  async owner(ownerId) {
    bounded(ownerId, 'ownerId', 255);
    let owner = this.owners.get(ownerId);
    if (!owner) { owner = createContinuityOwner(this.pool); this.owners.set(ownerId, owner); }
    try { await owner.ready(); }
    catch (error) {
      if (this.owners.get(ownerId) === owner) this.owners.delete(ownerId);
      await owner.close().catch(() => {});
      throw error;
    }
    return owner;
  }
  async claim({ ownerId } = {}) {
    const uncertain = this.uncertainClaims.get(ownerId);
    if (uncertain) {
      // COMMIT may have succeeded without its acknowledgment. No caller received
      // this claim, so recovering this exact row is admission, not reexecution.
      const row = (await this.pool.query('SELECT * FROM github_completion_events WHERE id=$1', [uncertain.id])).rows[0];
      this.uncertainClaims.delete(ownerId);
      if (row?.status === 'running' && row.owner_id === ownerId && row.owner_lock_id === uncertain.ownerLockId) return { ...eventRow(row), ownerLockId: row.owner_lock_id };
    }
    const owner = await this.owner(ownerId);
    let candidate = null;
    try { return await withPostgresTransaction(this.pool, async client => {
      // Lock the agent identity as a lane-claim mutex. Concurrent claimers skip it,
      // and the running-lane unique index is a second database-level guarantee.
      const { rows } = await client.query(`SELECT e.* FROM github_completion_events e
        JOIN agents a ON a.id=e.agent_id WHERE e.status='pending'
        AND NOT EXISTS (SELECT 1 FROM github_completion_events r WHERE r.agent_id=e.agent_id AND r.session_id=e.session_id AND r.status='running')
        ORDER BY e.created_at,e.id LIMIT 1 FOR UPDATE OF a,e SKIP LOCKED`);
      if (!rows.length) return null;
      candidate = { ...eventRow(rows[0]), ownerLockId: owner.id };
      const { rows: claimed } = await client.query(`UPDATE github_completion_events SET status='running',owner_id=$2,owner_lock_id=$3,started_at=CURRENT_TIMESTAMP WHERE id=$1 AND status='pending' RETURNING *`, [rows[0].id, ownerId, owner.id]);
      candidate = { ...eventRow(claimed[0]), ownerLockId: claimed[0].owner_lock_id };
      return candidate;
    }); } catch (error) {
      if (candidate) this.uncertainClaims.set(ownerId, candidate);
      throw error;
    }
  }
  async complete(id, { ownerId, ownerLockId = this.owners.get(ownerId)?.id, status = 'succeeded', result = null, error = null, traceDir = null } = {}) {
    uuidValue(id);
    if (!['succeeded', 'failed', 'interrupted'].includes(status)) throw new Error('completion_event_invalid_status');
    bounded(ownerId, 'ownerId', 255);
    if (!ownerLockId) throw new Error('completion_event_owner_fenced');
    uuidValue(ownerLockId);
    const { rows } = await this.pool.query(`UPDATE github_completion_events SET status=$3,result=$4::jsonb,error=$5,trace_dir=$6,finished_at=CURRENT_TIMESTAMP,owner_id=NULL,owner_lock_id=NULL
      WHERE id=$1 AND status='running' AND owner_id=$2 AND owner_lock_id=$7 RETURNING *`, [id, ownerId, status, result === undefined ? null : JSON.stringify(result), error, traceDir, ownerLockId]);
    if (!rows.length) {
      // An ambiguous connection loss may occur after PostgreSQL commits. Retrying
      // the identical receipt is safe; a different terminal outcome is fenced.
      const prior = (await this.pool.query('SELECT * FROM github_completion_events WHERE id=$1', [id])).rows[0];
      if (!prior || prior.status !== status || !isDeepStrictEqual(prior.result, result) || prior.error !== error || prior.trace_dir !== traceDir) throw new Error('completion_event_owner_fenced');
      return eventRow(prior);
    }
    return eventRow(rows[0]);
  }
  // Only proven-dead PostgreSQL session-lock owners may be interrupted; never
  // requeue uncertain work. Pending work remains untouched for another claim.
  async reconcileInterrupted({ ownerId } = {}) {
    if (ownerId !== undefined) bounded(ownerId, 'ownerId', 255);
    const probe = createContinuityOwner(this.pool);
    try { return await withPostgresTransaction(this.pool, async client => {
      const { rows } = await client.query("SELECT id,owner_lock_id FROM github_completion_events WHERE status='running' AND ($1::text IS NULL OR owner_id=$1) FOR UPDATE", [ownerId ?? null]);
      const interrupted = [];
      for (const row of rows) {
        if (!row.owner_lock_id || await probe.alive(row.owner_lock_id)) continue;
        const { rows: updated } = await client.query(`UPDATE github_completion_events SET status='interrupted',error='completion_event_owner_lost',owner_id=NULL,owner_lock_id=NULL,finished_at=CURRENT_TIMESTAMP WHERE id=$1 AND status='running' RETURNING *`, [row.id]);
        interrupted.push(eventRow(updated[0]));
      }
      return interrupted;
    }); } finally { await probe.close(); }
  }
  async interruptOwner(ownerId) {
    bounded(ownerId, 'ownerId', 255);
    const { rows } = await this.pool.query(`UPDATE github_completion_events SET status='interrupted',error='completion_event_owner_shutdown',owner_id=NULL,owner_lock_id=NULL,finished_at=CURRENT_TIMESTAMP WHERE status='running' AND owner_id=$1 AND owner_lock_id=$2 RETURNING *`, [ownerId, this.owners.get(ownerId)?.id ?? null]);
    const owner = this.owners.get(ownerId);
    if (owner) { this.owners.delete(ownerId); await owner.close(); }
    return rows.map(eventRow);
  }
  async close() { await Promise.all([...this.owners.values()].map(owner => owner.close())); this.owners.clear(); }
}
