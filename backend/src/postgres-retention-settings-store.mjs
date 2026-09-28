import { DEFAULT_RETENTION_POLICY, normalizeRetentionPolicy } from './retention-settings.mjs';
import { withPostgresTransaction } from './postgres-foundation.mjs';

export const POSTGRES_RETENTION_SETTINGS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS retention_settings (
  owner_id TEXT PRIMARY KEY, policy_json JSONB NOT NULL, state_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL
);`;
const text = (v) => String(v ?? '').trim();
const fallbackState = () => ({ lastRunAt: null, lastResult: null, lastError: null, nextRunAt: null });
export class PostgresRetentionSettingsStore {
  constructor({ pool, ownerId = 'default', clock = () => new Date().toISOString() } = {}) { if (!pool?.query || !pool?.connect) throw new Error('retention_settings_postgres_pool_required'); if (!text(ownerId)) throw new Error('retention_settings_owner_id_required'); this.pool = pool; this.ownerId = text(ownerId); this.clock = clock; }
  async readPolicy() { const { rows } = await this.pool.query('SELECT policy_json FROM retention_settings WHERE owner_id=$1', [this.ownerId]); try { return normalizeRetentionPolicy(rows[0]?.policy_json || {}, DEFAULT_RETENTION_POLICY); } catch { return { ...DEFAULT_RETENTION_POLICY }; } }
  async savePolicy(input = {}) { return withPostgresTransaction(this.pool, async (client) => { await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`retention-settings:${this.ownerId}`]); const { rows } = await client.query('SELECT policy_json,state_json FROM retention_settings WHERE owner_id=$1 FOR UPDATE', [this.ownerId]); const current = rows[0] ? normalizeRetentionPolicy(rows[0].policy_json, DEFAULT_RETENTION_POLICY) : DEFAULT_RETENTION_POLICY; const policy = normalizeRetentionPolicy(input, current); const state = rows[0]?.state_json || fallbackState(); await client.query(`INSERT INTO retention_settings(owner_id,policy_json,state_json,updated_at) VALUES($1,$2::jsonb,$3::jsonb,$4) ON CONFLICT(owner_id) DO UPDATE SET policy_json=EXCLUDED.policy_json,updated_at=EXCLUDED.updated_at`, [this.ownerId, JSON.stringify(policy), JSON.stringify(state), this.clock()]); return policy; }); }
  async readState() { const { rows } = await this.pool.query('SELECT state_json FROM retention_settings WHERE owner_id=$1', [this.ownerId]); return rows[0]?.state_json || fallbackState(); }
  async writeState(state) { return withPostgresTransaction(this.pool, async (client) => { await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`retention-settings:${this.ownerId}`]); const q = await client.query('SELECT policy_json FROM retention_settings WHERE owner_id=$1 FOR UPDATE', [this.ownerId]); const policy = q.rows[0] ? q.rows[0].policy_json : DEFAULT_RETENTION_POLICY; await client.query(`INSERT INTO retention_settings(owner_id,policy_json,state_json,updated_at) VALUES($1,$2::jsonb,$3::jsonb,$4) ON CONFLICT(owner_id) DO UPDATE SET state_json=EXCLUDED.state_json,updated_at=EXCLUDED.updated_at`, [this.ownerId, JSON.stringify(policy), JSON.stringify(state), this.clock()]); return state; }); }
}
export default PostgresRetentionSettingsStore;
