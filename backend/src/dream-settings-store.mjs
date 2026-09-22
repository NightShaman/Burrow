import { DEFAULT_DREAM_PROMPT } from './dream-prompt-defaults.mjs';
import { openSettingsDatabase, settingsDatabasePath } from './settings-database.mjs';

export { DEFAULT_DREAM_PROMPT } from './dream-prompt-defaults.mjs';
export const DREAM_OPERATOR_CONTRACT = 'Operator Directs, Agent Decides, Runtime Proves.';

const text = (value) => String(value ?? '').trim();
const now = () => new Date().toISOString();
function bool(value, fallback = true) { return value === undefined ? fallback : Boolean(value); }
function validTimezone(timezone) { try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); return true; } catch { return false; } }
function agentId(value) { const result = text(value); if (!/^[A-Za-z0-9._-]{1,96}$/.test(result)) throw new Error('agent_id_invalid'); return result; }
function cron(value) { const result = text(value || '0 4 * * *'); if (result.split(/\s+/).length !== 5) throw new Error('dream_settings_cron_invalid'); return result; }
function timezone(value) { const result = text(value || 'UTC'); if (!validTimezone(result)) throw new Error('dream_settings_timezone_invalid'); return result; }
function prompt(value) { const result = value === undefined || value === null ? DEFAULT_DREAM_PROMPT : text(value); if (!result || result.length > 20_000) throw new Error('dream_settings_prompt_invalid'); return result; }
function nullableModelId(value) { const result = text(value); if (!result) return null; if (result.length > 256) throw new Error('dream_settings_model_invalid'); return result; }
function row(row) { return row && { agentId: row.agent_id, enabled: Boolean(row.enabled), cron: row.cron_expression, timezone: row.timezone, prompt: row.prompt, modelConnectionId: row.model_connection_id || null, model: row.model || null, createdAt: row.created_at, updatedAt: row.updated_at }; }
function parseJson(value, fallback) { try { return JSON.parse(value); } catch { return fallback; } }
function selectedModels(connection) { return (Array.isArray(connection?.models) ? connection.models : []).filter((model) => model && model.selected !== false && text(model.id)); }

export class DreamSettingsStore {
  constructor({ databasePath } = {}) { this.databasePath = databasePath || settingsDatabasePath(); this.db = openSettingsDatabase({ databasePath: this.databasePath }); }
  close() { this.db.close(); }
  get(agent) {
    const id = agentId(agent);
    if (!this.db.prepare('SELECT id FROM agents WHERE id=?').get(id)) throw new Error('agent_not_found');
    return row(this.db.prepare('SELECT * FROM dream_settings WHERE agent_id=?').get(id)) || this.save(id, {});
  }
  save(agent, input = {}) {
    const id = agentId(agent);
    if (!this.db.prepare('SELECT id FROM agents WHERE id=?').get(id)) throw new Error('agent_not_found');
    const current = row(this.db.prepare('SELECT * FROM dream_settings WHERE agent_id=?').get(id));
    const next = {
      enabled: bool(input.enabled, current?.enabled ?? true),
      cron: cron(input.cron ?? current?.cron ?? '0 4 * * *'),
      timezone: timezone(input.timezone ?? current?.timezone ?? 'UTC'),
      prompt: prompt(input.prompt ?? current?.prompt ?? DEFAULT_DREAM_PROMPT),
      modelConnectionId: input.modelConnectionId === undefined && input.connectionId === undefined ? (current?.modelConnectionId ?? null) : nullableModelId(input.modelConnectionId ?? input.connectionId),
      model: input.model === undefined && input.modelId === undefined ? (current?.model ?? null) : nullableModelId(input.model ?? input.modelId),
    };
    if (next.modelConnectionId || next.model) {
      if (!next.modelConnectionId || !next.model) throw new Error('dream_settings_model_selection_incomplete');
      const row = this.db.prepare('SELECT models_json FROM model_connections WHERE id=?').get(next.modelConnectionId);
      const connection = row ? { models: parseJson(row.models_json, []) } : null;
      if (!connection || !selectedModels(connection).some((model) => model.id === next.model)) throw new Error('dream_settings_model_selection_invalid');
    }
    const timestamp = now();
    this.db.prepare(`INSERT INTO dream_settings (agent_id,enabled,cron_expression,timezone,prompt,model_connection_id,model,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?)
      ON CONFLICT(agent_id) DO UPDATE SET enabled=excluded.enabled, cron_expression=excluded.cron_expression, timezone=excluded.timezone, prompt=excluded.prompt, model_connection_id=excluded.model_connection_id, model=excluded.model, updated_at=excluded.updated_at`)
      .run(id, Number(next.enabled), next.cron, next.timezone, next.prompt, next.modelConnectionId, next.model, timestamp, timestamp);
    return this.get(id);
  }
}
