import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { normalizePostgresPool } from './postgres-foundation.mjs';

export const POSTGRES_MOD_GENERATION_SCHEMA_SQL = `
CREATE TABLE mod_generations (
 id TEXT PRIMARY KEY,
 owner_mod_id TEXT NOT NULL,
 idempotency_key TEXT NOT NULL,
 payload JSONB NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','succeeded','failed','interrupted')),
 text TEXT,
 error TEXT,
 created_at TIMESTAMPTZ NOT NULL,
 updated_at TIMESTAMPTZ NOT NULL,
 started_at TIMESTAMPTZ,
 completed_at TIMESTAMPTZ,
 UNIQUE(owner_mod_id,idempotency_key)
);
CREATE INDEX mod_generations_owner_updated_idx ON mod_generations(owner_mod_id,updated_at DESC,id DESC);
`;
const iso = value => value instanceof Date ? value.toISOString() : String(value);
function row(record) {
  if (!record) return null;
  return { id: record.id, ownerModId: record.owner_mod_id, idempotencyKey: record.idempotency_key,
    payload: typeof record.payload === 'string' ? JSON.parse(record.payload) : record.payload,
    status: record.status, text: record.text, error: record.error, createdAt: iso(record.created_at),
    updatedAt: iso(record.updated_at), startedAt: record.started_at ? iso(record.started_at) : null,
    completedAt: record.completed_at ? iso(record.completed_at) : null };
}
export class PostgresModGenerationStore {
  constructor({ pool, clock = () => new Date().toISOString() } = {}) {
    if (!pool?.query) throw new Error('mod_generation_postgres_pool_required');
    this.pool = normalizePostgresPool(pool); this.clock = clock;
  }
  async create({ ownerModId, idempotencyKey, payload }) {
    const now = this.clock();
    const inserted = await this.pool.query(`INSERT INTO mod_generations(id,owner_mod_id,idempotency_key,payload,status,created_at,updated_at)
      VALUES($1,$2,$3,$4,'queued',$5,$5) ON CONFLICT(owner_mod_id,idempotency_key) DO NOTHING RETURNING *`,
    [randomUUID(), ownerModId, idempotencyKey, JSON.stringify(payload), now]);
    if (inserted.rows[0]) return { job: row(inserted.rows[0]), replayed: false };
    const job = await this.getByIdempotency(ownerModId, idempotencyKey);
    if (!job) throw new Error('mod_generation_persistence_failed');
    if (!isDeepStrictEqual(job.payload, payload)) throw new Error('mod_generation_idempotency_conflict');
    return { job, replayed: true };
  }
  async getByIdempotency(owner, key) {
    const result = await this.pool.query('SELECT * FROM mod_generations WHERE owner_mod_id=$1 AND idempotency_key=$2', [owner, key]);
    return row(result.rows[0]);
  }
  async getOwned(owner, id) {
    const result = await this.pool.query('SELECT * FROM mod_generations WHERE owner_mod_id=$1 AND id=$2', [owner, id]);
    return row(result.rows[0]);
  }
  async markRunning(id) {
    const now = this.clock();
    const result = await this.pool.query("UPDATE mod_generations SET status='running',started_at=$2,updated_at=$2 WHERE id=$1 AND status='queued' RETURNING *", [id, now]);
    return row(result.rows[0]);
  }
  async complete(id, { status, text = null, error = null }) {
    const now = this.clock();
    const result = await this.pool.query("UPDATE mod_generations SET status=$2,text=$3,error=$4,completed_at=$5,updated_at=$5 WHERE id=$1 AND status IN ('queued','running') RETURNING *", [id, status, text, error, now]);
    return row(result.rows[0]);
  }
  async interruptIncomplete(reason = 'core_restart_before_completion') {
    const now = this.clock();
    const result = await this.pool.query("UPDATE mod_generations SET status='interrupted',error=$1,completed_at=$2,updated_at=$2 WHERE status IN ('queued','running')", [reason, now]);
    return result.rowCount || 0;
  }
}
