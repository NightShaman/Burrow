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
import { boundaryDiagnostic } from './diagnostic-boundary.mjs';

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
    this.identityDeletionWake = null;
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
  async create(input = {}, { activeAgentRuns = null } = {}) {
    await this.bootstrap();
    const a = assertAgent(input);
    return withPostgresTransaction(this.pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 109))', [a.id]);
      if (
        (await c.query("SELECT 1 FROM agents WHERE id=$1 FOR UPDATE", [a.id]))
          .rows[0]
      )
        throw Error("agent_id_exists");
      if ((await c.query("SELECT 1 FROM identity_deletion_events WHERE agent_id=$1 AND state<>'complete' LIMIT 1", [a.id])).rows[0]) throw Object.assign(new Error('agent_deletion_cleanup_pending'),{statusCode:409});
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
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 109))', [text(id)]);
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
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 109))', [a.id]);
      if ((await c.query("SELECT 1 FROM identity_deletion_events WHERE agent_id=$1 AND state<>'complete' LIMIT 1", [a.id])).rows[0]) throw Object.assign(new Error('agent_deletion_cleanup_pending'),{statusCode:409});
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
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 109))', [a.id]);
      if ((await c.query("SELECT 1 FROM identity_deletion_events WHERE agent_id=$1 AND state<>'complete' LIMIT 1", [a.id])).rows[0]) throw Object.assign(new Error('agent_deletion_cleanup_pending'),{statusCode:409});
      await this.assertOwnedModel(c, modelConnectionId, model);
      const at = now();
      const r = await c.query(`INSERT INTO agents
        (id,name,enabled,available_capabilities,context_config_json,execution_environment_json,mod_agent_json,created_at,updated_at)
        VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,NULL,$6::jsonb,$7,$7)
        ON CONFLICT (id) DO NOTHING RETURNING *`,
        [a.id, a.name, a.enabled !== false, json(['chat']), json(normalizeAgentContextConfig({})), json(metadata), at]);
      if (!r.rows[0]) throw Error('agent_id_exists');
      await this.saveOwnedModel(c, a.id, modelConnectionId, model, at);
      await c.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at)
        VALUES($1,'default','{}'::jsonb,$2,$2) ON CONFLICT(agent_id,session_id) DO NOTHING`, [a.id, at]);
      return row(r.rows[0]);
    });
  }
  // Repair only identities with no conversation scopes at all. A missing
  // default alongside other sessions (including an archived default) is an
  // intentional history state, not a reason to resurrect a deleted session.
  async ensureInitialSession(id) {
    return withPostgresTransaction(this.pool, async c => {
      const agentId = text(id);
      const locked = await c.query('SELECT 1 FROM agents WHERE id=$1 FOR UPDATE', [agentId]);
      if (!locked.rows[0]) return false;
      const at = now();
      const result = await c.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at)
        SELECT $1,'default','{}'::jsonb,$2,$2
        WHERE NOT EXISTS (SELECT 1 FROM conversation_sessions WHERE agent_id=$1)
        ON CONFLICT(agent_id,session_id) DO NOTHING RETURNING session_id`, [agentId, at]);
      return result.rowCount > 0;
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
  async delete(id, { activeAgentRuns = null, sessionContinuityHeads = null } = {}) {
    return this.deleteIdentity(id, null, activeAgentRuns, sessionContinuityHeads);
  }
  async deleteOwned(id, { ownerModId, activeAgentRuns = null } = {}) {
    if (typeof ownerModId !== 'string' || !ownerModId) throw Error('mod_owned_agent_owner_required');
    return this.deleteIdentity(id, ownerModId, activeAgentRuns);
  }
  async deleteIdentity(id, ownerModId = null, activeAgentRuns = null, sessionContinuityHeads = null) {
    let storageReference;
    let deletionEventId;
    const deleted = await withPostgresTransaction(this.pool, async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 109))', [text(id)]);
      const locked = await c.query(
        "SELECT * FROM agents WHERE id=$1 FOR UPDATE",
        [text(id)],
      );
      const current = row(locked.rows[0]);
      if (!current) {
        if (ownerModId) return null;
        throw Error("agent_not_found");
      }
      if (ownerModId ? current.modAgent?.ownerModId !== ownerModId : Boolean(current.modAgent)) {
        throw Object.assign(new Error(ownerModId ? 'mod_owned_agent_not_found' : 'agent_managed_by_mod'), { statusCode: ownerModId ? 404 : 409 });
      }
      if ([...(activeAgentRuns?.values?.() || []), ...(sessionContinuityHeads?.values?.() || [])].some(run => run.agentId === current.id)) {
        throw Object.assign(new Error('agent_has_active_work'), { statusCode: 409 });
      }
      {
        // A registered or queued turn must finish before its identity disappears.
        for (const [table, statuses] of [
          ['chat_inputs', ['queued', 'held', 'running']],
          ['mod_external_turns', ['queued', 'running']],
          ['scheduled_job_runs', ['running']],
          ['github_completion_events', ['pending', 'running']],
        ]) {
          const active = await c.query(`SELECT 1 FROM ${table} WHERE agent_id=$1 AND status=ANY($2::text[]) LIMIT 1`, [current.id, statuses]);
          if (active.rows[0]) throw Object.assign(new Error('agent_has_active_work'), { statusCode: 409 });
        }
        const forge = await c.query("SELECT 1 FROM forge_jobs WHERE agent_id=$1 AND record->>'status' IN ('queued','running') LIMIT 1", [current.id]);
        if (forge.rows[0]) throw Object.assign(new Error('agent_has_active_work'), { statusCode: 409 });
      }
      const continuity = await c.query("SELECT 1 FROM continuity_state WHERE agent_id=$1 AND (head_state IN ('running','finalizing') OR queue_status='running') LIMIT 1", [current.id]);
      if (continuity.rowCount) throw Object.assign(new Error('agent_has_active_work'), {statusCode:409});
      if (this.referenceImages) {
        const image = await c.query('SELECT storage_reference FROM agent_reference_images WHERE agent_id=$1', [text(id)]);
        storageReference = image.rows[0]?.storage_reference;
      }
      // The deletion receipt commits with identity removal. Reuse is fenced while
      // this event is pending so delayed mod cleanup cannot hit a successor.
      const eventId = (await c.query('SELECT gen_random_uuid() AS id')).rows[0].id;
      deletionEventId = eventId;
      await c.query('INSERT INTO identity_deletion_events(event_id,agent_id,owner_mod_id,storage_reference) VALUES($1,$2,$3,$4)', [eventId,current.id,current.modAgent?.ownerModId || null,storageReference || null]);
      await c.query('INSERT INTO identity_deletion_reconciliation(agent_id,event_id) VALUES($1,$2) ON CONFLICT(agent_id) DO UPDATE SET event_id=EXCLUDED.event_id,recorded_at=now()', [current.id,eventId]);
      await c.query(`INSERT INTO identity_deletion_recipients(event_id,mod_id)
        SELECT $1,h.mod_id FROM identity_deletion_handlers h JOIN mod_installations i USING(mod_id) ON CONFLICT DO NOTHING`,[eventId]);
      await this.cleanupDeletedIdentityState(c, current.id);
      await c.query(`UPDATE identity_deletion_events SET state='complete' WHERE event_id=$1 AND storage_reference IS NULL
        AND NOT EXISTS(SELECT 1 FROM identity_deletion_recipients WHERE event_id=$1 AND acknowledged_at IS NULL)`,[eventId]);
      await c.query("DELETE FROM agents WHERE id=$1", [text(id)]);
      return current;
    });
    if (storageReference) { try { await this.cleanupIdentityDeletionArtifact(deletionEventId); } catch (error) { await this.failIdentityDeletionArtifact(deletionEventId, boundaryDiagnostic(error,'agent_reference_image_cleanup','agent_reference_image_cleanup_failed').errorCode); } }
    if (deleted && this.identityDeletionWake) void this.identityDeletionWake().catch(() => {});
    return deleted;
  }
  async cleanupDeletedIdentityState(c, agentId) {
      // Erase owned live state for both identity kinds. Archive history and
      // operator audit tables are intentionally retained.
      for (const [table,column] of [
        ['brain_memories','agent_id'],['agent_model_selections','agent_id'],['conversation_sessions','agent_id'],
        ['conversation_entries','agent_id'],['conversation_archives','agent_id'],['conversation_archive_runs','agent_id'],
        ['conversation_archive_entries','agent_id'],['continuity_state','agent_id'],['continuity_log','agent_id'],
        ['continuity_handoffs','agent_id'],['working_memory','agent_id'],['rolling_continuity_cards','agent_id'],
        ['github_completion_events','agent_id'],['github_workflow_watches','agent_id'],['mod_external_turns','agent_id'],
        ['dream_extraction_batches','agent_id'],['dream_diary_entries','agent_id'],
      ]) await c.query(`DELETE FROM ${table} WHERE ${column}=$1`,[agentId]);
      await c.query('DELETE FROM tiddle_envelopes WHERE agent_id=$1', [agentId]);
      await c.query('DELETE FROM dream_state_envelopes WHERE agent_id=$1', [agentId]);
      await c.query(`DELETE FROM working_memory_meta WHERE value_json->>'agentId'=$1 OR
        key=ANY(ARRAY['brain-promotion-candidates:' || $1,'preference-signals:' || $1,'preference-learning:' || $1,'preference-audit:' || $1]) OR starts_with(key,'dream-ledger:' || $1 || ':') OR starts_with(key,'dream-preload:' || $1 || ':') OR starts_with(key,'dream-scope-review:' || $1 || ':')`, [agentId]);
      await c.query(`UPDATE core_mod_authority SET
        admin_agent_ids=admin_agent_ids - $1,
        diagnostic_agent_ids=diagnostic_agent_ids - $1,
        mod_management_agent_ids=mod_management_agent_ids - $1,
        core_api_agent_ids=core_api_agent_ids - $1
        WHERE admin_agent_ids ? $1 OR diagnostic_agent_ids ? $1 OR mod_management_agent_ids ? $1 OR core_api_agent_ids ? $1`, [agentId]);
      const evidence = await c.query("DELETE FROM albdruck_evidence WHERE source_ref->>'agentId'=$1 RETURNING knowledge_id", [agentId]);
      const evidenceIds = [...new Set(evidence.rows.map(row => row.knowledge_id))];
      await c.query(`DELETE FROM albdruck_knowledge k WHERE scope=$2 OR (k.id=ANY($1::text[])
        AND NOT EXISTS (SELECT 1 FROM albdruck_evidence e WHERE e.knowledge_id=k.id)
        AND NOT EXISTS (SELECT 1 FROM albdruck_revisions r WHERE r.knowledge_id=k.id AND r.operation='correct'))`, [evidenceIds, `agent:${agentId}`]);
      await c.query("DELETE FROM chat_identities WHERE kind='agent' AND id=$1", [agentId]);
      await c.query('UPDATE task_board_tasks SET assigned_agent_id=NULL WHERE assigned_agent_id=$1',[agentId]);
  }
  setIdentityDeletionWake(wake) { this.identityDeletionWake = typeof wake === 'function' ? wake : null; }
  async pendingIdentityDeletions(modId, limit=50) {
    return (await this.pool.query(`SELECT e.event_id AS "eventId",e.agent_id AS "agentId",e.owner_mod_id AS "ownerModId",e.deleted_at AS "deletedAt"
      FROM identity_deletion_recipients r JOIN identity_deletion_events e USING(event_id)
      WHERE r.mod_id=$1 AND r.acknowledged_at IS NULL AND r.retry_at<=now() AND e.state<>'complete'
      ORDER BY e.deleted_at,e.event_id LIMIT $2`,[modId,Math.min(100,Math.max(1,limit))])).rows.map(event => ({ ...event, deletedAt: new Date(event.deletedAt).toISOString() }));
  }
  async registerIdentityDeletionHandler(modId, registered) {
    if (typeof modId !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(modId) || typeof registered !== 'boolean') throw Error('mod_agent_deleted_handler_invalid');
    await withPostgresTransaction(this.pool, async c => {
      if (!registered) { await c.query('DELETE FROM identity_deletion_handlers WHERE mod_id=$1',[modId]); return; }
      await c.query("SELECT pg_advisory_xact_lock(hashtext('identity-deletion-reconciliation'))");
      await c.query(`INSERT INTO identity_deletion_handlers(mod_id) VALUES($1) ON CONFLICT(mod_id) DO UPDATE SET last_seen_at=now()`,[modId]);
      // Historical archived IDs are exact Core identity records. Deliver those
      // IDs to newly activated cleanup handlers once; never inspect mod JSON or
      // infer ownership from names or prose.
      const candidates = await c.query(`SELECT r.agent_id FROM agent_identity_registry r LEFT JOIN agents a ON a.id=r.agent_id
        LEFT JOIN identity_deletion_reconciliation x USING(agent_id)
        WHERE r.archived AND a.id IS NULL AND x.agent_id IS NULL ORDER BY r.agent_id COLLATE "C"`);
      for (const candidate of candidates.rows) {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 109))',[candidate.agent_id]);
        if ((await c.query('SELECT 1 FROM agents WHERE id=$1',[candidate.agent_id])).rowCount) continue;
        await this.cleanupDeletedIdentityState(c,candidate.agent_id);
        const receipt = await c.query(`INSERT INTO identity_deletion_events(event_id,agent_id,owner_mod_id,state)
          VALUES(gen_random_uuid(),$1,NULL,'pending') RETURNING event_id`,[candidate.agent_id]);
        await c.query('INSERT INTO identity_deletion_reconciliation(agent_id,event_id) VALUES($1,$2) ON CONFLICT(agent_id) DO NOTHING',[candidate.agent_id,receipt.rows[0].event_id]);
      }
      await c.query(`WITH inserted AS (
        INSERT INTO identity_deletion_recipients(event_id,mod_id)
        SELECT x.event_id,$1 FROM identity_deletion_reconciliation x WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.id=x.agent_id)
        ON CONFLICT(event_id,mod_id) DO NOTHING RETURNING event_id
      ) UPDATE identity_deletion_events e SET state='pending',retry_at=now(),last_error=NULL
        FROM inserted i WHERE e.event_id=i.event_id`,[modId]);
    });
    if (registered && this.identityDeletionWake) void this.identityDeletionWake().catch(() => {});
  }
  async pendingIdentityDeletionArtifacts(limit=50) {
    return (await this.pool.query(`SELECT event_id AS "eventId",storage_reference AS "storageReference" FROM identity_deletion_events
      WHERE storage_reference IS NOT NULL AND retry_at<=now() ORDER BY deleted_at,event_id LIMIT $1`,[Math.min(100,Math.max(1,limit))])).rows;
  }
  async clearIdentityDeletionArtifact(eventId) {
    await this.pool.query(`UPDATE identity_deletion_events SET storage_reference=NULL,
      state=CASE WHEN NOT EXISTS(SELECT 1 FROM identity_deletion_recipients WHERE event_id=$1 AND acknowledged_at IS NULL) THEN 'complete' ELSE 'pending' END
      WHERE event_id=$1`,[eventId]);
  }
  async cleanupIdentityDeletionArtifact(eventId) {
    if (!this.referenceImages) return false;
    const row=(await this.pool.query('SELECT storage_reference FROM identity_deletion_events WHERE event_id=$1',[eventId])).rows[0];
    if (!row?.storage_reference) return true;
    await this.referenceImages.discard(row.storage_reference, { throwOnError: true });
    await this.clearIdentityDeletionArtifact(eventId);
    return true;
  }
  async failIdentityDeletionArtifact(eventId,errorCode='agent_reference_image_cleanup_failed') {
    const code=/^[a-z0-9_]{1,80}$/.test(String(errorCode))?String(errorCode):'agent_reference_image_cleanup_failed';
    await this.pool.query(`UPDATE identity_deletion_events SET state='failed',attempts=attempts+1,last_error=$2,
      retry_at=now()+LEAST(interval '1 hour',interval '2 seconds'*power(2,LEAST(attempts,10))) WHERE event_id=$1 AND storage_reference IS NOT NULL`,[eventId,code]);
  }
  async acknowledgeIdentityDeletion(eventId,modId) {
    await withPostgresTransaction(this.pool, async c => {
      await c.query(`UPDATE identity_deletion_recipients SET acknowledged_at=now(),last_error=NULL WHERE event_id=$1 AND mod_id=$2 AND acknowledged_at IS NULL`,[eventId,modId]);
      await c.query(`UPDATE identity_deletion_events SET state=CASE WHEN storage_reference IS NULL AND NOT EXISTS(SELECT 1 FROM identity_deletion_recipients WHERE event_id=$1 AND acknowledged_at IS NULL) THEN 'complete' ELSE 'pending' END,last_error=NULL WHERE event_id=$1`,[eventId]);
    });
  }
  async failIdentityDeletion(eventId,modId,errorCode='mod_identity_cleanup_failed') {
    const code=/^[a-z0-9_]{1,80}$/.test(String(errorCode))?String(errorCode):'mod_identity_cleanup_failed';
    await withPostgresTransaction(this.pool, async c => {
      await c.query(`UPDATE identity_deletion_recipients SET attempts=attempts+1,last_error=$3,
        retry_at=now()+LEAST(interval '1 hour', interval '2 seconds' * power(2,LEAST(attempts,10))) WHERE event_id=$1 AND mod_id=$2 AND acknowledged_at IS NULL`,[eventId,modId,code]);
      await c.query(`UPDATE identity_deletion_events SET state='failed',attempts=attempts+1,last_error=$2 WHERE event_id=$1`,[eventId,code]);
    });
  }
  async listIdentityDeletionCleanup({ limit = 100 } = {}) {
    if (!Number.isInteger(limit) || limit<1 || limit>500) throw Object.assign(new Error('agent_deletion_query_invalid'),{statusCode:400});
    return (await this.pool.query(`SELECT e.event_id AS "eventId",e.agent_id AS "agentId",e.owner_mod_id AS "ownerModId",e.state,e.attempts,e.last_error AS "lastError",e.deleted_at AS "deletedAt",e.storage_reference IS NOT NULL AS "storagePending",
      COALESCE(jsonb_agg(jsonb_build_object('modId',r.mod_id,'acknowledged',r.acknowledged_at IS NOT NULL,'attempts',r.attempts,'lastError',r.last_error)) FILTER(WHERE r.mod_id IS NOT NULL),'[]'::jsonb) AS recipients
      FROM identity_deletion_events e LEFT JOIN identity_deletion_recipients r USING(event_id)
      WHERE e.state<>'complete' GROUP BY e.event_id ORDER BY e.deleted_at DESC LIMIT $1`,[Math.min(500,Math.max(1,limit))])).rows;
  }
  async latestIdentityDeletionForAgent(agentId) {
    const row = (await this.pool.query(`SELECT event_id AS "eventId",state,attempts,last_error AS "lastError",deleted_at AS "deletedAt",storage_reference IS NOT NULL AS "storagePending" FROM identity_deletion_events WHERE agent_id=$1 ORDER BY deleted_at DESC LIMIT 1`, [agentId])).rows[0];
    return row || null;
  }
}
export const __postgresAgentRegistry = Object.freeze({
  DEFAULT_CAPABILITIES,
  assertAgent,
});
