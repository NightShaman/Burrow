import { closePostgresPool, withPostgresTransaction } from './postgres-foundation.mjs';
import {
  AGENT_PROFILE_KINDS,
  agentId,
  kind,
  markdown,
  profileFilesFromDocuments,
} from './agent-profile-store.mjs';

export { AGENT_PROFILE_KINDS, profileFilesFromDocuments };

export const POSTGRES_AGENT_PROFILE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agent_profile_documents (
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('SOUL','RULES','ORIENTATION','PREFERENCES','TOOLS','DREAM_MEMORY')),
  markdown TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, kind)
);
`;
export const AGENT_PROFILE_SCHEMA_SQL = POSTGRES_AGENT_PROFILE_SCHEMA_SQL;
const order = "CASE kind WHEN 'SOUL' THEN 0 WHEN 'RULES' THEN 1 WHEN 'ORIENTATION' THEN 2 WHEN 'PREFERENCES' THEN 3 WHEN 'TOOLS' THEN 4 WHEN 'DREAM_MEMORY' THEN 5 END";
const now = () => new Date().toISOString();
function document(row) { return row && { kind: row.kind, markdown: row.markdown, format: 'markdown', createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at, updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at }; }

export class PostgresAgentProfileStore {
  constructor({ pool, ownsPool = false, clock = now } = {}) {
    if (!pool?.query || !pool?.connect) throw new Error('agent_profile_postgres_pool_required');
    this.pool = pool; this.ownsPool = ownsPool; this.clock = clock;
  }
  async close() { if (this.ownsPool) await closePostgresPool(this.pool); }
  async list(agent) {
    const id = agentId(agent);
    return withPostgresTransaction(this.pool, async (client) => {
      const result = await client.query('SELECT id FROM agents WHERE id=$1 FOR SHARE', [id]);
      if (!result.rows[0]) throw new Error('agent_not_found');
      const rows = await client.query(`SELECT kind,markdown,created_at,updated_at FROM agent_profile_documents WHERE agent_id=$1 ORDER BY ${order}`, [id]);
      return rows.rows.map(document);
    });
  }
  async get(agent, documentKind) {
    const result = await this.pool.query('SELECT kind,markdown,created_at,updated_at FROM agent_profile_documents WHERE agent_id=$1 AND kind=$2', [agentId(agent), kind(documentKind)]);
    return document(result.rows[0]);
  }
  async replace(agent, documents = []) {
    const id = agentId(agent);
    const normalized = (Array.isArray(documents) ? documents : []).map((item) => ({ kind: kind(item?.kind), markdown: markdown(item?.markdown) }));
    if (normalized.length !== AGENT_PROFILE_KINDS.length || new Set(normalized.map((item) => item.kind)).size !== AGENT_PROFILE_KINDS.length) throw new Error('agent_profile_documents_complete_set_required');
    return withPostgresTransaction(this.pool, async (client) => {
      const found = await client.query('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [id]);
      if (!found.rows[0]) throw new Error('agent_not_found');
      const stamp = this.clock();
      for (const item of normalized) await client.query(`INSERT INTO agent_profile_documents (agent_id,kind,markdown,created_at,updated_at) VALUES ($1,$2,$3,$4,$4) ON CONFLICT (agent_id,kind) DO UPDATE SET markdown=EXCLUDED.markdown,updated_at=EXCLUDED.updated_at`, [id, item.kind, item.markdown, stamp]);
      const rows = await client.query(`SELECT kind,markdown,created_at,updated_at FROM agent_profile_documents WHERE agent_id=$1 ORDER BY ${order}`, [id]);
      return rows.rows.map(document);
    });
  }
  async ensure(agent, documents = []) {
    const id = agentId(agent);
    const byKind = new Map((Array.isArray(documents) ? documents : []).map((item) => [String(item?.kind || '').toUpperCase(), String(item?.markdown || '')]));
    return withPostgresTransaction(this.pool, async (client) => {
      const found = await client.query('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [id]);
      if (!found.rows[0]) throw new Error('agent_not_found');
      const existing = await client.query('SELECT kind,markdown,created_at,updated_at FROM agent_profile_documents WHERE agent_id=$1 ORDER BY ' + order, [id]);
      if (existing.rows.length === AGENT_PROFILE_KINDS.length) return existing.rows.map(document);
      const values = new Map(AGENT_PROFILE_KINDS.map(k => [k, markdown(byKind.get(k) || '')]));
      const stamp = this.clock();
      for (const documentKind of AGENT_PROFILE_KINDS) {
        await client.query(`INSERT INTO agent_profile_documents (agent_id,kind,markdown,created_at,updated_at) VALUES ($1,$2,$3,$4,$4) ON CONFLICT (agent_id,kind) DO UPDATE SET markdown=EXCLUDED.markdown,updated_at=EXCLUDED.updated_at`, [id, documentKind, values.get(documentKind), stamp]);
      }
      const rows = await client.query('SELECT kind,markdown,created_at,updated_at FROM agent_profile_documents WHERE agent_id=$1 ORDER BY ' + order, [id]);
      return rows.rows.map(document);
    });
  }
  /** Run a preference document plus learning metadata/audit mutation under the profile-write lock. */
  async atomicPreferenceUpdate(agent, { markdown: content, stateKey, state, auditKey, audit, at, decide }) {
    const id = agentId(agent);
    const normalized = markdown(content);
    return withPostgresTransaction(this.pool, async (client) => {
      const found = await client.query('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [id]);
      if (!found.rows[0]) throw new Error('agent_not_found');
      const profileResult = await client.query('SELECT kind,markdown,created_at,updated_at FROM agent_profile_documents WHERE agent_id=$1 AND kind=$2 FOR UPDATE', [id, 'PREFERENCES']);
      const current = document(profileResult.rows[0]);
      const readMeta = async (key) => { const result = await client.query('SELECT value_json FROM settings_meta WHERE key=$1 FOR UPDATE', [key]); try { return JSON.parse(result.rows[0]?.value_json || 'null'); } catch { return null; } };
      for (const key of [stateKey, auditKey].sort()) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`settings-meta:${key}`]);
      const priorState = await readMeta(stateKey);
      const priorAudit = await readMeta(auditKey);
      const decision = decide?.({ current, priorState }) || { apply: true };
      if (!decision.apply) return decision.result || { applied: false, reason: decision.reason };
      const result = await client.query(`INSERT INTO agent_profile_documents (agent_id,kind,markdown,created_at,updated_at) VALUES ($1,$2,$3,$4,$4) ON CONFLICT (agent_id,kind) DO UPDATE SET markdown=EXCLUDED.markdown,updated_at=EXCLUDED.updated_at RETURNING kind,markdown,created_at,updated_at`, [id, 'PREFERENCES', normalized, at]);
      const writeMeta = (key, value) => client.query(`INSERT INTO settings_meta(key,value_json,updated_at) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at`, [key, JSON.stringify(value), at]);
      const nextAudit = audit(priorAudit, current);
      await writeMeta(stateKey, state); await writeMeta(auditKey, nextAudit);
      return { applied: true, entry: nextAudit.entries[0], state };
    });
  }
  async replacePreferences(agent, value) { return this.replaceSingle(agent, 'PREFERENCES', value); }
  async replaceTools(agent, value) { return this.replaceSingle(agent, 'TOOLS', value); }
  async replaceDreamMemory(agent, value) { return this.replaceSingle(agent, 'DREAM_MEMORY', value); }
  async replaceSingle(agent, documentKind, value) {
    const id = agentId(agent), normalizedKind = kind(documentKind), content = markdown(value);
    return withPostgresTransaction(this.pool, async (client) => {
      const found = await client.query('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [id]);
      if (!found.rows[0]) throw new Error('agent_not_found');
      const stamp = this.clock();
      const result = await client.query(`INSERT INTO agent_profile_documents (agent_id,kind,markdown,created_at,updated_at) VALUES ($1,$2,$3,$4,$4) ON CONFLICT (agent_id,kind) DO UPDATE SET markdown=EXCLUDED.markdown,updated_at=EXCLUDED.updated_at RETURNING kind,markdown,created_at,updated_at`, [id, normalizedKind, content, stamp]);
      return document(result.rows[0]);
    });
  }
}
export default PostgresAgentProfileStore;
