import { normalizePostgresPool } from './postgres-foundation.mjs';
import { readRollingCards, writeRollingCard, rollingCardActive, pruneRollingCards } from './postgres-rolling-continuity-store.mjs';
import { createHash } from "node:crypto";
import {
  closePostgresPool,
  withPostgresTransaction,
} from "./postgres-foundation.mjs";

const KINDS = new Set(["decision", "finding", "blocker", "handoff", "task"]);
const STATES = new Set(["active", "resolved", "superseded"]);
const PROJECTS = new Set(["user", "openclaw", "Burrow", "GKD"]);
const DEFAULT_TTL_DAYS = 90;
const DEFAULT_RETENTION = Object.freeze({ workingMemoryTtlDays: 90, rollingContinuityTtlDays: 90 });
const MAX_COMPACT_CONTENT_CHARS = 2400;
const text = (v) => String(v ?? "").trim();
const bounded = (v, n) => text(v).slice(0, n).trim();
const json = (v) => JSON.stringify(v ?? []);
const parse = (v, fallback = null) => {
  if (v && typeof v === "object") return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
};
const expiry = (days = DEFAULT_TTL_DAYS, stamp = new Date().toISOString()) =>
  new Date(
    new Date(stamp).getTime() + Math.max(1, Number(days) || DEFAULT_TTL_DAYS) * 86400000,
  ).toISOString();
const warmKey = (v) =>
  createHash("sha256")
    .update(text(v).toLowerCase().replace(/\s+/g, " "))
    .digest("hex")
    .slice(0, 24);
const warmTokens = (v) => [
  ...new Set(
    text(v)
      .toLowerCase()
      .split(/[^a-z0-9_-]+/u)
      .filter((x) => x.length >= 4),
  ),
];
const sharedRefs = (a, b) => {
  const s = new Set((a || []).map(text));
  return (b || []).some((x) => s.has(text(x)));
};
const similarity = (a, b) => {
  const x = new Set(warmTokens(a));
  const y = new Set(warmTokens(b));
  return x.size && y.size
    ? [...x].filter((t) => y.has(t)).length / Math.min(x.size, y.size)
    : 0;
};
const clamp = (v, lo, hi, fallback) =>
  Math.max(lo, Math.min(hi, Number(v) || fallback));

export const POSTGRES_WORKING_MEMORY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS working_memory (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, session_id TEXT NOT NULL, conversation_id TEXT NOT NULL, project TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('decision','finding','blocker','handoff','task')), state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','resolved','superseded')), title TEXT NOT NULL, content TEXT NOT NULL, source_refs JSONB NOT NULL DEFAULT '[]'::jsonb, pinned BOOLEAN NOT NULL DEFAULT false, created_at TIMESTAMPTZ NOT NULL, updated_at TIMESTAMPTZ NOT NULL, expires_at TIMESTAMPTZ NOT NULL, last_recalled_at TIMESTAMPTZ);
CREATE INDEX IF NOT EXISTS working_memory_scope_idx ON working_memory(agent_id, project, state, expires_at);
CREATE INDEX IF NOT EXISTS working_memory_search_idx ON working_memory USING GIN (to_tsvector('simple', title || ' ' || content));
CREATE TABLE IF NOT EXISTS working_memory_meta (key TEXT PRIMARY KEY, value_json JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL);
`;
export const WORKING_MEMORY_SCHEMA_SQL = POSTGRES_WORKING_MEMORY_SCHEMA_SQL;

function validate(input = {}) {
  const r = {
    id: text(input.id),
    agentId: text(input.agentId),
    sessionId: text(input.sessionId),
    conversationId: text(input.conversationId),
    project: text(input.project),
    kind: text(input.kind),
    state: text(input.state || "active"),
    title: text(input.title),
    content: text(input.content),
    sourceRefs: Array.isArray(input.sourceRefs)
      ? input.sourceRefs.map(text).filter(Boolean).slice(0, 12)
      : [],
    pinned: input.pinned === true,
  };
  if (!r.id) throw Error("working_memory_id_required");
  for (const k of [
    "agentId",
    "sessionId",
    "conversationId",
    "project",
    "title",
    "content",
  ])
    if (!r[k]) throw Error(`working_memory_${k}_required`);
  if (!KINDS.has(r.kind)) throw Error("working_memory_kind_invalid");
  if (!STATES.has(r.state)) throw Error("working_memory_state_invalid");
  if (r.title.length > 240 || r.content.length > 6000)
    throw Error("working_memory_content_too_large");
  return r;
}
function row(r) {
  return (
    r && {
      id: r.id,
      agentId: r.agent_id,
      sessionId: r.session_id,
      conversationId: r.conversation_id,
      project: r.project,
      kind: r.kind,
      state: r.state,
      title: r.title,
      content: r.content,
      sourceRefs: parse(r.source_refs, []),
      pinned: Boolean(r.pinned),
      createdAt: new Date(r.created_at).toISOString(),
      updatedAt: new Date(r.updated_at).toISOString(),
      expiresAt: new Date(r.expires_at).toISOString(),
      lastRecalledAt: r.last_recalled_at
        ? new Date(r.last_recalled_at).toISOString()
        : null,
    }
  );
}

export class PostgresWorkingMemoryStore {
  constructor({
    pool,
    ownsPool = false,
    clock = () => new Date().toISOString(),
    retention = null,
  } = {}) {
    if (!pool?.query || !pool?.connect)
      throw Error("working_memory_postgres_pool_required");
    this.pool = normalizePostgresPool(pool);
    this.ownsPool = ownsPool;
    this.clock = clock;
    // Retention is injected because the operator policy is owned by the
    // runtime/settings layer; keeping it async-compatible avoids new wiring.
    this.retentionSource = retention;
    this.retention = null;
    this.initialization = null;
  }
  async close() {
    if (this.ownsPool) await closePostgresPool(this.pool);
  }
  async initialize(client = this.pool) {
    await client.query(POSTGRES_WORKING_MEMORY_SCHEMA_SQL);
    const source = typeof this.retentionSource === "function"
      ? await this.retentionSource()
      : await this.retentionSource;
    this.retention = { ...DEFAULT_RETENTION, ...(source || {}) };
  }
  async ready() {
    if (!this.initialization)
      this.initialization = this.initialize().catch((e) => {
        this.initialization = null;
        throw e;
      });
    return this.initialization;
  }
  async get(id, agentId, client = this.pool) {
    if (client === this.pool) await this.ready();
    const q = await client.query(
      "SELECT * FROM working_memory WHERE id=$1 AND agent_id=$2",
      [id, agentId],
    );
    return row(q.rows[0]);
  }
  async record(input = {}) {
    await this.ready();
    const policy = typeof this.retentionSource === "function" ? { ...DEFAULT_RETENTION, ...await this.retentionSource() } : this.retention;
    const r = validate(input),
      stamp = this.clock();
    return withPostgresTransaction(this.pool, async (c) => {
      const old = (
        await c.query(
          "SELECT * FROM working_memory WHERE id=$1 AND agent_id=$2 FOR UPDATE",
          [r.id, r.agentId],
        )
      ).rows[0];
      const refs = json(r.sourceRefs);
      const material =
        !old ||
        [
          old.session_id !== r.sessionId,
          old.conversation_id !== r.conversationId,
          old.project !== r.project,
          old.kind !== r.kind,
          old.state !== r.state,
          old.title !== r.title,
          old.content !== r.content,
          JSON.stringify(parse(old.source_refs, [])) !== refs,
          Boolean(old.pinned) !== r.pinned,
        ].some(Boolean);
      const expiresAt = material
        ? input.expiresAt || expiry(input.ttlDays ?? policy.workingMemoryTtlDays, stamp)
        : old.expires_at;
      const written = await c.query(
        `INSERT INTO working_memory(id,agent_id,session_id,conversation_id,project,kind,state,title,content,source_refs,pinned,created_at,updated_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$12,$13) ON CONFLICT(id) DO UPDATE SET session_id=EXCLUDED.session_id,conversation_id=EXCLUDED.conversation_id,project=EXCLUDED.project,kind=EXCLUDED.kind,state=EXCLUDED.state,title=EXCLUDED.title,content=EXCLUDED.content,source_refs=EXCLUDED.source_refs,pinned=EXCLUDED.pinned,updated_at=EXCLUDED.updated_at,expires_at=EXCLUDED.expires_at WHERE working_memory.agent_id=EXCLUDED.agent_id RETURNING id`,
        [
          r.id,
          r.agentId,
          r.sessionId,
          r.conversationId,
          r.project,
          r.kind,
          r.state,
          r.title,
          r.content,
          refs,
          r.pinned,
          stamp,
          expiresAt,
        ],
      );
      if (!written.rows.length) throw Error("working_memory_owner_conflict");
      return this.get(r.id, r.agentId, c);
    });
  }
  async list({
    agentId,
    project = null,
    includeInactive = false,
    limit = 50,
  } = {}) {
    await this.ready();
    if (!text(agentId)) throw Error("working_memory_agent_id_required");
    const q = await this.pool.query(
      `SELECT * FROM working_memory WHERE agent_id=$1 AND ($2::text IS NULL OR project=$2) AND (pinned OR expires_at >= $3) AND ($4 OR state='active') ORDER BY updated_at DESC LIMIT $5`,
      [
        agentId,
        project || null,
        this.clock(),
        includeInactive,
        clamp(limit, 1, 100, 50),
      ],
    );
    return q.rows.map(row);
  }
  async search({
    agentId,
    project = null,
    query,
    limit = 5,
    includeInactive = false,
  } = {}) {
    await this.ready();
    if (!text(agentId)) throw Error("working_memory_agent_id_required");
    if (!text(query)) return [];
    const q = await this.pool.query(
      `WITH matches AS (SELECT m.*, ts_rank_cd(to_tsvector('simple',m.title || ' ' || m.content), websearch_to_tsquery('simple',$3)) score FROM working_memory m WHERE m.agent_id=$1 AND ($2::text IS NULL OR m.project=$2) AND (m.pinned OR m.expires_at >= $4) AND ($5 OR m.state='active') AND to_tsvector('simple',m.title || ' ' || m.content) @@ websearch_to_tsquery('simple',$3)) SELECT * FROM matches ORDER BY score DESC,updated_at DESC LIMIT $6`,
      [
        agentId,
        project || null,
        query,
        this.clock(),
        includeInactive,
        clamp(limit, 1, 10, 5),
      ],
    );
    return q.rows.map((x) => ({ ...row(x), score: Number(x.score) }));
  }
  async metaGet(key, client = this.pool, lock = false) {
    const q = await client.query(
      `SELECT value_json FROM working_memory_meta WHERE key=$1${lock ? " FOR UPDATE" : ""}`,
      [key],
    );
    return q.rows[0] ? parse(q.rows[0].value_json) : null;
  }
  async metaSet(key, value, client = this.pool) {
    await client.query(
      "INSERT INTO working_memory_meta(key,value_json,updated_at) VALUES($1,$2::jsonb,$3) ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at",
      [key, JSON.stringify(value), this.clock()],
    );
    return value;
  }
  async dreamRead(identity, kind, client = this.pool) {
    const field = kind === 'ledger' ? 'entries' : 'items';
    const envelope = await client.query("SELECT envelope_id,metadata FROM dream_state_envelopes WHERE agent_id=$1 AND project=$2 AND kind=$3 AND scope=''", [identity.agentId,identity.project || '',kind]);
    if (!envelope.rows.length) return null;
    const entries = await client.query(`SELECT payload${kind === 'scope_review' ? ',entry_id::text' : ''} FROM dream_${kind}_entries WHERE envelope_id=$1 ORDER BY position`,[envelope.rows[0].envelope_id]);
    return {...envelope.rows[0].metadata,[field]:entries.rows.map(row=>kind === 'scope_review' ? {...row.payload,entryId:row.entry_id} : row.payload)};
  }

  async dreamWrite(identity, kind, value, client = null, append = false) {
    if (!client) return withPostgresTransaction(this.pool, c => this.dreamWrite(identity, kind, value, c, append));
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify([identity.agentId,identity.project || '',kind])]);
    const field = kind === 'ledger' ? 'entries' : 'items';
    const { [field]: entries, ...metadata } = value;
    const envelope = await client.query(`INSERT INTO dream_state_envelopes(agent_id,project,kind,scope,metadata,updated_at) VALUES($1,$2,$3,'',$4::json,$5) ON CONFLICT(agent_id,project,kind,scope) DO UPDATE SET updated_at=EXCLUDED.updated_at RETURNING envelope_id,metadata`, [identity.agentId,identity.project || '',kind,JSON.stringify(metadata),this.clock()]);
    const id = envelope.rows[0].envelope_id;
    await client.query('UPDATE dream_state_envelopes SET metadata=$2::json WHERE envelope_id=$1',[id,JSON.stringify({...envelope.rows[0].metadata,...metadata})]);
    let start = 1;
    if (append) {
      const result = await client.query(`SELECT min(position) AS first FROM dream_${kind}_entries WHERE envelope_id=$1`, [id]);
      start = Number(result.rows[0].first ?? 1) - entries.length;
    } else await client.query(`DELETE FROM dream_${kind}_entries WHERE envelope_id=$1`, [id]);
    await client.query(`INSERT INTO dream_${kind}_entries(envelope_id,position,payload) SELECT $1,$2::bigint+ordinality-1,value FROM json_array_elements($3::json) WITH ORDINALITY`, [id,start,JSON.stringify(entries)]);
    return this.dreamRead(identity, kind, client);
  }
  async replaceDreamPreload({ agentId, project, items = [], expiresAt } = {}, client = null) {
    await this.ready();
    if (!text(agentId) || !text(project))
      throw Error("dream_preload_scope_required");
    const normalized = (Array.isArray(items) ? items : [])
      .map((i) => {
        if (text(i.content).length > MAX_COMPACT_CONTENT_CHARS)
          throw Error("dream_preload_content_too_large");
        return {
          id: text(i.id),
          title: bounded(i.title, 240),
          content: text(i.content),
          sourceRefs: (i.sourceRefs || [])
            .map(text)
            .filter(Boolean),
        };
      })
      .filter((i) => i.id && i.title && i.content && i.sourceRefs.length);
    const write = async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [JSON.stringify([agentId, "preload-set"])]);
      return this.dreamWrite(
        { agentId, project }, 'preload',
        {
          version: 1,
          agentId,
          project,
          items: normalized,
          expiresAt: text(expiresAt),
          updatedAt: this.clock(),
        },
        c,
      );
    };
    return client ? write(client) : withPostgresTransaction(this.pool, write);
  }
  async replaceDreamPreloads({ agentId, scopes = [], expiresAt } = {}) {
    await this.ready();
    if (!text(agentId)) throw Error("dream_preload_scope_required");
    return withPostgresTransaction(this.pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [JSON.stringify([agentId, "preload-set"])]);
      await client.query("DELETE FROM dream_state_envelopes WHERE agent_id=$1 AND kind='preload'", [agentId]);
      const results = [];
      for (const scope of scopes) results.push(await this.replaceDreamPreload({ ...scope, agentId, expiresAt }, client));
      return results;
    });
  }
  async getDreamPreload({ agentId, project } = {}) {
    await this.ready();
    if (!text(agentId) || !text(project)) return null;
    const v = await this.dreamRead({ agentId, project }, 'preload');
    return v?.expiresAt && v.expiresAt < this.clock() ? null : v;
  }
  async appendDreamLedger({ agentId, project, mode, entries = [] } = {}) {
    await this.ready();
    if (!text(agentId) || !text(project) || !text(mode))
      throw Error("dream_ledger_scope_required");
    return withPostgresTransaction(this.pool, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        { agentId, project },
      ]);
      const normalized = (Array.isArray(entries) ? entries : [])
        .map((e) => ({
          action: text(e.action),
          candidateKey: text(e.candidateKey),
          memoryId: text(e.memoryId) || null,
          recordId: text(e.recordId) || null,
          sourceRefs: (e.sourceRefs || [])
            .map(text)
            .filter(Boolean),
          reason: bounded(e.reason, 240) || null,
          ts: text(e.ts) || this.clock(),
        }))
        .filter((e) => e.action && e.candidateKey);
      return this.dreamWrite(
        { agentId, project }, 'ledger',
        {
          version: 1,
          agentId,
          project,
          entries: normalized,
          updatedAt: this.clock(),
        },
        c, true,
      );
    });
  }
  async getDreamLedger({ agentId, project } = {}) {
    await this.ready();
    if (!text(agentId) || !text(project)) return null;
    return this.dreamRead({ agentId, project }, 'ledger');
  }
  async supersedeDreamRecords({ agentId, project, keepIds = [] } = {}) {
    await this.ready();
    if (!text(agentId) || !text(project)) throw Error('dream_supersede_scope_required');
    const at = this.clock();
    const result = await this.pool.query(
      `UPDATE working_memory SET state='superseded', updated_at=$3
       WHERE agent_id=$1 AND project=$2 AND state='active'
         AND (pinned OR expires_at >= $3) AND id LIKE 'dream-%'
         AND NOT (id = ANY($4::text[])) RETURNING *`,
      [text(agentId), text(project), at, (keepIds || []).map(text)],
    );
    return result.rows.map(row);
  }
  async replaceDreamScopeReviewQueue({
    agentId,
    mode,
    candidates = [],
    expiresAt,
  } = {}) {
    await this.ready();
    if (!text(agentId)) throw Error("dream_scope_review_agent_required");
    const items = (Array.isArray(candidates) ? candidates : [])
      .map((c) => ({
        kind: text(c.kind || c.type),
        title: bounded(c.title, 240),
        content: text(c.content),
        sourceRefs: (c.sourceRefs || []).map(text).filter(Boolean),
        confidence: Number(c.confidence),
      }))
      .filter(
        (c) =>
          c.kind &&
          c.title &&
          c.content &&
          c.sourceRefs.length &&
          Number.isFinite(c.confidence),
      );
    if (items.some((c) => c.content.length > MAX_COMPACT_CONTENT_CHARS))
      throw Error("dream_scope_review_content_too_large");
    return this.dreamWrite({ agentId }, 'scope_review', {
      version: 1,
      agentId,
      mode: text(mode),
      disposition: "scope_uncertain",
      items,
      expiresAt: text(expiresAt),
      updatedAt: this.clock(),
    });
  }
  async getDreamScopeReviewQueue({ agentId } = {}) {
    await this.ready();
    if (!text(agentId)) return null;
    const v = await this.dreamRead({ agentId }, 'scope_review');
    return v?.expiresAt && v.expiresAt < this.clock() ? null : v;
  }
  async assignDreamScopeReview({ agentId, entryId, index, project } = {}) {
    // Positional-only requests cannot prove which queue revision was reviewed.
    if (!text(entryId)) throw Error("dream_scope_review_entry_id_required");
    if (!text(agentId)) throw Error("dream_scope_review_agent_required");
    if (!PROJECTS.has(text(project)))
      throw Error("dream_scope_review_project_invalid");
    await this.ready();
    return withPostgresTransaction(this.pool, async (c) => {
      const key = { agentId };
      await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [JSON.stringify([agentId,'','scope_review'])]);
      const queue = await this.dreamRead(key, 'scope_review', c);
      if (!queue || (queue.expiresAt && queue.expiresAt < this.clock()))
        throw Error("dream_scope_review_not_found");
      const n = queue.items.findIndex(item => item.entryId === text(entryId));
      if (n < 0) throw Error("dream_scope_review_entry_not_found");
      if (index !== undefined && (!Number.isInteger(Number(index)) || Number(index) !== n))
        throw Error("dream_scope_review_index_invalid");
      const item = queue.items[n];
      const id = `dream-${createHash("sha256").update([agentId, project, item.kind, item.title].join("\0")).digest("hex")}`;
      const stamp = this.clock();
      const expiresAt = queue.expiresAt || expiry();
      const refs = json(item.sourceRefs);
      const inserted = await c.query(
        `INSERT INTO working_memory(id,agent_id,session_id,conversation_id,project,kind,state,title,content,source_refs,pinned,created_at,updated_at,expires_at)
        VALUES($1,$2,'dream-scope-review','dream-scope-review',$3,$4,'active',$5,$6,$7::jsonb,false,$8,$8,$9)
        ON CONFLICT(id) DO UPDATE SET project=EXCLUDED.project,kind=EXCLUDED.kind,title=EXCLUDED.title,content=EXCLUDED.content,source_refs=EXCLUDED.source_refs,updated_at=EXCLUDED.updated_at,expires_at=EXCLUDED.expires_at RETURNING *`,
        [
          id,
          agentId,
          text(project),
          item.kind,
          item.title,
          item.content,
          refs,
          stamp,
          expiresAt,
        ],
      );
      const record = row(inserted.rows[0]);
      const deleted = await c.query(`DELETE FROM dream_scope_review_entries d USING dream_state_envelopes e WHERE d.envelope_id=e.envelope_id AND e.agent_id=$1 AND e.kind='scope_review' AND e.project='' AND e.scope='' AND d.entry_id::text=$2 RETURNING entry_id`, [agentId,item.entryId]);
      if (deleted.rowCount !== 1) throw Error('dream_scope_review_entry_not_found');
      await c.query("UPDATE dream_state_envelopes SET metadata=$3::json,updated_at=$2::timestamptz WHERE agent_id=$1 AND kind='scope_review' AND project='' AND scope=''", [agentId,this.clock(),JSON.stringify({...queue,items:undefined,updatedAt:this.clock()})]);
      return {
        record,
        assignedIndex: n,
        assignedEntryId: item.entryId,
        remainingCount: queue.items.length - 1,
        disposition: "assigned_local_only",
      };
    });
  }
  async upsertRollingContinuityCard({
    agentId,
    project,
    title,
    content,
    sourceRefs = [],
    evidence = "conversation",
    reason = null,
    ttlDays,
  } = {}) {
    await this.ready();
    if (!text(agentId) || !text(project) || !text(title))
      throw Error("rolling_continuity_scope_required");
    if (text(content || "").length > MAX_COMPACT_CONTENT_CHARS)
      throw Error("rolling_continuity_summary_too_large");
    return withPostgresTransaction(this.pool, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`tiddle:${agentId}`]);
      const v = { cards: await readRollingCards(c, agentId, project) },
        cards = (v?.cards || []).filter(card => rollingCardActive(card, this.clock())),
        refs = sourceRefs.map(text).filter(Boolean),
        existing =
          cards.find((x) => sharedRefs(x.recentRefs, refs)) ||
          cards.find(
            (x) =>
              similarity(`${x.title} ${x.summary}`, `${title} ${content}`) >=
              0.8,
          );
      if (text(content || existing?.summary).length > MAX_COMPACT_CONTENT_CHARS)
        throw Error("rolling_continuity_summary_too_large");
      const stamp = this.clock(),
        card = {
          id:
            existing?.id ||
            `warm:${warmKey(`${agentId}\0${project}\0${title}`)}`,
          agentId,
          project,
          title: bounded(title, 240),
          summary: text(content || existing?.summary),
          firstSeen: existing?.firstSeen || stamp,
          lastSeen: stamp,
          recurrence: Number(existing?.recurrence || 0) + 1,
          recentRefs: [
            ...new Set([...(existing?.recentRefs || []), ...refs]),
          ].slice(-20),
          evidence: bounded(evidence, 80),
          reason: bounded(reason, 360) || null,
          expiresAt: new Date(new Date(stamp).getTime() + Math.max(1, Number(ttlDays ?? (typeof this.retentionSource === "function" ? (await this.retentionSource()).rollingContinuityTtlDays : this.retention.rollingContinuityTtlDays)) || DEFAULT_RETENTION.rollingContinuityTtlDays) * 86400000).toISOString(),
        };
      await writeRollingCard(c, card, stamp);
      return card;
    });
  }
  async pruneRollingContinuityCards(client = this.pool) {
    const policy = typeof this.retentionSource === 'function' ? await this.retentionSource() : this.retention;
    const {rows} = await client.query('SELECT DISTINCT agent_id FROM rolling_continuity_cards');
    let removed=0;
    for (const row of rows) removed += await pruneRollingCards(client,row.agent_id,this.clock(),policy?.rollingContinuityTtlDays ?? 90);
    return removed;
  }
  async listRollingContinuityCards({
    agentId,
    project = null,
    limit = 20,
  } = {}) {
    await this.ready();
    if (!text(agentId)) return [];
    if (!text(project))
      return this.listAllRollingContinuityCards({ agentId, limit });
    await this.pruneRollingContinuityCards();
    const v = { cards: await readRollingCards(this.pool, agentId, project) };
    return (v?.cards || [])
      .filter((x) => rollingCardActive(x, this.clock()))
      .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
      .slice(0, clamp(limit, 1, Number.MAX_SAFE_INTEGER, 20));
  }
  async listAllRollingContinuityCards({ agentId, limit = 20 } = {}) {
    await this.ready();
    if (!text(agentId)) return [];
    await this.pruneRollingContinuityCards();
    return (await readRollingCards(this.pool, agentId))
      .filter(
        (x) =>
          x.agentId === text(agentId) &&
          (rollingCardActive(x, this.clock())),
      )
      .sort((a, b) => String(b.lastSeen).localeCompare(String(a.lastSeen)))
      .slice(0, clamp(limit, 1, Number.MAX_SAFE_INTEGER, 20));
  }
  async searchRollingContinuityCards({
    agentId,
    project,
    query,
    limit = 5,
  } = {}) {
    const needle = text(query).toLowerCase();
    if (!needle) return [];
    const tokens = needle
      .split(/[^a-z0-9_-]+/u)
      .filter((token) => token.length >= 2);
    return (
      await this.listRollingContinuityCards({ agentId, project, limit: Number.MAX_SAFE_INTEGER })
    )
      .map((card) => {
        const haystack =
          `${card.title || ""} ${card.summary || ""}`.toLowerCase();
        const exact = haystack.includes(needle);
        const hits = tokens.filter((token) => haystack.includes(token)).length;
        return {
          ...card,
          score:
            (!exact && hits === 0) ? 0 :
            (exact ? 100 : 0) +
            hits * 10 +
            Math.min(20, Number(card.recurrence || 0)),
        };
      })
      .filter((card) => card.score > 0)
      .sort(
        (a, b) =>
          Number(b.score) - Number(a.score) ||
          String(b.lastSeen).localeCompare(String(a.lastSeen)),
      )
      .slice(0, clamp(limit, 1, 20, 5));
  }
  async listBrainPromotionCandidates({
    agentId,
    status = "pending",
    limit = 20,
  } = {}) {
    await this.ready();
    if (!text(agentId)) throw Error("brain_promotion_agent_id_required");
    const v = await this.metaGet(`brain-promotion-candidates:${agentId}`);
    return (v?.entries || [])
      .filter((e) => text(status) === "all" || e.status === text(status))
      .slice(0, clamp(limit, 1, 50, 20));
  }
  async upsertBrainPromotionCandidate({ agentId, record, reason = null } = {}) {
    await this.ready();
    if (!text(agentId) || !record?.id)
      throw Error("brain_promotion_scope_required");
    if (
      !["decision", "finding", "blocker", "handoff"].includes(record.kind) ||
      record.state !== "active"
    )
      return null;
    const key = `brain-promotion-candidates:${agentId}`;
    return withPostgresTransaction(this.pool, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
      const v = await this.metaGet(key, c),
        stamp = this.clock(),
        candidate = {
          id: `brain-candidate:${record.id}`,
          status: "pending",
          agentId,
          recordId: record.id,
          project: record.project,
          kind: record.kind,
          title: bounded(record.title, 240),
          content: bounded(record.content, 1800),
          sourceRefs: (record.sourceRefs || []).slice(0, 12),
          reason:
            bounded(reason, 360) ||
            "STM record may be durable enough for deliberate Brain promotion review.",
          createdAt: stamp,
          updatedAt: stamp,
        };
      const entries = [
        candidate,
        ...(v?.entries || []).filter((e) => e.id !== candidate.id),
      ].slice(0, 50);
      await this.metaSet(
        key,
        { version: 1, agentId, entries, updatedAt: stamp },
        c,
      );
      return candidate;
    });
  }
  async updateBrainPromotionCandidate({
    agentId,
    candidateId,
    status,
    reason = null,
  } = {}) {
    if (!text(agentId) || !text(candidateId))
      throw Error("brain_promotion_scope_required");
    if (!["pending", "promoted", "dismissed"].includes(text(status)))
      throw Error("brain_promotion_status_invalid");
    await this.ready();
    const key = `brain-promotion-candidates:${agentId}`;
    return withPostgresTransaction(this.pool, async (c) => {
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
      const v = await this.metaGet(key, c),
        found = (v?.entries || []).find((e) => e.id === candidateId);
      if (!found) throw Error("brain_promotion_candidate_not_found");
      const updated = {
        ...found,
        status: text(status),
        dispositionReason: bounded(reason, 360) || null,
        updatedAt: this.clock(),
      };
      await this.metaSet(
        key,
        {
          ...v,
          entries: (v.entries || []).map((e) =>
            e.id === candidateId ? updated : e,
          ),
          updatedAt: this.clock(),
        },
        c,
      );
      return updated;
    });
  }
}
export const __test__ = { validate };
export default PostgresWorkingMemoryStore;
