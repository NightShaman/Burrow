import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { createContinuityOwner } from './postgres-continuity-owner.mjs';
import { migrationLockKey, withPostgresTransaction } from './postgres-foundation.mjs';
import { attachmentSummary } from './runtime-turn-input.mjs';
import { operationalTelemetry } from './operational-telemetry.mjs';
import { performance } from 'node:perf_hooks';

// This is an append-only successor migration. Payloads use JSON rather than
// JSONB, preserving the conversation store's lossless string semantics.
export const POSTGRES_CHAT_INPUT_SCHEMA_SQL = `
CREATE TABLE chat_input_sessions (
 agent_id TEXT NOT NULL, session_id TEXT NOT NULL,
 generation BIGINT NOT NULL, held BOOLEAN NOT NULL DEFAULT FALSE,
 PRIMARY KEY(agent_id,session_id),
 FOREIGN KEY(agent_id,session_id) REFERENCES conversation_sessions(agent_id,session_id) ON DELETE CASCADE
);
CREATE TABLE chat_inputs (
 id UUID PRIMARY KEY,
 ordinal BIGINT GENERATED ALWAYS AS IDENTITY,
 agent_id TEXT NOT NULL, session_id TEXT NOT NULL, generation BIGINT NOT NULL,
 intent TEXT NOT NULL CHECK (intent IN ('queue_next','side_question')),
 status TEXT NOT NULL CHECK (status IN ('queued','held','running','succeeded','failed','cancelled','interrupted')),
 cancel_requested BOOLEAN NOT NULL DEFAULT FALSE,
 idempotency_key TEXT NOT NULL, message JSON NOT NULL, attachments JSON NOT NULL,
 target_run_id TEXT, promoted_from TEXT, snapshot JSON,
 run_id TEXT NOT NULL, result JSON, error TEXT, trace_dir TEXT,
 owner_id TEXT, owner_lock_id UUID, terminal_owner_id TEXT, terminal_owner_lock_id UUID,
 terminal_receipt_status TEXT, terminal_receipt_error TEXT,
 created_at TIMESTAMPTZ NOT NULL, started_at TIMESTAMPTZ, completed_at TIMESTAMPTZ,
 UNIQUE(agent_id,session_id,generation,idempotency_key),
 FOREIGN KEY(agent_id,session_id) REFERENCES conversation_sessions(agent_id,session_id) ON DELETE CASCADE,
 CHECK ((status='running') = (owner_id IS NOT NULL AND owner_lock_id IS NOT NULL))
);
CREATE INDEX chat_inputs_queue_idx ON chat_inputs(ordinal) WHERE status='queued';
CREATE INDEX chat_inputs_session_idx ON chat_inputs(agent_id,session_id,generation,ordinal);
CREATE UNIQUE INDEX chat_inputs_one_running_queue_idx ON chat_inputs(agent_id,session_id)
 WHERE status='running' AND intent='queue_next';
`;

const bad = (name, statusCode = 400) => Object.assign(new Error(name), { statusCode });
function required(value, field) {
  if (typeof value !== 'string' || !value.trim()) throw bad(`chat_input_invalid_${field}`);
  return value;
}
function optional(value, field) { return value == null ? null : required(value, field); }
function scope(args = {}) { return [required(args.agentId, 'agentId'), required(args.sessionId, 'sessionId')]; }
function uuid(value, field = 'id') {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw bad(`chat_input_invalid_${field}`);
  return value;
}
function jsonClone(value, field) {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error('not json');
    return JSON.parse(serialized);
  } catch { throw bad(`chat_input_invalid_${field}`); }
}
const instant = value => value instanceof Date ? value.toISOString() : value;
function snapshotMetadata(snapshot) {
  if (!snapshot) return null;
  // Never send captured transcript/prompt contents through read/list/events.
  // Missing header fields are explicit nulls, as on the public ChatInput API.
  return Object.fromEntries(['id', 'capturedAt', 'originRunId', 'phase', 'entryCount']
    .map(key => [key, key === 'entryCount'
      ? (Number.isSafeInteger(snapshot[key]) && snapshot[key] >= 0 ? snapshot[key] : null)
      : (typeof snapshot[key] === 'string' ? snapshot[key] : null)]));
}
function publicRow(row, position = null) {
  if (!row) return null;
  return { id: row.id, intent: row.intent, status: row.status, agentId: row.agent_id,
    sessionId: row.session_id, generation: Number(row.generation), targetRunId: row.target_run_id,
    runId: row.run_id, createdAt: instant(row.created_at), startedAt: instant(row.started_at),
    completedAt: instant(row.completed_at), message: row.message, attachments: row.attachments,
    result: row.result, error: row.error, snapshot: snapshotMetadata(row.snapshot),
    cancelRequested: row.cancel_requested === true, promotedFrom: row.promoted_from, position };
}
function metadata(row) {
  return { id: row.id, intent: row.intent, status: row.status, snapshot: snapshotMetadata(row.snapshot),
    runId: row.run_id, cancelRequested: row.cancel_requested === true };
}
function nowIso(clock) {
  const value = clock();
  return value instanceof Date ? value.toISOString() : value;
}
async function sessionLock(client, ids, now, create = false) {
  if (create) await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at)
    VALUES($1,$2,'{}'::jsonb,$3,$3) ON CONFLICT DO NOTHING`, [...ids, now]);
  const { rows } = await client.query(`SELECT COALESCE((metadata->>'resetGeneration')::bigint,0) AS generation
    FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE`, ids);
  return rows[0] ? Number(rows[0].generation) : null;
}
// Used for both candidate selection and the fresh snapshot after the session
// lock. All chat-input and continuity writers serialize on conversation_sessions.
const CLAIM_ELIGIBILITY_SQL = `i.status='queued' AND i.generation=COALESCE((s.metadata->>'resetGeneration')::bigint,0)
  AND (i.intent='side_question' OR (
    NOT COALESCE(h.held AND h.generation=i.generation,FALSE)
    AND NOT EXISTS (SELECT 1 FROM continuity_state c WHERE c.agent_id=i.agent_id AND c.session_id=i.session_id
      AND (c.head_state IN ('running','finalizing') OR c.queue_status='running'
        OR (c.queue_status='pending' AND COALESCE(c.auto_resume,FALSE))))
    AND NOT EXISTS (SELECT 1 FROM chat_inputs r WHERE r.agent_id=i.agent_id AND r.session_id=i.session_id AND r.intent='queue_next' AND r.status='running')
    AND NOT EXISTS (SELECT 1 FROM chat_inputs earlier WHERE earlier.agent_id=i.agent_id AND earlier.session_id=i.session_id AND earlier.generation=i.generation AND earlier.intent='queue_next' AND earlier.status IN ('queued','held') AND earlier.ordinal<i.ordinal)))`;
async function positionFor(client, row) {
  if (row.intent !== 'queue_next' || !['queued', 'held'].includes(row.status)) return null;
  const { rows } = await client.query(`SELECT count(*) AS n FROM chat_inputs WHERE agent_id=$1 AND session_id=$2 AND generation=$3
    AND intent='queue_next' AND status IN ('queued','held') AND ordinal<=$4`,
  [row.agent_id, row.session_id, row.generation, row.ordinal]);
  return Number(rows[0].n);
}
async function project(client, row) { return publicRow(row, await positionFor(client, row)); }
// Same lexical key and projection as PostgresSessionStore.append. Migration 57
// predates chat inputs; both the entry and its run directory must be updated in
// the surrounding input transaction (there is no entry projection trigger).
function proofRunKey(entry) {
  return typeof entry?.runId === 'string' && entry.runId
    ? Buffer.from(JSON.stringify(entry.runId), 'utf8').toString('hex') : null;
}
async function append(client, row, entry, now) {
  const key = proofRunKey(entry);
  await client.query(`INSERT INTO conversation_entries(agent_id,session_id,entry_id,entry,created_at,run_key)
    VALUES($1,$2,$3,$4::json,$5,$6)`, [row.agent_id, row.session_id, entry.id, JSON.stringify(entry), now, key]);
  await client.query('UPDATE conversation_sessions SET updated_at=$3 WHERE agent_id=$1 AND session_id=$2', [row.agent_id, row.session_id, now]);
  if (key) {
    const at = typeof entry.ts === 'string' && entry.ts ? entry.ts : now;
    const completedAt = entry.type === 'message' && entry.role === 'assistant' ? at : null;
    await client.query(`INSERT INTO conversation_archive_runs(agent_id,session_id,run_key,run_id,started_at,completed_at,last_activity_at,sort_timestamp)
      VALUES($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$5::timestamptz,COALESCE($6,$5))
      ON CONFLICT(agent_id,session_id,run_key) DO UPDATE SET run_id=EXCLUDED.run_id,
        started_at=LEAST(conversation_archive_runs.started_at,EXCLUDED.started_at),
        completed_at=COALESCE(GREATEST(conversation_archive_runs.completed_at,EXCLUDED.completed_at),conversation_archive_runs.completed_at,EXCLUDED.completed_at),
        last_activity_at=GREATEST(conversation_archive_runs.last_activity_at,EXCLUDED.last_activity_at),
        sort_timestamp=COALESCE(GREATEST(conversation_archive_runs.completed_at,EXCLUDED.completed_at)::text,LEAST(conversation_archive_runs.started_at,EXCLUDED.started_at)::text,'')`,
    [row.agent_id, row.session_id, key, entry.runId, at, completedAt]);
  }
}
async function lifecycle(client, row, now) {
  if (row.intent==='side_question' && ['succeeded','failed','cancelled','interrupted'].includes(row.status)) await sideReceipt(client,row,now);
  const entry = { id: randomUUID(), sessionId: row.session_id, runId: row.run_id, ts: now, timestamp: now,
    type: 'event', role: null, content: `Chat input ${row.status}.`, entersPrompt: false,
    visibility: 'public', metadata: { chatInput: metadata(row), ...(row.intent === 'side_question' ? { lane: 'side_question' } : {}) } };
  await append(client, row, entry, now);
}
async function sideReceipt(client,row,now) {
  if(row.intent!=='side_question') return;
  await append(client,row,{id:randomUUID(),sessionId:row.session_id,runId:row.run_id,ts:now,type:'receipt',role:null,
    content:'Snapshot side-question terminal outcome.',visibility:'debug',entersPrompt:false,traceDir:row.trace_dir,
    metadata:{lane:'side_question',chatInput:metadata(row),receiptRef:{runId:row.run_id,sessionId:row.session_id,traceDir:row.trace_dir,
      decision:row.status==='succeeded'?'answered':row.status,source:'side_question',blockers:row.result?.blockers || []}}},now);
}
async function sideAnswer(client, row, now) {
  const answer = row.result?.answerText ?? row.result?.answer;
  if (row.intent !== 'side_question' || row.status !== 'succeeded' || typeof answer !== 'string') return;
  await append(client, row, { id: randomUUID(), sessionId: row.session_id, runId: row.run_id, ts: now, timestamp: now,
    type: 'message', role: 'assistant', content: answer, entersPrompt: false, visibility: 'chat',
    traceDir: row.trace_dir, metadata: { chatInput: metadata(row), lane: 'side_question' } }, now);
}

async function setSessionHold(client, ids, generation, held, now) {
  await client.query(`INSERT INTO chat_input_sessions(agent_id,session_id,generation,held) VALUES($1,$2,$3,$4)
    ON CONFLICT(agent_id,session_id) DO UPDATE SET generation=EXCLUDED.generation,held=EXCLUDED.held`, [...ids, generation, held]);
  const { rows } = await client.query(`UPDATE chat_inputs SET status=$4 WHERE agent_id=$1 AND session_id=$2 AND generation=$3
    AND intent='queue_next' AND status=$5 RETURNING *`, [...ids, generation, held ? 'held' : 'queued', held ? 'queued' : 'held']);
  rows.sort((a, b) => BigInt(a.ordinal) < BigInt(b.ordinal) ? -1 : 1);
  for (const row of rows) await lifecycle(client, row, now);
  return rows;
}

// The caller owns a transaction and the conversation_sessions row lock. Invoke
// after reset validation but before copying/deleting the old transcript. The
// caller must check for migration 77's chat_inputs table before invoking this.
// Fence any older orphaned running row too, since the running-main unique index
// spans generations; lifecycle entries only belong in the current transcript.
export async function fenceChatInputsForReset(client, { agentId, sessionId, generation, now } = {}) {
  const ids = scope({ agentId, sessionId });
  if (!Number.isSafeInteger(generation) || generation < 0) throw bad('chat_input_invalid_generation');
  now = instant(now);
  required(now, 'now');
  const { rows } = await client.query(`UPDATE chat_inputs SET
    status=CASE WHEN status='running' THEN 'interrupted' ELSE 'cancelled' END,
    error=CASE WHEN status='running' THEN 'chat_input_session_reset' ELSE error END,
    cancel_requested=TRUE,completed_at=$4,
    terminal_owner_id=CASE WHEN status='running' THEN owner_id ELSE terminal_owner_id END,
    terminal_owner_lock_id=CASE WHEN status='running' THEN owner_lock_id ELSE terminal_owner_lock_id END,
    owner_id=NULL,owner_lock_id=NULL
    WHERE agent_id=$1 AND session_id=$2 AND generation<=$3 AND status IN ('running','queued','held') RETURNING *`,
  [...ids, generation, now]);
  rows.sort((a, b) => BigInt(a.ordinal) < BigInt(b.ordinal) ? -1 : 1);
  for (const row of rows) if (Number(row.generation) === generation) await lifecycle(client, row, now);
  return rows.map(row => publicRow(row));
}

export class PostgresChatInputStore {
  constructor({ pool, clock = () => new Date().toISOString() } = {}) {
    if (!pool?.query || !pool?.connect) throw new Error('chat_input_postgres_pool_required');
    this.pool = pool; this.clock = clock; this.owners = new Map(); this.uncertainClaims = new Map(); this.claims = new Map();
  }
  async submit(args = {}) {
    const ids = scope(args);
    const { intent, idempotencyKey, message, attachments = [], generation } = args;
    if (!['queue_next', 'side_question'].includes(intent)) throw bad('chat_input_invalid_intent');
    required(idempotencyKey, 'idempotencyKey');
    if (typeof message !== 'string' || !Array.isArray(attachments) || (!message.trim() && !attachments.length)) throw bad('message_required');
    const safeAttachments = jsonClone(attachments, 'attachments');
    if (!safeAttachments.every(item => item && typeof item === 'object' && !Array.isArray(item))) throw bad('chat_input_invalid_attachments');
    const targetRunId = optional(args.targetRunId, 'targetRunId'), promotedFrom = optional(args.promotedFrom, 'promotedFrom');
    if (generation !== undefined && (!Number.isSafeInteger(generation) || generation < 0)) throw bad('chat_input_invalid_generation');
    // Capture synchronously so callers cannot mutate the accepted snapshot while
    // awaiting a row lock. Validation follows the idempotency lookup: a retry's
    // newly captured snapshot is irrelevant, even when it differs from the first.
    const capturedSnapshot = (() => { try { return { value: args.snapshot == null ? null : jsonClone(args.snapshot, 'snapshot') }; } catch (error) { return { error }; } })();
    return withPostgresTransaction(this.pool, async client => {
      const now = nowIso(this.clock), current = await sessionLock(client, ids, now, true);
      if (generation != null && generation !== current) throw bad('chat_input_generation_conflict', 409);
      const prior = (await client.query(`SELECT * FROM chat_inputs WHERE agent_id=$1 AND session_id=$2 AND generation=$3 AND idempotency_key=$4`, [...ids, current, idempotencyKey])).rows[0];
      if (prior) {
        if (!isDeepStrictEqual({ intent: prior.intent, message: prior.message, attachments: prior.attachments, targetRunId: prior.target_run_id, promotedFrom: prior.promoted_from },
          { intent, message, attachments: safeAttachments, targetRunId, promotedFrom })) throw bad('chat_input_idempotency_conflict', 409);
        return project(client, prior); // The accepted snapshot, never a later recapture, wins.
      }
      // This check must share the submission's session lock: a prior service
      // read is not enough when reset races with a promotion. Even when no
      // generation was supplied, the source must belong to the current one.
      if (promotedFrom) {
        const source = await client.query(`SELECT 1 FROM chat_inputs WHERE agent_id=$1 AND session_id=$2 AND generation=$3
          AND id::text=lower($4) AND intent='side_question' AND status='succeeded'`, [...ids, current, promotedFrom]);
        if (!source.rows.length) throw bad('chat_input_promotion_source_invalid');
      }
      if (capturedSnapshot.error) throw capturedSnapshot.error;
      const snapshot = capturedSnapshot.value;
      if (snapshot !== null && (typeof snapshot !== 'object' || Array.isArray(snapshot))) throw bad('chat_input_invalid_snapshot');
      if (snapshot?.entryCount != null && (!Number.isSafeInteger(snapshot.entryCount) || snapshot.entryCount < 0)) throw bad('chat_input_invalid_snapshot');
      for (const key of ['id', 'capturedAt', 'originRunId', 'phase']) {
        if (snapshot?.[key] != null && typeof snapshot[key] !== 'string') throw bad('chat_input_invalid_snapshot');
      }
      const hold = (await client.query(`SELECT held FROM chat_input_sessions WHERE agent_id=$1 AND session_id=$2 AND generation=$3`, [...ids, current])).rows[0]?.held;
      const id = randomUUID(), status = intent === 'queue_next' && hold ? 'held' : 'queued', runId = `input-${id}`;
      const { rows } = await client.query(`INSERT INTO chat_inputs(id,agent_id,session_id,generation,intent,status,idempotency_key,message,attachments,target_run_id,promoted_from,snapshot,run_id,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8::json,$9::json,$10,$11,$12::json,$13,$14) RETURNING *`,
      [id, ...ids, current, intent, status, idempotencyKey, JSON.stringify(message), JSON.stringify(safeAttachments), targetRunId, promotedFrom, snapshot == null ? null : JSON.stringify(snapshot), runId, now]);
      const row = rows[0];
      // Proof details recognize actual user messages. Side questions remain out
      // of model context through entersPrompt=false; queued requests keep their
      // event type until the normal runtime appends the prompt-bearing turn.
      const question = { id, sessionId: ids[1], runId, ts: now, timestamp: now, type: intent === 'side_question' ? 'message' : 'event', role: 'user', content: message,
        entersPrompt: false, visibility: 'chat', metadata: { chatInput: metadata(row),
          ...(safeAttachments.length ? { attachments: attachmentSummary(safeAttachments) } : {}),
          ...(intent === 'side_question' ? { lane: 'side_question' } : {}) } };
      await append(client, row, question, now);
      await lifecycle(client, row, now);
      return project(client, row);
    });
  }
  async findByKey(args = {}) {
    const ids = scope(args); required(args.idempotencyKey, 'idempotencyKey');
    const { rows } = await this.pool.query(`SELECT i.* FROM chat_inputs i JOIN conversation_sessions s USING(agent_id,session_id)
      WHERE i.agent_id=$1 AND i.session_id=$2 AND i.idempotency_key=$3
      AND i.generation=COALESCE((s.metadata->>'resetGeneration')::bigint,0)`, [...ids,args.idempotencyKey]);
    return rows[0] ? publicRow(rows[0]) : null;
  }
  async list(args = {}) {
    const ids = scope(args);
    // One statement ensures list and generation represent the same snapshot.
    const { rows } = await this.pool.query(`SELECT s.generation AS current_generation,i.* FROM
      (SELECT COALESCE((SELECT (metadata->>'resetGeneration')::bigint FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2),0) AS generation) s
      LEFT JOIN chat_inputs i ON i.agent_id=$1 AND i.session_id=$2 AND i.generation=s.generation ORDER BY i.ordinal`, ids);
    const generation = Number(rows[0].current_generation); let position = 0;
    return { generation, inputs: rows.filter(row => row.id).map(row => publicRow(row,
      row.intent === 'queue_next' && ['queued', 'held'].includes(row.status) ? ++position : null)) };
  }
  async read(args = {}) { return this.list(args); }
  async get(args = {}) {
    const ids = scope(args); uuid(args.id);
    return withPostgresTransaction(this.pool, async client => {
      const current = await sessionLock(client, ids, nowIso(this.clock));
      if (current === null) return null;
      const row = (await client.query('SELECT * FROM chat_inputs WHERE agent_id=$1 AND session_id=$2 AND generation=$3 AND id=$4', [...ids, current, args.id])).rows[0];
      return row ? project(client, row) : null;
    });
  }
  // Only current-generation pending rows; held work is pending too. This read
  // cannot mutate admission/ordering and never returns messages or SQL details.
  async queueTelemetrySnapshot({ signal } = {}) {
    // Sampling has a small total checkout + query budget. A timed-out checkout
    // is still owned/released by withPostgresTransaction; an active statement
    // is cancelled and drained before its client is released. The server-side
    // timeout also bounds lock waits if delivery of CancelRequest is delayed.
    const budgetMs = 250;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('chat_queue_observation_timeout')), budgetMs);
    timer.unref?.();
    const observationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
      return await withPostgresTransaction(this.pool, async client => {
        await client.query(`SET LOCAL statement_timeout = '${budgetMs}ms'`);
        const { rows } = await client.query(`SELECT i.intent,count(*) AS pending_depth,
          GREATEST(0,EXTRACT(EPOCH FROM ($1::timestamptz-min(i.created_at)))*1000) AS oldest_age_ms
          FROM chat_inputs i JOIN conversation_sessions s USING(agent_id,session_id)
          WHERE i.status IN ('queued','held') AND i.generation=COALESCE((s.metadata->>'resetGeneration')::bigint,0)
          GROUP BY i.intent`, [nowIso(this.clock)]);
        return ['queue_next', 'side_question'].map(intent => {
          const row = rows.find(item => item.intent === intent);
          return { intent, pendingDepth: row ? Number(row.pending_depth) : 0, oldestAgeMs: row ? Number(row.oldest_age_ms) : 0 };
        });
      }, { signal: observationSignal });
    } finally { clearTimeout(timer); }
  }
  async pendingMainScopes() {
    const { rows }=await this.pool.query(`SELECT DISTINCT i.agent_id,i.session_id FROM chat_inputs i
      JOIN conversation_sessions s USING(agent_id,session_id)
      JOIN continuity_state c USING(agent_id,session_id)
      WHERE i.intent='queue_next' AND i.status='queued' AND i.generation=COALESCE((s.metadata->>'resetGeneration')::bigint,0)
      AND (c.head_state IN ('running','finalizing') OR c.queue_status IN ('pending','running'))`);
    return rows.map(row=>({agentId:row.agent_id,sessionId:row.session_id}));
  }
  async owner(ownerId) {
    required(ownerId, 'ownerId');
    let owner = this.owners.get(ownerId);
    if (!owner) { owner = createContinuityOwner(this.pool); this.owners.set(ownerId, owner); }
    try { await owner.ready(); }
    catch (error) { if (this.owners.get(ownerId) === owner) this.owners.delete(ownerId); await owner.close().catch(() => {}); throw error; }
    return owner;
  }
  async claim({ ownerId } = {}) {
    required(ownerId, 'ownerId');
    const prior = this.claims.get(ownerId) || Promise.resolve();
    const task = prior.catch(() => {}).then(() => this.claimOnce(ownerId));
    this.claims.set(ownerId, task);
    try { return await task; }
    finally { if (this.claims.get(ownerId) === task) this.claims.delete(ownerId); }
  }
  async claimOnce(ownerId) {
    const owner = await this.owner(ownerId);
    const uncertain = this.uncertainClaims.get(ownerId);
    if (uncertain) {
      const row = (await this.pool.query(`SELECT i.*,COALESCE((s.metadata->>'resetGeneration')::bigint,0) AS current_generation
        FROM chat_inputs i JOIN conversation_sessions s USING(agent_id,session_id) WHERE i.id=$1`, [uncertain])).rows[0];
      if (row?.status === 'running' && row.owner_id === ownerId && row.owner_lock_id === owner.id) {
        if (Number(row.current_generation) !== Number(row.generation)) {
          await this.complete(row.id, { ownerId, ownerLockId: owner.id, status: 'interrupted', error: 'chat_input_session_reset' });
        } else {
          this.uncertainClaims.delete(ownerId);
          return { ...publicRow(row), snapshot: row.snapshot, ownerLockId: owner.id };
        }
      }
      this.uncertainClaims.delete(ownerId);
    }
    let candidate = null;
    try { return await owner.guard(() => withPostgresTransaction(this.pool, async client => {
      // All mutations, including continuity, serialize on the session row.
      // SKIP LOCKED avoids blocking other sessions or selecting a row in an
      // in-flight transition; after acquiring the lock, a new statement is
      // still necessary because READ COMMITTED's selection snapshot may have
      // preceded a transition which committed just before lock acquisition.
      const skipped = [];
      for (;;) {
        const { rows } = await client.query(`SELECT i.* FROM chat_inputs i
          JOIN conversation_sessions s ON s.agent_id=i.agent_id AND s.session_id=i.session_id
          LEFT JOIN chat_input_sessions h ON h.agent_id=i.agent_id AND h.session_id=i.session_id
          WHERE ${CLAIM_ELIGIBILITY_SQL} AND NOT (i.id=ANY($1::uuid[]))
          ORDER BY i.ordinal LIMIT 1 FOR UPDATE OF s SKIP LOCKED`, [skipped]);
        if (!rows.length) return null;
        const current = await client.query(`SELECT i.id FROM chat_inputs i
          JOIN conversation_sessions s ON s.agent_id=i.agent_id AND s.session_id=i.session_id
          LEFT JOIN chat_input_sessions h ON h.agent_id=i.agent_id AND h.session_id=i.session_id
          WHERE i.id=$1 AND ${CLAIM_ELIGIBILITY_SQL}`, [rows[0].id]);
        if (current.rows.length) { candidate = rows[0].id; break; }
        skipped.push(rows[0].id);
      }
      const now = nowIso(this.clock);
      const claimed = (await client.query(`UPDATE chat_inputs SET status='running',owner_id=$2,owner_lock_id=$3,started_at=$4
        WHERE id=$1 AND status='queued' RETURNING *`, [candidate, ownerId, owner.id, now])).rows[0];
      if (!claimed) return null;
      await lifecycle(client, claimed, now);
      return { ...publicRow(claimed), snapshot: claimed.snapshot, ownerLockId: owner.id };
    })); } catch (error) { if (candidate) this.uncertainClaims.set(ownerId, candidate); throw error; }
  }
  async complete(id, { ownerId, ownerLockId, status = 'succeeded', result = null, error = null, traceDir = null } = {}) {
    uuid(id); required(ownerId, 'ownerId'); uuid(ownerLockId, 'ownerLockId');
    if (!['succeeded', 'failed', 'cancelled', 'interrupted'].includes(status)) throw bad('chat_input_invalid_status');
    if (result !== null && (typeof result !== 'object' || Array.isArray(result))) throw bad('chat_input_invalid_result');
    result = result === null ? null : jsonClone(result, 'result');
    if (error !== null && typeof error !== 'string') throw bad('chat_input_invalid_error');
    if (traceDir !== null && typeof traceDir !== 'string') throw bad('chat_input_invalid_traceDir');
    // Map the original receipt deterministically using the durable flag, both
    // before writing and on retry (including a lost COMMIT acknowledgement).
    // A cancelled completion retains the runner's result/trace for diagnosis,
    // but cannot publish a side answer. Reset's terminal receipt is a fence,
    // never an idempotent completion owned by the old runner.
    const effective = row => row?.cancel_requested && status !== 'interrupted'
      ? { status: 'cancelled', error: 'chat_input_cancelled' } : { status, error };
    const matches = row => {
      if (!row) return false;
      const final = effective(row);
      return row.status === final.status && row.terminal_owner_id === ownerId && row.terminal_owner_lock_id === ownerLockId
        && row.terminal_receipt_status === status && row.terminal_receipt_error === error
        && isDeepStrictEqual(row.result, result) && row.error === final.error && row.trace_dir === traceDir;
    };
    const prior = (await this.pool.query('SELECT * FROM chat_inputs WHERE id=$1', [id])).rows[0];
    if (matches(prior)) return publicRow(prior);
    if (prior?.status !== 'running') throw bad('chat_input_owner_fenced', 409);
    const owner = this.owners.get(ownerId);
    if (!prior || !owner || owner.id !== ownerLockId || prior.owner_id !== ownerId || prior.owner_lock_id !== ownerLockId) throw bad('chat_input_owner_fenced', 409);
    return owner.guard(() => withPostgresTransaction(this.pool, async client => {
      const current = await sessionLock(client, [prior.agent_id, prior.session_id], nowIso(this.clock));
      const row = (await client.query('SELECT * FROM chat_inputs WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (matches(row)) return publicRow(row);
      if (!row || row.status !== 'running' || row.owner_id !== ownerId || row.owner_lock_id !== ownerLockId) throw bad('chat_input_owner_fenced', 409);
      const final = effective(row);
      if (row.intent === 'side_question' && final.status === 'succeeded' && typeof (result?.answerText ?? result?.answer) !== 'string') throw bad('chat_input_answer_required');
      const now = nowIso(this.clock);
      const done = (await client.query(`UPDATE chat_inputs SET status=$2,result=$3::json,error=$4,trace_dir=$5,completed_at=$6,
        terminal_owner_id=owner_id,terminal_owner_lock_id=owner_lock_id,terminal_receipt_status=$7,terminal_receipt_error=$8,
        owner_id=NULL,owner_lock_id=NULL WHERE id=$1 RETURNING *`,
      [id, final.status, result === null ? null : JSON.stringify(result), final.error, traceDir, now, status, error])).rows[0];
      // A completion racing with reset is durable but must never repopulate the
      // new generation's conversation with old results or lifecycle entries.
      if (Number(done.generation) === current) { await sideAnswer(client, done, now); await lifecycle(client, done, now); }
      return publicRow(done);
    }), migrationLockKey(`burrow-session-boundary:${JSON.stringify([prior.agent_id,prior.session_id])}`));
  }
  async cancel(args = {}) {
    const ids = scope(args); uuid(args.id);
    return withPostgresTransaction(this.pool, async client => {
      const current = await sessionLock(client, ids, nowIso(this.clock));
      if (current === null) return null;
      const row = (await client.query('SELECT * FROM chat_inputs WHERE agent_id=$1 AND session_id=$2 AND generation=$3 AND id=$4 FOR UPDATE', [...ids, current, args.id])).rows[0];
      if (!row) return null;
      const now = nowIso(this.clock);
      if (row.status === 'running') {
        // This hold and flag are one transaction, so no later claim/submission
        // can escape between cancellation and holding the main queue. Side
        // cancellations do not affect the independent main lane.
        if (row.cancel_requested) return project(client, row);
        if (row.intent === 'queue_next') await setSessionHold(client, ids, current, true, now);
        const requested = (await client.query('UPDATE chat_inputs SET cancel_requested=TRUE WHERE id=$1 RETURNING *', [row.id])).rows[0];
        await lifecycle(client, requested, now);
        return publicRow(requested);
      }
      if (!['queued', 'held'].includes(row.status)) return project(client, row);
      const cancelled = (await client.query("UPDATE chat_inputs SET status='cancelled',cancel_requested=TRUE,completed_at=$2 WHERE id=$1 RETURNING *", [row.id, now])).rows[0];
      await lifecycle(client, cancelled, now); return publicRow(cancelled);
    });
  }
  async holdSession(args = {}) { return this.changeHold(args, true); }
  async resume(args = {}) { return this.changeHold(args, false); }
  async changeHold(args, held) {
    const ids = scope(args);
    return withPostgresTransaction(this.pool, async client => {
      const now = nowIso(this.clock), current = await sessionLock(client, ids, now, true);
      if (args.generation !== undefined && args.generation !== current) throw bad('chat_input_generation_conflict', 409);
      const rows = await setSessionHold(client, ids, current, held, now);
      if (held) {
        const running = (await client.query("UPDATE chat_inputs SET cancel_requested=TRUE WHERE agent_id=$1 AND session_id=$2 AND generation=$3 AND intent='queue_next' AND status='running' AND NOT cancel_requested RETURNING *", [...ids,current])).rows;
        for(const row of running) await lifecycle(client,row,now);
      }
      return Promise.all(rows.map(row => project(client, row)));
    });
  }
  async cancelGeneration(args = {}) {
    const ids = scope(args);
    if (args.generation !== undefined && (!Number.isSafeInteger(args.generation) || args.generation < 0)) throw bad('chat_input_invalid_generation');
    return withPostgresTransaction(this.pool, async client => {
      const now = nowIso(this.clock), current = await sessionLock(client, ids, now);
      if (current === null) return [];
      // If generation is omitted, fence the current pending queue before reset.
      // After reset callers should pass its returned generation minus one: that
      // cannot accidentally cancel inputs submitted to the new generation.
      const target = args.generation ?? current;
      if (target > current) throw bad('chat_input_generation_conflict', 409);
      const { rows } = await client.query(`UPDATE chat_inputs SET status='cancelled',completed_at=$4 WHERE agent_id=$1 AND session_id=$2
        AND generation<=$3 AND status IN ('queued','held') RETURNING *`, [...ids, target, now]);
      rows.sort((a, b) => BigInt(a.ordinal) < BigInt(b.ordinal) ? -1 : 1);
      // Old questions already belong to the reset archive, not this transcript.
      for (const row of rows) if (Number(row.generation) === current) await lifecycle(client, row, now);
      return rows.map(row => publicRow(row));
    });
  }
  async reconcileInterrupted({ ownerId } = {}) {
    if (ownerId !== undefined) required(ownerId, 'ownerId');
    const probe = createContinuityOwner(this.pool);
    try {
      const candidates = (await this.pool.query("SELECT id,agent_id,session_id FROM chat_inputs WHERE status='running' AND ($1::text IS NULL OR owner_id=$1) ORDER BY ordinal", [ownerId ?? null])).rows;
      const interrupted = [];
      for (const candidate of candidates) {
        const startedAt = performance.now();
        // The shared reset boundary serializes death probing against active
        // terminal guards and against reset while examining session state.
        const value = await probe.guard(() => withPostgresTransaction(this.pool, async client => {
          const now = nowIso(this.clock), current = await sessionLock(client, [candidate.agent_id, candidate.session_id], now);
          const row = (await client.query('SELECT * FROM chat_inputs WHERE id=$1 FOR UPDATE', [candidate.id])).rows[0];
          if (!row || row.status !== 'running' || (ownerId !== undefined && row.owner_id !== ownerId) || await probe.alive(row.owner_lock_id)) return null;
          const done = (await client.query(`UPDATE chat_inputs SET status='interrupted',error='chat_input_owner_lost',completed_at=$2,
            terminal_owner_id=owner_id,terminal_owner_lock_id=owner_lock_id,owner_id=NULL,owner_lock_id=NULL WHERE id=$1 RETURNING *`, [row.id, now])).rows[0];
          if (Number(row.generation) === current) await lifecycle(client, done, now);
          return publicRow(done);
        }), migrationLockKey(`burrow-session-boundary:${JSON.stringify([candidate.agent_id,candidate.session_id])}`));
        if (value) {
          interrupted.push(value);
          operationalTelemetry('run-interrupted', { sessionId: value.sessionId, runId: value.runId, source: value.intent === 'side_question' ? 'side_question' : 'main',
            outcome: 'recorded', reason: 'queue_owner_lost', durationMs: Math.max(0, performance.now() - startedAt) });
        }
      }
      return interrupted;
    } finally { await probe.close(); }
  }
  async interruptOwner(ownerId) {
    required(ownerId, 'ownerId');
    // Wait for in-flight claim acknowledgement before fencing the owner. Callers
    // must stop scheduling new claims for this owner before shutdown begins.
    await this.claims.get(ownerId)?.catch(() => {});
    const owner = this.owners.get(ownerId);
    if (!owner) return [];
    const candidates = (await this.pool.query("SELECT id,agent_id,session_id FROM chat_inputs WHERE status='running' AND owner_id=$1 AND owner_lock_id=$2 ORDER BY ordinal", [ownerId, owner.id])).rows;
    const interrupted = [];
    for (const candidate of candidates) {
      const startedAt = performance.now();
      const value = await withPostgresTransaction(this.pool, async client => {
        const now = nowIso(this.clock), current = await sessionLock(client, [candidate.agent_id, candidate.session_id], now);
        const row = (await client.query(`UPDATE chat_inputs SET status='interrupted',error='chat_input_owner_shutdown',completed_at=$4,
          terminal_owner_id=owner_id,terminal_owner_lock_id=owner_lock_id,owner_id=NULL,owner_lock_id=NULL
          WHERE id=$1 AND status='running' AND owner_id=$2 AND owner_lock_id=$3 RETURNING *`, [candidate.id, ownerId, owner.id, now])).rows[0];
        if (!row) return null;
        if (Number(row.generation) === current) await lifecycle(client, row, now);
        return publicRow(row);
      });
      if (value) {
        interrupted.push(value);
        operationalTelemetry('run-interrupted', { sessionId: value.sessionId, runId: value.runId, source: value.intent === 'side_question' ? 'side_question' : 'main',
          outcome: 'recorded', reason: 'queue_owner_shutdown', durationMs: Math.max(0, performance.now() - startedAt) });
      }
    }
    if (this.owners.get(ownerId) === owner) this.owners.delete(ownerId);
    this.uncertainClaims.delete(ownerId); await owner.close();
    return interrupted;
  }
  async close() { await Promise.all([...this.owners.values()].map(owner => owner.close())); this.owners.clear(); }
}
