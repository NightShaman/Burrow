import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { normalizePostgresPool } from './postgres-foundation.mjs';

export const POSTGRES_MOD_MINION_SCHEMA_SQL = `
CREATE TABLE mod_minion_jobs (
  id UUID PRIMARY KEY,
  owner_mod_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed','interrupted','cancelled')),
  result JSONB,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE(owner_mod_id,idempotency_key)
);
CREATE INDEX mod_minion_jobs_owner_updated_idx ON mod_minion_jobs(owner_mod_id,updated_at DESC,id DESC);
`;

const iso = value => value instanceof Date ? value.toISOString() : String(value);
function row(record) {
  if (!record) return null;
  return {
    id: record.id, ownerModId: record.owner_mod_id, idempotencyKey: record.idempotency_key,
    payload: typeof record.payload === 'string' ? JSON.parse(record.payload) : record.payload,
    status: record.status,
    result: typeof record.result === 'string' ? JSON.parse(record.result) : record.result,
    error: record.error,
    createdAt: iso(record.created_at), updatedAt: iso(record.updated_at),
    startedAt: record.started_at ? iso(record.started_at) : null,
    completedAt: record.completed_at ? iso(record.completed_at) : null,
  };
}

export class PostgresModMinionStore {
  constructor({ pool, clock = () => new Date().toISOString() } = {}) {
    if (!pool?.query) throw new Error('mod_minion_postgres_pool_required');
    this.pool = normalizePostgresPool(pool);
    this.clock = clock;
  }

  async create({ ownerModId, idempotencyKey, payload }) {
    const now = this.clock();
    const inserted = await this.pool.query(`INSERT INTO mod_minion_jobs
      (id,owner_mod_id,idempotency_key,payload,status,created_at,updated_at)
      VALUES($1,$2,$3,$4::jsonb,'queued',$5,$5)
      ON CONFLICT(owner_mod_id,idempotency_key) DO NOTHING RETURNING *`,
    [randomUUID(), ownerModId, idempotencyKey, JSON.stringify(payload), now]);
    if (inserted.rows[0]) return { job: row(inserted.rows[0]), replayed: false };
    const existing = await this.getByKey(ownerModId, idempotencyKey);
    if (!existing) throw new Error('mod_minion_persistence_failed');
    this.assertSamePayload(existing, payload);
    return { job: existing, replayed: true };
  }

  // Session/entry tables FK to the identity registry, but a service principal
  // must never appear in the executable agents or personality/profile catalog.
  // Match Core's group-channel non-agent principal (archived=false) so agent
  // deletion reconciliation cannot mistake these durable reports for tombstones.
  async ensureServicePrincipal(agentId) {
    await this.pool.query(`INSERT INTO agent_identity_registry(agent_id,archived)
      VALUES($1,FALSE) ON CONFLICT(agent_id) DO NOTHING`, [agentId]);
    const realAgent = await this.pool.query('SELECT 1 FROM agents WHERE id=$1', [agentId]);
    if (realAgent.rowCount) throw new Error('mod_minion_service_identity_conflict');
  }

  assertSamePayload(existing, payload) {
    if (!isDeepStrictEqual(existing.payload, payload)) throw new Error('mod_minion_idempotency_conflict');
  }

  async getByKey(owner, key) {
    const result = await this.pool.query('SELECT * FROM mod_minion_jobs WHERE owner_mod_id=$1 AND idempotency_key=$2', [owner, key]);
    return row(result.rows[0]);
  }

  async getOwned(owner, id) {
    // Unknown mod-supplied IDs are not SQL UUIDs; ownership must still return
    // not found rather than leaking a driver cast error.
    if (typeof id !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)) return null;
    const result = await this.pool.query('SELECT * FROM mod_minion_jobs WHERE owner_mod_id=$1 AND id=$2', [owner, id]);
    return row(result.rows[0]);
  }

  async markRunning(id) {
    const now = this.clock();
    const result = await this.pool.query(`UPDATE mod_minion_jobs
      SET status='running',started_at=$2,updated_at=$2
      WHERE id=$1 AND status='queued' RETURNING *`, [id, now]);
    return row(result.rows[0]);
  }

  async complete(id, { status, result = null, error = null }) {
    const now = this.clock();
    const updated = await this.pool.query(`UPDATE mod_minion_jobs
      SET status=$2,result=$3::jsonb,error=$4,completed_at=$5,updated_at=$5
      WHERE id=$1 AND status IN ('queued','running') RETURNING *`,
    [id, status, result === null ? null : JSON.stringify(result), error, now]);
    return row(updated.rows[0]);
  }

  // Atomic claim for cancellation/shutdown: if dispatch already claimed the
  // queued job, the caller signals its running worker instead of overwriting it.
  async completeQueued(id, { status, error }) {
    const now = this.clock();
    const updated = await this.pool.query(`UPDATE mod_minion_jobs
      SET status=$2,error=$3,completed_at=$4,updated_at=$4
      WHERE id=$1 AND status='queued' RETURNING *`, [id, status, error, now]);
    return row(updated.rows[0]);
  }

  async interruptIncomplete(reason = 'core_restart_before_completion') {
    const now = this.clock();
    const updated = await this.pool.query(`UPDATE mod_minion_jobs
      SET status='interrupted',error=$1,completed_at=$2,updated_at=$2
      WHERE status IN ('queued','running')`, [reason, now]);
    return updated.rowCount || 0;
  }
}
