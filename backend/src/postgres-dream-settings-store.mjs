import { normalizePostgresPool } from './postgres-foundation.mjs';
import { operatorTimezone } from './timezone.mjs';
import { PostgresSettingsMetadataStore } from './postgres-settings-metadata-store.mjs';
import { closePostgresPool, withPostgresTransaction } from './postgres-foundation.mjs';
import { DEFAULT_DREAM_PROMPT } from './dream-prompt-defaults.mjs';

export const POSTGRES_DREAM_SETTINGS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dream_settings (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  cron_expression TEXT NOT NULL,
  timezone TEXT NOT NULL,
  prompt TEXT NOT NULL,
  model_connection_id TEXT,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL
);
`;
export const DREAM_SETTINGS_SCHEMA_SQL = POSTGRES_DREAM_SETTINGS_SCHEMA_SQL;

const text = (value) => String(value ?? '').trim();
const timestamp = (value) => value instanceof Date ? value.toISOString() : value;
function agentId(value) { const result = text(value); if (!/^[A-Za-z0-9._-]{1,96}$/.test(result)) throw new Error('agent_id_invalid'); return result; }
function bool(value, fallback = true) { return value === undefined ? fallback : Boolean(value); }
function validTimezone(value) { try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; } catch { return false; } }
function cron(value) { const result = text(value || '0 4 * * *'); if (result.split(/\s+/).length !== 5) throw new Error('dream_settings_cron_invalid'); return result; }
function timezone(value) { if (value == null) return null; const result = text(value || 'UTC'); if (!validTimezone(result)) throw new Error('dream_settings_timezone_invalid'); return result; }
function prompt(value) { const result = value === undefined || value === null ? DEFAULT_DREAM_PROMPT : text(value); if (!result || result.length > 20_000) throw new Error('dream_settings_prompt_invalid'); return result; }
function modelId(value) { const result = text(value); if (!result) return null; if (result.length > 256) throw new Error('dream_settings_model_invalid'); return result; }
function parseModels(value) { if (Array.isArray(value)) return value; try { return JSON.parse(value || '[]'); } catch { return []; } }
function publicRow(row) { return row && { agentId: row.agent_id, enabled: Boolean(row.enabled), cron: row.cron_expression, timezone: row.timezone, prompt: row.prompt, modelConnectionId: row.model_connection_id || null, model: row.model || null, createdAt: timestamp(row.created_at), updatedAt: timestamp(row.updated_at) }; }

export class PostgresDreamSettingsStore {
  constructor({ pool, ownsPool = false } = {}) { if (!pool?.query || !pool?.connect) throw new Error('dream_settings_postgres_pool_required'); this.pool = normalizePostgresPool(pool); this.ownsPool = ownsPool; }
  async resolved(row, client = this.pool) { const value = publicRow(row); return value && { ...value, effectiveTimezone: value.timezone ?? await operatorTimezone(new PostgresSettingsMetadataStore({ pool: client })) }; }
  async close() { if (this.ownsPool) await closePostgresPool(this.pool); }
  async get(agent) {
    const id = agentId(agent);
    return withPostgresTransaction(this.pool, async (client) => {
      const agentResult = await client.query('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [id]);
      if (!agentResult.rows[0]) throw new Error('agent_not_found');
      const existing = await client.query('SELECT * FROM dream_settings WHERE agent_id=$1', [id]);
      if (existing.rows[0]) return this.resolved(existing.rows[0], client);
      const at = new Date().toISOString();
      const result = await client.query(`INSERT INTO dream_settings (agent_id,enabled,cron_expression,timezone,prompt,model_connection_id,model,created_at,updated_at) VALUES ($1,TRUE,'0 4 * * *',NULL,$2,NULL,NULL,$3,$3) RETURNING *`, [id, DEFAULT_DREAM_PROMPT, at]);
      return this.resolved(result.rows[0], client);
    });
  }
  async save(agent, input = {}) {
    const id = agentId(agent);
    return withPostgresTransaction(this.pool, async (client) => {
      const agentResult = await client.query('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [id]);
      if (!agentResult.rows[0]) throw new Error('agent_not_found');
      const currentResult = await client.query('SELECT * FROM dream_settings WHERE agent_id=$1', [id]);
      const current = publicRow(currentResult.rows[0]);
      const next = { enabled: bool(input.enabled, current?.enabled ?? true), cron: cron(input.cron ?? current?.cron ?? '0 4 * * *'), timezone: timezone(input.timezone === undefined ? current?.timezone ?? null : input.timezone), prompt: prompt(input.prompt ?? current?.prompt ?? DEFAULT_DREAM_PROMPT), modelConnectionId: input.modelConnectionId === undefined && input.connectionId === undefined ? (current?.modelConnectionId ?? null) : modelId(input.modelConnectionId ?? input.connectionId), model: input.model === undefined && input.modelId === undefined ? (current?.model ?? null) : modelId(input.model ?? input.modelId) };
      if (next.modelConnectionId || next.model) {
        if (!next.modelConnectionId || !next.model) throw new Error('dream_settings_model_selection_incomplete');
        const connection = await client.query('SELECT models_json::text AS models_json FROM model_connections WHERE id=$1', [next.modelConnectionId]);
        if (!connection.rows[0] || !parseModels(connection.rows[0].models_json).some((model) => model && model.selected !== false && text(model.id) === next.model)) throw new Error('dream_settings_model_selection_invalid');
      }
      const at = new Date().toISOString();
      const result = await client.query(`INSERT INTO dream_settings (agent_id,enabled,cron_expression,timezone,prompt,model_connection_id,model,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) ON CONFLICT (agent_id) DO UPDATE SET enabled=EXCLUDED.enabled,cron_expression=EXCLUDED.cron_expression,timezone=EXCLUDED.timezone,prompt=EXCLUDED.prompt,model_connection_id=EXCLUDED.model_connection_id,model=EXCLUDED.model,updated_at=EXCLUDED.updated_at RETURNING *`, [id, next.enabled, next.cron, next.timezone, next.prompt, next.modelConnectionId, next.model, at]);
      return this.resolved(result.rows[0], client);
    });
  }
}

export default PostgresDreamSettingsStore;
