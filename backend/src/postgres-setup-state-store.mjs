export const POSTGRES_SETUP_STATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS installation_setup_state (
  owner_id TEXT PRIMARY KEY,
  value_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);`;

const text = (value) => String(value ?? '').trim();
const status = (record) => {
  const installed = record?.installed === true;
  const configured = record?.configured === true;
  return { ok: true, installed, configured, wizardStep: configured ? 'ready' : (installed ? 'incomplete' : 'fresh'), blockers: configured ? [] : ['setup_not_completed'] };
};

export class PostgresSetupStateStore {
  constructor({ pool, ownerId = 'default', clock = () => new Date().toISOString() } = {}) {
    if (!pool?.query || !pool?.connect) throw new Error('setup_state_postgres_pool_required');
    if (!text(ownerId)) throw new Error('setup_state_owner_id_required');
    this.pool = pool; this.ownerId = text(ownerId); this.clock = clock;
  }
  async readStatus() {
    const { rows } = await this.pool.query('SELECT value_json FROM installation_setup_state WHERE owner_id=$1', [this.ownerId]);
    return status(rows[0]?.value_json || null);
  }
  async completeSetup() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`setup-state:${this.ownerId}`]);
      const { rows } = await client.query('SELECT value_json FROM installation_setup_state WHERE owner_id=$1 FOR UPDATE', [this.ownerId]);
      const prior = rows[0]?.value_json || null;
      const completedAt = prior?.completedAt || this.clock();
      const value = { version: 1, installed: true, configured: true, completedAt };
      await client.query(`INSERT INTO installation_setup_state(owner_id,value_json,updated_at) VALUES($1,$2::jsonb,$3) ON CONFLICT(owner_id) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at`, [this.ownerId, JSON.stringify(value), this.clock()]);
      await client.query('COMMIT');
      return status(value);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}
export default PostgresSetupStateStore;
