import { randomUUID } from 'node:crypto';
import { normalizePostgresPool } from './postgres-foundation.mjs';

export const POSTGRES_MOD_EXTERNAL_TURN_SCHEMA_SQL = `
CREATE TABLE mod_external_turns (
 id TEXT PRIMARY KEY,
 owner_mod_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 agent_id TEXT NOT NULL,
 session_id TEXT NOT NULL,
 message TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','interrupted')),
 run_id TEXT,
 result JSONB,
 error TEXT,
 created_at TIMESTAMPTZ NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL,
 started_at TIMESTAMPTZ,
 completed_at TIMESTAMPTZ,
 UNIQUE(owner_mod_id,idempotency_key)
);
CREATE INDEX mod_external_turns_owner_updated_idx ON mod_external_turns(owner_mod_id,updated_at DESC,id DESC);
`;

const parse = value => value && typeof value === 'object' ? value : value ? JSON.parse(value) : null;
const iso = value => value instanceof Date ? value.toISOString() : String(value);
function row(record) {
  if (!record) return null;
  return {
    id: record.id,
    ownerModId: record.owner_mod_id,
    idempotencyKey: record.idempotency_key,
    agentId: record.agent_id,
    sessionId: record.session_id,
    message: record.message,
    displayMessage: record.display_message || record.message,
    status: record.status,
    runId: record.run_id,
    result: parse(record.result),
    error: record.error,
    createdAt: iso(record.created_at),
    updatedAt: iso(record.updated_at),
    startedAt: record.started_at ? iso(record.started_at) : null,
    completedAt: record.completed_at ? iso(record.completed_at) : null,
  };
}

export class PostgresModExternalTurnStore {
  constructor({ pool, clock = () => new Date().toISOString() } = {}) {
    if (!pool?.query) throw new Error('mod_external_turn_postgres_pool_required');
    this.pool = normalizePostgresPool(pool);
    this.clock = clock;
  }

  async create({ ownerModId, idempotencyKey, agentId, sessionId, message, displayMessage = message }) {
    const now = this.clock();
    const id = randomUUID();
    const inserted = await this.pool.query(
      `INSERT INTO mod_external_turns(id,owner_mod_id,idempotency_key,agent_id,session_id,message,display_message,status,created_at,updated_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,'queued',$8,$8)
       ON CONFLICT(owner_mod_id,idempotency_key) DO NOTHING RETURNING *`,
      [id, ownerModId, idempotencyKey, agentId, sessionId, message, displayMessage, now],
    );
    if (inserted.rows[0]) return { turn: row(inserted.rows[0]), replayed: false };
    const existing = await this.pool.query('SELECT * FROM mod_external_turns WHERE owner_mod_id=$1 AND idempotency_key=$2', [ownerModId, idempotencyKey]);
    const turn = row(existing.rows[0]);
    if (!turn) throw new Error('mod_external_turn_persistence_failed');
    if (turn.agentId !== agentId || turn.sessionId !== sessionId || turn.message !== message || turn.displayMessage !== displayMessage) throw new Error('mod_external_turn_idempotency_conflict');
    return { turn, replayed: true };
  }

  async getByIdempotency(ownerModId, idempotencyKey) {
    const result = await this.pool.query('SELECT * FROM mod_external_turns WHERE owner_mod_id=$1 AND idempotency_key=$2', [ownerModId, idempotencyKey]);
    return row(result.rows[0]);
  }

  async getOwned(ownerModId, id) {
    const result = await this.pool.query('SELECT * FROM mod_external_turns WHERE owner_mod_id=$1 AND id=$2', [ownerModId, id]);
    return row(result.rows[0]);
  }

  async markRunning(id, runId) {
    const now = this.clock();
    const result = await this.pool.query("UPDATE mod_external_turns SET status='running',run_id=$2,started_at=$3,updated_at=$3 WHERE id=$1 AND status='queued' RETURNING *", [id, runId, now]);
    return row(result.rows[0]);
  }

  async complete(id, { status, result = null, error = null }) {
    const now = this.clock();
    const updated = await this.pool.query("UPDATE mod_external_turns SET status=$2,result=$3,error=$4,completed_at=$5,updated_at=$5 WHERE id=$1 AND status IN ('queued','running') RETURNING *", [id, status, result === null ? null : JSON.stringify(result), error, now]);
    return row(updated.rows[0]);
  }

  async interruptIncomplete(reason = 'core_restart_before_completion') {
    const now = this.clock();
    const result = await this.pool.query("UPDATE mod_external_turns SET status='interrupted',error=$1,completed_at=$2,updated_at=$2 WHERE status IN ('queued','running')", [reason, now]);
    return result.rowCount || 0;
  }
}

export default PostgresModExternalTurnStore;
