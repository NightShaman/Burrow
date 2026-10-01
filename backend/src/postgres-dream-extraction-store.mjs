import { randomUUID } from 'node:crypto';

export const POSTGRES_DREAM_EXTRACTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dream_extraction_batches (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  sources JSONB NOT NULL,
  candidates JSONB NOT NULL,
  completed_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(agent_id, batch_id)
);
CREATE INDEX IF NOT EXISTS dream_extraction_batches_agent_idx ON dream_extraction_batches(agent_id);
`;

/** Derived, pre-reconciliation state. A row is an atomic successful checkpoint,
 * including empty answers. Never stores original conversations or summaries. */
export class PostgresDreamExtractionStore {
  constructor({ pool } = {}) {
    if (!pool?.query) throw new Error('dream_extraction_postgres_pool_required');
    this.pool = pool;
  }
  async list({ agentId }) {
    const result = await this.pool.query('SELECT batch_id,contract_version,sources,candidates FROM dream_extraction_batches WHERE agent_id=$1 ORDER BY completed_at,batch_id', [agentId]);
    return result.rows.map(row => ({ batchId: row.batch_id, contractVersion: row.contract_version, sources: row.sources, candidates: row.candidates }));
  }
  async checkpoint({ agentId, contractVersion, sources, candidates, completedAt }) {
    await this.pool.query('INSERT INTO dream_extraction_batches(agent_id,batch_id,contract_version,sources,candidates,completed_at) VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6)', [agentId, randomUUID(), contractVersion, JSON.stringify(sources), JSON.stringify(candidates), completedAt]);
  }
  async remove({ agentId, batchIds }) {
    if (batchIds.length) await this.pool.query('DELETE FROM dream_extraction_batches WHERE agent_id=$1 AND batch_id=ANY($2::text[])', [agentId, batchIds]);
  }
}
