import { withArchiveRead } from './postgres-archive-read.mjs';
import { normalizePostgresPool } from './postgres-foundation.mjs';
import {
  closePostgresPool,
  withPostgresTransaction,
} from "./postgres-foundation.mjs";
import {
  mergeAgentContextConfig,
  normalizeAgentContextConfig,
} from "./agent-context-config.mjs";
import { assertAgent, executionEnvironment, normalizeModAgent } from "./agent-registry.mjs";

const DEFAULT_CAPABILITIES = Object.freeze(["chat", "files", "skills"]);
const text = (v) => String(v ?? "").trim();
const json = (v) => JSON.stringify(v);
const parse = (v, fallback = []) => {
  if (v && typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};
const now = () => new Date().toISOString();
function row(r) {
  return (
    r && {
      id: r.id,
      name: r.name,
      enabled: Boolean(r.enabled),
      availableCapabilities: parse(
        r.available_capabilities,
        DEFAULT_CAPABILITIES,
      ),
      contextConfig: normalizeAgentContextConfig(
        parse(r.context_config_json, {}),
      ),
      executionEnvironment: r.execution_environment_json
        ? executionEnvironment(parse(r.execution_environment_json, null))
        : null,
      ...(r.mod_agent_json ? { modAgent: normalizeModAgent(parse(r.mod_agent_json, null)) } : {}),
      createdAt:
        r.created_at instanceof Date
          ? r.created_at.toISOString()
          : r.created_at,
      updatedAt:
        r.updated_at instanceof Date
          ? r.updated_at.toISOString()
          : r.updated_at,
    }
  );
}

export const POSTGRES_AGENT_REGISTRY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, enabled BOOLEAN NOT NULL DEFAULT TRUE CHECK(enabled IN (TRUE,FALSE)), available_capabilities JSONB NOT NULL DEFAULT '["chat","files","skills"]'::jsonb, context_config_json JSONB NOT NULL DEFAULT '{"version":1}'::jsonb, execution_environment_json JSONB, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
`;
export const AGENT_REGISTRY_SCHEMA_SQL = POSTGRES_AGENT_REGISTRY_SCHEMA_SQL;

export class PostgresAgentRegistryStore {
  constructor({
    pool,
    ownsPool = false,
    referenceImages = null,
    bootstrapSampleIdentities = process.env.BURROW_BOOTSTRAP_SAMPLE_IDENTITIES,
  } = {}) {
    if (!pool?.query || !pool?.connect)
      throw Error("agent_registry_postgres_pool_required");
    this.pool = normalizePostgresPool(pool);
    this.ownsPool = ownsPool;
    this.referenceImages = referenceImages;
    this.bootstrapSampleIdentities = ["1", "true", "yes", "on"].includes(
      String(bootstrapSampleIdentities ?? "0")
        .trim()
        .toLowerCase(),
    );
  }
  async close() {
    if (this.ownsPool) await closePostgresPool(this.pool);
  }
  async bootstrap() {
    return withPostgresTransaction(this.pool, async (c) => {
      const existing = await c.query(
        "SELECT * FROM agents WHERE id=$1 FOR UPDATE",
        ["hatchet"],
      );
      if (existing.rows[0]) return row(existing.rows[0]);
      if (!this.bootstrapSampleIdentities) return null;
      const at = now();
      const r = await c.query(
        "INSERT INTO agents (id,name,enabled,available_capabilities,context_config_json,execution_environment_json,created_at,updated_at) VALUES ($1,$2,TRUE,$3::jsonb,$4::jsonb,NULL,$5,$5) ON CONFLICT (id) DO NOTHING RETURNING *",
        [
          "hatchet",
          "Hatchet",
          json(DEFAULT_CAPABILITIES),
          json(normalizeAgentContextConfig({})),
          at,
        ],
      );
      if (r.rows[0]) return row(r.rows[0]);
      const selected = await c.query(
        "SELECT * FROM agents WHERE id=$1 FOR UPDATE",
        ["hatchet"],
      );
      return row(selected.rows[0]);
    });
  }
  // Page-owned reads never bootstrap identities or lock the registry row.
  async listArchiveAgents({ includeDisabled = true, signal, deadline } = {}) {
    return withArchiveRead(this.pool, async client => {
      const result = await client.query(`SELECT * FROM agents ${includeDisabled ? "" : "WHERE enabled=TRUE"}
        ORDER BY CASE id WHEN 'hatchet' THEN 0 ELSE 1 END,
        translate(name,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C", id COLLATE "C"`);
      return result.rows.map(row);
    }, { signal, deadline });
  }
  async resolveArchiveAgent(reference, { signal, deadline } = {}) {
    const value = text(reference);
    if (!value) return null;
    return withArchiveRead(this.pool, async client => {
      const exact = await this.get(value, client);
      if (exact) return exact;
      const result = await client.query(`SELECT * FROM agents
        WHERE translate(id,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')=translate($1,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')
        OR translate(name,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')=translate($1,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')
        ORDER BY id COLLATE "C"`, [value]);
      return result.rows.length === 1 ? row(result.rows[0]) : null;
    }, { signal, deadline });
  }
  async get(id, client = this.pool) {
    const r = await client.query("SELECT * FROM agents WHERE id=$1", [
      text(id),
    ]);
    return row(r.rows[0]);
  }
  async list({ includeDisabled = true } = {}) {
    await this.bootstrap();
    const r = await this.pool.query(
      `SELECT * FROM agents ${includeDisabled ? "" : "WHERE enabled=TRUE"} ORDER BY CASE id WHEN 'hatchet' THEN 0 ELSE 1 END, translate(name,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') COLLATE "C", id COLLATE "C"`,
    );
    return r.rows.map(row);
  }
  async resolve(reference) {
    const value = text(reference);
    if (!value) return null;
    const exact = await this.get(value);
    if (exact) return exact;
    const r = await this.pool.query(
      `SELECT * FROM agents WHERE translate(id,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')=translate($1,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') OR translate(name,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')=translate($1,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') ORDER BY CASE WHEN translate(id,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')=translate($1,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz') THEN 0 ELSE 1 END,id`,
      [value],
    );
    return r.rows.length === 1 ? row(r.rows[0]) : null;
  }
  async create(input = {}) {
    await this.bootstrap();
    const a = assertAgent(input);
    return withPostgresTransaction(this.pool, async (c) => {
      if (
        (await c.query("SELECT 1 FROM agents WHERE id=$1 FOR UPDATE", [a.id]))
          .rows[0]
      )
        throw Error("agent_id_exists");
      const at = now();
      let r;
      try {
        r = await c.query(
          "INSERT INTO agents (id,name,enabled,available_capabilities,context_config_json,execution_environment_json,created_at,updated_at) VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7,$7) ON CONFLICT (id) DO NOTHING RETURNING *",
          [
            a.id,
            a.name,
            a.enabled === false ? false : true,
            json(a.availableCapabilities || DEFAULT_CAPABILITIES),
            json(normalizeAgentContextConfig(a.contextConfig || {})),
            a.executionEnvironment ? json(a.executionEnvironment) : null,
            at,
          ],
        );
      } catch (error) {
        if (error.code === "23505") throw Error("agent_id_exists");
        throw error;
      }
      if (!r.rows[0]) throw Error("agent_id_exists");
      return row(r.rows[0]);
    });
  }
  async update(id, input = {}) {
    return withPostgresTransaction(this.pool, async (c) => {
      const locked = await c.query(
        "SELECT * FROM agents WHERE id=$1 FOR UPDATE",
        [text(id)],
      );
      const current = row(locked.rows[0]);
      if (!current) throw Error("agent_not_found");
      const a = assertAgent(
          { ...input, id: current.id },
          { requireName: false, allowReserved: true },
        ),
        at = now();
      const r = await c.query(
        "UPDATE agents SET name=$1,enabled=$2,available_capabilities=$3::jsonb,context_config_json=$4::jsonb,execution_environment_json=$5::jsonb,updated_at=$6 WHERE id=$7 RETURNING *",
        [
          a.name === undefined ? current.name : a.name,
          a.enabled === undefined ? current.enabled : a.enabled,
          json(
            a.availableCapabilities === undefined
              ? current.availableCapabilities
              : a.availableCapabilities,
          ),
          json(
            a.contextConfig === undefined
              ? current.contextConfig
              : mergeAgentContextConfig(current.contextConfig, a.contextConfig),
          ),
          a.executionEnvironment === undefined
            ? current.executionEnvironment
              ? json(current.executionEnvironment)
              : null
            : a.executionEnvironment
              ? json(a.executionEnvironment)
              : null,
          at,
          current.id,
        ],
      );
      return row(r.rows[0]);
    });
  }
  // Operator portable imports alone may restore ownership metadata. Ordinary
  // create/update and the mod-owned lifecycle must not adopt existing IDs.
  // All identity fields are written together, with the ownership comparison
  // under the same row lock (including a concurrent insert of a missing ID).
  async restorePortable(input = {}, { conflictPolicy = 'replace' } = {}) {
    const a = assertAgent(input, { requireName: false, allowReserved: true });
    const metadata = input.modAgent == null ? null : normalizeModAgent(input.modAgent);
    // Keep regular import's existing bootstrap behavior, but never create a
    // sample identity as a fallback for a missing mod or reserve its ID.
    if (!metadata && this.bootstrapSampleIdentities && !await this.get(a.id)) await this.bootstrap();
    return withPostgresTransaction(this.pool, async c => {
      let locked = await c.query('SELECT * FROM agents WHERE id=$1 FOR UPDATE', [a.id]);
      let current = row(locked.rows[0]);
      if (!current) {
        // Portable backups may contain a historical global agent. Preserve its
        // identity and content on restoration, but never allow ordinary creates.
        assertAgent(input, { allowReserved: a.id === 'global' });
        const at = now();
        const inserted = await c.query(`INSERT INTO agents
          (id,name,enabled,available_capabilities,context_config_json,execution_environment_json,mod_agent_json,created_at,updated_at)
          VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8,$8)
          ON CONFLICT (id) DO NOTHING RETURNING *`,
          [a.id, a.name, a.enabled !== false, json(a.availableCapabilities || (metadata ? ['chat'] : DEFAULT_CAPABILITIES)),
            json(normalizeAgentContextConfig(a.contextConfig || {})), a.executionEnvironment ? json(a.executionEnvironment) : null,
            metadata ? json(metadata) : null, at]);
        if (inserted.rows[0]) return row(inserted.rows[0]);
        // SELECT FOR UPDATE cannot lock an absent row. If another writer won
        // the insert, inspect and lock its committed identity before deciding.
        locked = await c.query('SELECT * FROM agents WHERE id=$1 FOR UPDATE', [a.id]);
        current = row(locked.rows[0]);
        if (!current) throw Error('agent_id_exists');
      }
      if ((current.modAgent?.ownerModId || null) !== (metadata?.ownerModId || null)) {
        throw Object.assign(new Error('import_agent_ownership_conflict'), { statusCode: 409 });
      }
      // A conflict can arise after the import's preflight; never overwrite it
      // under error/skip policies even when the owner happens to match.
      if (conflictPolicy !== 'replace') throw Object.assign(new Error('agent_id_exists'), { statusCode: 409 });
      const result = await c.query(`UPDATE agents SET name=$1,enabled=$2,available_capabilities=$3::jsonb,
        context_config_json=$4::jsonb,execution_environment_json=$5::jsonb,mod_agent_json=$6::jsonb,updated_at=$7
        WHERE id=$8 RETURNING *`, [
        a.name === undefined ? current.name : a.name,
        a.enabled === undefined ? current.enabled : a.enabled,
        json(a.availableCapabilities === undefined ? current.availableCapabilities : a.availableCapabilities),
        json(a.contextConfig === undefined ? current.contextConfig : mergeAgentContextConfig(current.contextConfig, a.contextConfig)),
        a.executionEnvironment === undefined ? (current.executionEnvironment ? json(current.executionEnvironment) : null)
          : (a.executionEnvironment ? json(a.executionEnvironment) : null),
        metadata ? json(metadata) : null, now(), current.id,
      ]);
      return row(result.rows[0]);
    });
  }
  // These operations are intentionally distinct from the ordinary create/update
  // interface. Ownership is supplied by Core and checked under the row lock;
  // neither regular identities nor another mod's identities can be adopted.
  async createOwned(input, { ownerModId, modelConnectionId, model } = {}) {
    await this.bootstrap();
    const a = assertAgent(input);
    const metadata = normalizeModAgent(input.modAgent, { ownerModId });
    return withPostgresTransaction(this.pool, async c => {
      await this.assertOwnedModel(c, modelConnectionId, model);
      const at = now();
      const r = await c.query(`INSERT INTO agents
        (id,name,enabled,available_capabilities,context_config_json,execution_environment_json,mod_agent_json,created_at,updated_at)
        VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,NULL,$6::jsonb,$7,$7)
        ON CONFLICT (id) DO NOTHING RETURNING *`,
        [a.id, a.name, a.enabled !== false, json(['chat']), json(normalizeAgentContextConfig({})), json(metadata), at]);
      if (!r.rows[0]) throw Error('agent_id_exists');
      await this.saveOwnedModel(c, a.id, modelConnectionId, model, at);
      return row(r.rows[0]);
    });
  }
  async updateOwned(id, input, { ownerModId, modelConnectionId, model } = {}) {
    return withPostgresTransaction(this.pool, async c => {
      const locked = await c.query('SELECT * FROM agents WHERE id=$1 FOR UPDATE', [text(id)]);
      const current = row(locked.rows[0]);
      if (!current || current.modAgent?.ownerModId !== ownerModId) throw Error('mod_owned_agent_not_found');
      const a = assertAgent({ ...input, id: current.id }, { requireName: false, allowReserved: true });
      const metadata = normalizeModAgent(input.modAgent || {}, { ownerModId, partial: true, current: current.modAgent });
      const at = now();
      if (modelConnectionId !== undefined || model !== undefined) {
        const prior = await c.query('SELECT connection_id,model_id FROM agent_model_selections WHERE agent_id=$1 FOR UPDATE', [current.id]);
        const connection = modelConnectionId ?? prior.rows[0]?.connection_id;
        const selectedModel = model ?? prior.rows[0]?.model_id;
        await this.assertOwnedModel(c, connection, selectedModel);
        await this.saveOwnedModel(c, current.id, connection, selectedModel, at);
      }
      const result = await c.query('UPDATE agents SET name=$1,enabled=$2,mod_agent_json=$3::jsonb,updated_at=$4 WHERE id=$5 RETURNING *',
        [a.name === undefined ? current.name : a.name, a.enabled === undefined ? current.enabled : a.enabled, json(metadata), at, current.id]);
      return row(result.rows[0]);
    });
  }
  async assertOwnedModel(c, connectionId, model) {
    if (typeof connectionId !== 'string' || !connectionId.trim() || typeof model !== 'string' || !model.trim()) throw Error('model_selection_required');
    const connection = await c.query('SELECT id FROM model_connections WHERE id=$1 FOR SHARE', [connectionId]);
    if (!connection.rows[0]) throw Error('model_connection_not_found');
    const result = await c.query('SELECT metadata FROM model_catalog WHERE connection_id=$1 AND model_id=$2 AND available FOR SHARE', [connectionId, model]);
    if (!result.rows[0] || result.rows[0].metadata?.selected === false) throw Error('model_not_enabled_for_connection');
  }
  async saveOwnedModel(c, id, connectionId, model, at) {
    await c.query(`INSERT INTO agent_model_selections(agent_id,connection_id,model_id,reasoning_effort,thinking_mode,temperature,updated_at)
      VALUES($1,$2,$3,'off',NULL,0.2,$4) ON CONFLICT(agent_id) DO UPDATE SET
      connection_id=EXCLUDED.connection_id, model_id=EXCLUDED.model_id, reasoning_effort='off', thinking_mode=NULL, temperature=0.2, updated_at=EXCLUDED.updated_at`,
      [id, connectionId, model, at]);
  }
  async delete(id) {
    let storageReference;
    const deleted = await withPostgresTransaction(this.pool, async (c) => {
      const locked = await c.query(
        "SELECT * FROM agents WHERE id=$1 FOR UPDATE",
        [text(id)],
      );
      const current = row(locked.rows[0]);
      if (!current) throw Error("agent_not_found");
      if (this.referenceImages) {
        const image = await c.query('SELECT storage_reference FROM agent_reference_images WHERE agent_id=$1', [text(id)]);
        storageReference = image.rows[0]?.storage_reference;
      }
      await c.query("DELETE FROM agents WHERE id=$1", [text(id)]);
      return current;
    });
    if (storageReference) await this.referenceImages.discard(storageReference);
    return deleted;
  }
}
export const __postgresAgentRegistry = Object.freeze({
  DEFAULT_CAPABILITIES,
  assertAgent,
});
