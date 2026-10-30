import { normalizePostgresPool } from './postgres-foundation.mjs';
import { closePostgresPool, withPostgresTransaction } from './postgres-foundation.mjs';
import {
  AGENT_PROFILE_KINDS,
  agentId,
  kind,
  markdown,
  profileFilesFromDocuments,
} from './agent-profile-store.mjs';

export { AGENT_PROFILE_KINDS, profileFilesFromDocuments };

export const GLOBAL_PROFILE_KINDS = Object.freeze(['RULES', 'ORIENTATION']);
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
const globalProfile = row => ({ useGlobalRules: Boolean(row?.use_global_rules), useGlobalOrientation: Boolean(row?.use_global_orientation) });
function document(row) { return row && { kind: row.kind, markdown: row.markdown, format: 'markdown', createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at, updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at }; }

// Whole-profile saves rewrite rows for CAS, but only changed preference text
// establishes a new operator baseline. Clear automated ownership even on an
// equal-clock A -> B -> A edit; an unchanged Settings save does not clear it.
async function markOperatorPreferenceEdit(client, id, content, at) {
  const before = (await client.query("SELECT markdown FROM agent_profile_documents WHERE agent_id=$1 AND kind='PREFERENCES'", [id])).rows[0];
  if (!before || before.markdown === content) return;
  if (!(await client.query("SELECT to_regclass('settings_meta') AS relation")).rows[0]?.relation) return;
  const key = `preference-learning:${id}`;
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`settings-meta:${key}`]);
  const row = (await client.query('SELECT value_json::text AS value_json FROM settings_meta WHERE key=$1 FOR UPDATE', [key])).rows[0];
  if (!row) return;
  const state = JSON.parse(row.value_json);
  await client.query('UPDATE settings_meta SET value_json=$2,updated_at=$3 WHERE key=$1', [key, JSON.stringify({ ...state, operatorBaselineAt: at, lastAutomatedRevision: null, lastAutomatedHash: null }), at]);
}

export class PostgresAgentProfileStore {
  constructor({ pool, ownsPool = false, clock = now } = {}) {
    if (!pool?.query || !pool?.connect) throw new Error('agent_profile_postgres_pool_required');
    this.pool = normalizePostgresPool(pool); this.ownsPool = ownsPool; this.clock = clock;
  }
  async close() { if (this.ownsPool) await closePostgresPool(this.pool); }
  async globalProfile(agent) {
    const id = agentId(agent);
    const result = await this.pool.query('SELECT use_global_rules,use_global_orientation FROM agents WHERE id=$1', [id]);
    if (!result.rows[0]) throw new Error('agent_not_found');
    return globalProfile(result.rows[0]);
  }
  async listGlobal() {
    const result = await this.pool.query("SELECT kind,markdown,created_at,updated_at FROM global_profile_documents ORDER BY CASE kind WHEN 'RULES' THEN 0 ELSE 1 END");
    return result.rows.map(document);
  }
  async replaceGlobal(documents = []) {
    const normalized = (Array.isArray(documents) ? documents : []).map(item => ({ kind: String(item?.kind || '').toUpperCase(), markdown: markdown(item?.markdown) }));
    if (normalized.length !== 2 || new Set(normalized.map(item => item.kind)).size !== 2 || normalized.some(item => !GLOBAL_PROFILE_KINDS.includes(item.kind))) throw new Error('global_profile_documents_complete_set_required');
    return withPostgresTransaction(this.pool, async client => {
      const stamp = this.clock();
      for (const item of normalized) await client.query('INSERT INTO global_profile_documents(kind,markdown,created_at,updated_at) VALUES($1,$2,$3,$3) ON CONFLICT(kind) DO UPDATE SET markdown=EXCLUDED.markdown,updated_at=EXCLUDED.updated_at', [item.kind,item.markdown,stamp]);
      const result = await client.query("SELECT kind,markdown,created_at,updated_at FROM global_profile_documents ORDER BY CASE kind WHEN 'RULES' THEN 0 ELSE 1 END");
      return result.rows.map(document);
    });
  }
  async replaceWithGlobalProfile(agent, documents, value) {
    if (typeof value?.useGlobalRules !== 'boolean' || typeof value?.useGlobalOrientation !== 'boolean') throw new Error('agent_global_profile_booleans_required');
    const id = agentId(agent);
    const normalized = (Array.isArray(documents) ? documents : []).map((item) => ({ kind: kind(item?.kind), markdown: markdown(item?.markdown) }));
    if (normalized.length !== AGENT_PROFILE_KINDS.length || new Set(normalized.map((item) => item.kind)).size !== AGENT_PROFILE_KINDS.length) throw new Error('agent_profile_documents_complete_set_required');
    return withPostgresTransaction(this.pool, async (client) => {
      const found = await client.query('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [id]);
      if (!found.rows[0]) throw new Error('agent_not_found');
      const stamp = this.clock();
      await markOperatorPreferenceEdit(client, id, normalized.find(item => item.kind === 'PREFERENCES').markdown, stamp);
      for (const item of normalized) await client.query(`INSERT INTO agent_profile_documents (agent_id,kind,markdown,created_at,updated_at) VALUES ($1,$2,$3,$4,$4) ON CONFLICT (agent_id,kind) DO UPDATE SET markdown=EXCLUDED.markdown,updated_at=CASE WHEN agent_profile_documents.kind='PREFERENCES' AND agent_profile_documents.markdown=EXCLUDED.markdown THEN agent_profile_documents.updated_at ELSE EXCLUDED.updated_at END`, [id, item.kind, item.markdown, stamp]);
      await client.query('UPDATE agents SET use_global_rules=$2,use_global_orientation=$3 WHERE id=$1', [id, value.useGlobalRules, value.useGlobalOrientation]);
      const rows = await client.query(`SELECT kind,markdown,created_at,updated_at FROM agent_profile_documents WHERE agent_id=$1 ORDER BY ${order}`, [id]);
      return { documents: rows.rows.map(document), globalProfile: value };
    });
  }
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
  /** Private CAS token: PostgreSQL row version changes for every writer, even equal-clock/ABA edits. */
  async preferenceSnapshot(agent) {
    const result = await this.pool.query("SELECT kind,markdown,created_at,updated_at,xmin::text AS revision FROM agent_profile_documents WHERE agent_id=$1 AND kind='PREFERENCES'", [agentId(agent)]);
    const row = result.rows[0];
    return row ? { ...document(row), revision: row.revision } : null;
  }
  async replace(agent, documents = []) {
    const id = agentId(agent);
    const normalized = (Array.isArray(documents) ? documents : []).map((item) => ({ kind: kind(item?.kind), markdown: markdown(item?.markdown) }));
    if (normalized.length !== AGENT_PROFILE_KINDS.length || new Set(normalized.map((item) => item.kind)).size !== AGENT_PROFILE_KINDS.length) throw new Error('agent_profile_documents_complete_set_required');
    return withPostgresTransaction(this.pool, async (client) => {
      const found = await client.query('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [id]);
      if (!found.rows[0]) throw new Error('agent_not_found');
      const stamp = this.clock();
      await markOperatorPreferenceEdit(client, id, normalized.find(item => item.kind === 'PREFERENCES').markdown, stamp);
      for (const item of normalized) await client.query(`INSERT INTO agent_profile_documents (agent_id,kind,markdown,created_at,updated_at) VALUES ($1,$2,$3,$4,$4) ON CONFLICT (agent_id,kind) DO UPDATE SET markdown=EXCLUDED.markdown,updated_at=CASE WHEN agent_profile_documents.kind='PREFERENCES' AND agent_profile_documents.markdown=EXCLUDED.markdown THEN agent_profile_documents.updated_at ELSE EXCLUDED.updated_at END`, [id, item.kind, item.markdown, stamp]);
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
        await client.query(`INSERT INTO agent_profile_documents (agent_id,kind,markdown,created_at,updated_at) VALUES ($1,$2,$3,$4,$4) ON CONFLICT (agent_id,kind) DO NOTHING`, [id, documentKind, values.get(documentKind), stamp]);
      }
      const rows = await client.query('SELECT kind,markdown,created_at,updated_at FROM agent_profile_documents WHERE agent_id=$1 ORDER BY ' + order, [id]);
      return rows.rows.map(document);
    });
  }
  /** Profile, per-signal resolution and private audit share the operator profile-write lock. */
  async atomicPreferenceUpdate(agent, { markdown: content, stateKey, state, auditKey, audit, signalsKey, signals, at, decide }) {
    const id = agentId(agent);
    const normalized = content === null ? null : markdown(content);
    return withPostgresTransaction(this.pool, async (client) => {
      const found = await client.query('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [id]);
      if (!found.rows[0]) throw new Error('agent_not_found');
      const profileResult = await client.query('SELECT kind,markdown,created_at,updated_at,xmin::text AS revision FROM agent_profile_documents WHERE agent_id=$1 AND kind=$2 FOR UPDATE', [id, 'PREFERENCES']);
      const row = profileResult.rows[0];
      const current = row ? { ...document(row), revision: row.revision } : null;
      const readMeta = async (key) => { const result = await client.query('SELECT value_json::text AS value_json FROM settings_meta WHERE key=$1 FOR UPDATE', [key]); try { return JSON.parse(result.rows[0]?.value_json || 'null'); } catch { return null; } };
      for (const key of [...new Set([stateKey, auditKey, signalsKey].filter(Boolean))].sort()) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`settings-meta:${key}`]);
      const priorState = await readMeta(stateKey);
      const priorAudit = await readMeta(auditKey);
      const priorSignals = signalsKey ? await readMeta(signalsKey) : null;
      const retainedSignals = priorSignals?.signals || [];
      const decision = decide?.({ current, priorState, retainedSignals }) || { apply: true };
      if (!decision.apply) return decision.result || { applied: false, reason: decision.reason };
      const writeProfile = decision.writeProfile !== false;
      let next = current;
      if (writeProfile) {
        const result = await client.query(`INSERT INTO agent_profile_documents (agent_id,kind,markdown,created_at,updated_at) VALUES ($1,$2,$3,$4,$4) ON CONFLICT (agent_id,kind) DO UPDATE SET markdown=EXCLUDED.markdown,updated_at=CASE WHEN agent_profile_documents.kind='PREFERENCES' AND agent_profile_documents.markdown=EXCLUDED.markdown THEN agent_profile_documents.updated_at ELSE EXCLUDED.updated_at END RETURNING kind,markdown,created_at,updated_at,xmin::text AS revision`, [id, 'PREFERENCES', normalized, at]);
        next = { ...document(result.rows[0]), revision: result.rows[0].revision };
      }
      const writeMeta = (key, value) => client.query(`INSERT INTO settings_meta(key,value_json,updated_at) VALUES($1,$2,$3) ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at`, [key, JSON.stringify(value), at]);
      const nextState = typeof state === 'function' ? state(priorState, { current, next, decision, retainedSignals }) : state;
      const nextAudit = audit(priorAudit, current, decision);
      await writeMeta(stateKey, nextState); await writeMeta(auditKey, nextAudit);
      if (signals) await writeMeta(signalsKey, signals(priorSignals, { state: nextState }));
      return { applied: writeProfile, reviewed: true, reason: decision.reason || null, entry: nextAudit.entries[0], state: nextState };
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
      if (normalizedKind === 'PREFERENCES') await markOperatorPreferenceEdit(client, id, content, stamp);
      const result = await client.query(`INSERT INTO agent_profile_documents (agent_id,kind,markdown,created_at,updated_at) VALUES ($1,$2,$3,$4,$4) ON CONFLICT (agent_id,kind) DO UPDATE SET markdown=EXCLUDED.markdown,updated_at=CASE WHEN agent_profile_documents.kind='PREFERENCES' AND agent_profile_documents.markdown=EXCLUDED.markdown THEN agent_profile_documents.updated_at ELSE EXCLUDED.updated_at END RETURNING kind,markdown,created_at,updated_at`, [id, normalizedKind, content, stamp]);
      return document(result.rows[0]);
    });
  }
}
export default PostgresAgentProfileStore;
