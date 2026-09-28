import { DEFAULT_WORKING_MEMORY_RETENTION, normalizeWorkingMemoryRetention } from './working-memory-retention-settings.mjs';
import { withPostgresTransaction } from './postgres-foundation.mjs';

export const POSTGRES_WORKING_MEMORY_RETENTION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS working_memory_retention_settings (
  owner_id TEXT PRIMARY KEY, value_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);`;
const text = (v) => String(v ?? '').trim();
export class PostgresWorkingMemoryRetentionSettingsStore {
  constructor({ pool, ownerId = 'default', clock = () => new Date().toISOString() } = {}) { if (!pool?.query || !pool?.connect) throw new Error('working_memory_retention_postgres_pool_required'); if (!text(ownerId)) throw new Error('working_memory_retention_owner_id_required'); this.pool = pool; this.ownerId = text(ownerId); this.clock = clock; }
  async read() { const { rows } = await this.pool.query('SELECT value_json FROM working_memory_retention_settings WHERE owner_id=$1', [this.ownerId]); try { return normalizeWorkingMemoryRetention(rows[0]?.value_json || {}, DEFAULT_WORKING_MEMORY_RETENTION); } catch { return { ...DEFAULT_WORKING_MEMORY_RETENTION }; } }
  async save(input = {}) { return withPostgresTransaction(this.pool, async (client) => { await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`working-memory-retention:${this.ownerId}`]); const { rows } = await client.query('SELECT value_json FROM working_memory_retention_settings WHERE owner_id=$1 FOR UPDATE', [this.ownerId]); const current = rows[0] ? normalizeWorkingMemoryRetention(rows[0].value_json, DEFAULT_WORKING_MEMORY_RETENTION) : DEFAULT_WORKING_MEMORY_RETENTION; const value = normalizeWorkingMemoryRetention(input, current); await client.query(`INSERT INTO working_memory_retention_settings(owner_id,value_json,updated_at) VALUES($1,$2::jsonb,$3) ON CONFLICT(owner_id) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at`, [this.ownerId, JSON.stringify(value), this.clock()]); return value; }); }
}
export default PostgresWorkingMemoryRetentionSettingsStore;
