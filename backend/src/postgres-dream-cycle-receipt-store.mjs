import { operatorTimezone } from './timezone.mjs';
import { PostgresSettingsMetadataStore } from './postgres-settings-metadata-store.mjs';
import { randomUUID } from 'node:crypto';
import { closePostgresPool, withPostgresTransaction } from './postgres-foundation.mjs';
import { nextCronOccurrence } from './scheduled-job-store.mjs';
import { reconciledDreamCycleState } from './dream-cycle-state.mjs';

const text = (value) => String(value ?? '').trim();
const json = (value) => JSON.stringify(value ?? {});
const parse = (value) => { if (value && typeof value === 'object') return value; try { return JSON.parse(value || '{}'); } catch { return {}; } };



function lockAgent(client, agentId) {
  return client.query('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [agentId]);
}

function upsertState(client, state, at) {
  return client.query(`INSERT INTO dream_cycle_state(agent_id,state_json,updated_at) VALUES($1,$2::jsonb,$3)
    ON CONFLICT(agent_id) DO UPDATE SET state_json=EXCLUDED.state_json,updated_at=EXCLUDED.updated_at`,
  [state.agentId, json(state), at]);
}

function readLockedState(client, agentId) {
  return client.query('SELECT state_json FROM dream_cycle_state WHERE agent_id=$1 FOR UPDATE', [agentId]);
}

function readState(row) { return row?.state_json ? parse(row.state_json) : null; }

export const POSTGRES_DREAM_CYCLE_RECEIPT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dream_cycle_state (agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE, state_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
CREATE TABLE IF NOT EXISTS dream_cycle_occurrences (agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, scheduled_for TEXT NOT NULL, occurrence_json JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(agent_id, scheduled_for));
CREATE TABLE IF NOT EXISTS dream_cycle_receipts (agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE, run_id TEXT NOT NULL, receipt_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL, PRIMARY KEY(agent_id, run_id));
CREATE INDEX IF NOT EXISTS dream_cycle_receipts_agent_updated_idx ON dream_cycle_receipts(agent_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS dream_cycle_receipts_updated_idx ON dream_cycle_receipts(updated_at DESC);
`;
export const DREAM_CYCLE_RECEIPT_SCHEMA_SQL = POSTGRES_DREAM_CYCLE_RECEIPT_SCHEMA_SQL;

export class PostgresDreamCycleReceiptStore {
  constructor({ pool, ownsPool = false, clock = () => new Date().toISOString(), runtimeInstanceId = randomUUID() } = {}) {
    if (!pool?.query || !pool?.connect) throw new Error('dream_cycle_postgres_pool_required');
    this.pool = pool; this.ownsPool = ownsPool; this.clock = clock; this.runtimeInstanceId = runtimeInstanceId;
  }
  async close() { if (this.ownsPool) await closePostgresPool(this.pool); }
  async getState(agentId, client = this.pool) {
    const r = await client.query('SELECT state_json FROM dream_cycle_state WHERE agent_id=$1', [text(agentId)]);
    return r.rows[0] ? parse(r.rows[0].state_json) : null;
  }
  async ensureState({ agentId, settings = {}, at = this.clock() }) {
    const id = text(agentId); if (!id) throw new Error('dream_cycle_agent_required');
    return withPostgresTransaction(this.pool, async (client) => {
      const agent = await lockAgent(client, id);
      if (!agent.rows[0]) throw new Error('agent_not_found');
      const existing = readState((await readLockedState(client, id)).rows[0]);
      // Completion must reconcile against settings changed while the model ran,
      // not the snapshot captured when the run started.
      let configured = (await client.query('SELECT enabled,cron_expression,timezone FROM dream_settings WHERE agent_id=$1', [id])).rows[0] || settings;
      configured = { ...configured, effectiveTimezone: configured.timezone ?? await operatorTimezone(new PostgresSettingsMetadataStore({ pool: client })) };
      const state = { ...reconciledDreamCycleState({ agentId: id, settings: configured, current: existing || {}, at }), lastRunAt: settings.lastRunAt || existing?.lastRunAt || null };
      await upsertState(client, state, at);
      return state;
    });
  }
  async claimDue({ agentId, at = this.clock() }) {
    const id = text(agentId); if (!id) throw new Error('dream_cycle_agent_required');
    return withPostgresTransaction(this.pool, async (client) => {
      const agent = await lockAgent(client, id);
      if (!agent.rows[0]) throw new Error('agent_not_found');
      let configured = (await client.query('SELECT enabled,cron_expression,timezone FROM dream_settings WHERE agent_id=$1', [id])).rows[0];
      if (!configured) return null;
      configured = { ...configured, effectiveTimezone: configured.timezone ?? await operatorTimezone(new PostgresSettingsMetadataStore({ pool: client })) };
      const current = readState((await readLockedState(client, id)).rows[0]);
      const state = reconciledDreamCycleState({ agentId: id, settings: configured, current: current || {}, at });
      const scheduledFor = state.nextRunAt;
      if (!state.enabled || !scheduledFor || scheduledFor > at) { await upsertState(client, state, at); return null; }
      const runId = `dream-cycle-${randomUUID()}`;
      const nextRunAt = nextCronOccurrence(state.cron, state.timezone, new Date(scheduledFor));
      const occurrence = { version: 1, agentId: id, runId, scheduledFor, claimedAt: at, nextRunAt };
      const inserted = await client.query('INSERT INTO dream_cycle_occurrences(agent_id,scheduled_for,occurrence_json,created_at) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(agent_id,scheduled_for) DO NOTHING RETURNING agent_id', [id, scheduledFor, json(occurrence), at]);
      if (!inserted.rows[0]) return null;
      await upsertState(client, { ...state, nextRunAt, updatedAt: at }, at);
      await this.write({ version: 1, ok: null, status: 'running', runId, agentId: id, trigger: 'scheduled', scheduledFor, generatedAt: scheduledFor, startedAt: at, runtimeInstanceId: this.runtimeInstanceId, error: null }, at, client);
      return { agentId: id, runId, scheduledFor, nextRunAt };
    });
  }
  async write(receipt, at = this.clock(), client = this.pool) {
    const agentId = text(receipt?.agentId), runId = text(receipt?.runId);
    if (!agentId || !runId) throw new Error('dream_cycle_receipt_required');
    await client.query(`INSERT INTO dream_cycle_receipts(agent_id,run_id,receipt_json,updated_at) VALUES($1,$2,$3::jsonb,$4) ON CONFLICT(agent_id,run_id) DO UPDATE SET receipt_json=EXCLUDED.receipt_json,updated_at=EXCLUDED.updated_at`, [agentId, runId, json(receipt), at]);
    return receipt;
  }
  async reconcileInterruptedDreamCycles(options = {}) { return this.reconcileInterrupted(options); }

  async reconcileInterrupted({ at = this.clock(), runtimeInstanceId = this.runtimeInstanceId, activeRunIds = new Set(), error = 'Dream interrupted by runtime restart before completion' } = {}) {
    return withPostgresTransaction(this.pool, async (client) => {
      const rows = await client.query("SELECT agent_id,run_id,receipt_json FROM dream_cycle_receipts WHERE receipt_json->>'status'='running' FOR UPDATE");
      let count = 0;
      for (const row of rows.rows) {
        const receipt = parse(row.receipt_json);
        if (activeRunIds.has(receipt.runId) || receipt.runtimeInstanceId === runtimeInstanceId) continue;
        await this.write({ ...receipt, ok: false, status: 'interrupted', error, completedAt: at }, at, client);
        count++;
      }
      return count;
    });
  }
  async latestDreamCycleReceipts(options = {}) { return this.latest(options); }

  async latest({ agentId = null, limit = 20 } = {}) {
    const args = []; const where = agentId ? ` WHERE agent_id=$${args.push(text(agentId))}` : '';
    args.push(Math.max(1, Math.min(100, Number(limit) || 20)));
    const r = await this.pool.query(`SELECT receipt_json FROM dream_cycle_receipts${where} ORDER BY updated_at DESC LIMIT $${args.length}`, args);
    return r.rows.map((row) => parse(row.receipt_json));
  }
}
