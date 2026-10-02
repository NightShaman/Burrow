import { normalizePostgresPool } from './postgres-foundation.mjs';
import {
  closePostgresPool,
  withPostgresTransaction,
} from "./postgres-foundation.mjs";
import {
  mergeAgentContextConfig,
  normalizeAgentContextConfig,
} from "./agent-context-config.mjs";
import { assertAgent, executionEnvironment } from "./agent-registry.mjs";

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
    bootstrapSampleIdentities = process.env.BURROW_BOOTSTRAP_SAMPLE_IDENTITIES,
  } = {}) {
    if (!pool?.query || !pool?.connect)
      throw Error("agent_registry_postgres_pool_required");
    this.pool = normalizePostgresPool(pool);
    this.ownsPool = ownsPool;
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
          { requireName: false },
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
  async delete(id) {
    return withPostgresTransaction(this.pool, async (c) => {
      const locked = await c.query(
        "SELECT * FROM agents WHERE id=$1 FOR UPDATE",
        [text(id)],
      );
      const current = row(locked.rows[0]);
      if (!current) throw Error("agent_not_found");
      await c.query("DELETE FROM agents WHERE id=$1", [text(id)]);
      return current;
    });
  }
}
export const __postgresAgentRegistry = Object.freeze({
  DEFAULT_CAPABILITIES,
  assertAgent,
});
