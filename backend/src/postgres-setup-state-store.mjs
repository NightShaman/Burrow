export const POSTGRES_SETUP_STATE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS installation_setup_state (
  owner_id TEXT PRIMARY KEY,
  value_json JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);`;

const text = (value) => String(value ?? '').trim();
const status = (record, { started = false, blockers = [] } = {}) => {
  const configured = record?.configured === true;
  const installed = configured || record?.installed === true || started;
  return { ok: true, installed, configured, wizardStep: configured ? 'ready' : (installed ? 'incomplete' : 'fresh'), blockers: configured ? [] : blockers };
};

// The model is optional in first-run setup. Only persisted, usable identity and
// agent records count; client-supplied completion flags are never evidence.
async function requirements(client) {
  const [operator, agents] = await Promise.all([
    client.query("SELECT EXISTS(SELECT 1 FROM chat_identities WHERE kind='operator' AND id='default' AND length(btrim(name)) > 0) AS present"),
    client.query("SELECT EXISTS(SELECT 1 FROM agents WHERE length(btrim(name)) > 0) AS present"),
  ]);
  const blockers = [];
  if (!operator.rows[0]?.present) blockers.push('operator_identity_required');
  if (!agents.rows[0]?.present) blockers.push('agent_required');
  return { started: blockers.length < 2, blockers };
}

export class PostgresSetupStateStore {
  constructor({ pool, ownerId = 'default', clock = () => new Date().toISOString() } = {}) {
    if (!pool?.query || !pool?.connect) throw new Error('setup_state_postgres_pool_required');
    if (!text(ownerId)) throw new Error('setup_state_owner_id_required');
    this.pool = pool; this.ownerId = text(ownerId); this.clock = clock;
  }
  async readStatus() {
    const { rows } = await this.pool.query('SELECT value_json FROM installation_setup_state WHERE owner_id=$1', [this.ownerId]);
    const record = rows[0]?.value_json || null;
    if (record?.configured === true) return status(record);
    return status(record, await requirements(this.pool));
  }
  async completeSetup() {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`setup-state:${this.ownerId}`]);
      const { rows } = await client.query('SELECT value_json FROM installation_setup_state WHERE owner_id=$1 FOR UPDATE', [this.ownerId]);
      const prior = rows[0]?.value_json || null;
      if (prior?.configured === true) { await client.query('COMMIT'); return status(prior); }
      const readiness = await requirements(client);
      if (readiness.blockers.length) {
        await client.query('ROLLBACK');
        return { ...status(prior, readiness), ok: false, status: 409, error: 'setup_incomplete' };
      }
      const completedAt = this.clock();
      const value = { version: 1, installed: true, configured: true, completedAt };
      await client.query(`INSERT INTO installation_setup_state(owner_id,value_json,updated_at) VALUES($1,$2::jsonb,$3) ON CONFLICT(owner_id) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at`, [this.ownerId, JSON.stringify(value), completedAt]);
      await client.query('COMMIT');
      return status(value);
    } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
  }
}
export default PostgresSetupStateStore;
