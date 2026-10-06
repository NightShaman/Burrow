import { normalizePostgresPool } from './postgres-foundation.mjs';
import { isChatMessage } from './session-entry.mjs';
import { resolveAlbdruckConfig } from './config.mjs';
import { assertConversationDeletionAllowed } from './postgres-session-store.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { withPostgresTransaction } from './postgres-foundation.mjs';

// Appended migration only: neither knowledge nor excerpts are original evidence.
export const POSTGRES_ALBDRUCK_SCHEMA_SQL = `
CREATE TABLE albdruck_knowledge (
 id TEXT PRIMARY KEY, scope TEXT NOT NULL, fingerprint TEXT NOT NULL,
 document JSONB NOT NULL, state TEXT NOT NULL DEFAULT 'active',
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(scope, fingerprint), CHECK(state IN ('active','superseded','deleted'))
);
CREATE TABLE albdruck_evidence (
 knowledge_id TEXT NOT NULL REFERENCES albdruck_knowledge(id) ON DELETE CASCADE,
 evidence_key TEXT NOT NULL, source_ref JSONB NOT NULL, excerpt TEXT NOT NULL,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 PRIMARY KEY(knowledge_id,evidence_key)
);
CREATE TABLE albdruck_revisions (
 id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
 knowledge_id TEXT NOT NULL REFERENCES albdruck_knowledge(id) ON DELETE CASCADE,
 operation TEXT NOT NULL, document JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE albdruck_retention (owner_id TEXT PRIMARY KEY, policy JSONB NOT NULL);
CREATE INDEX albdruck_scope_cursor ON albdruck_knowledge(scope,id);
`;

export const DEFAULT_ALBDRUCK_RETENTION = Object.freeze({ conversationDays: null, operationalDays: null, attachmentDays: 30, knowledgeDays: null, evidenceDays: null, revisionDays: null });

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}
export function normalizeKnowledge(input) {
  if (!input || typeof input.claim !== 'string' || !input.claim.trim()) throw new Error('albdruck_claim_required');
  const result = { claim: input.claim.trim(), rationale: input.rationale ?? null, alternatives: input.alternatives ?? [], constraints: input.constraints ?? [], relationships: input.relationships ?? [] };
  if (result.rationale !== null && typeof result.rationale !== 'string') throw new Error('albdruck_rationale_invalid');
  for (const key of ['alternatives','constraints','relationships']) if (!Array.isArray(result[key])) throw new Error(`albdruck_${key}_invalid`);
  return canonical(result);
}
export function knowledgeFingerprint(document) {
  return createHash('sha256').update(JSON.stringify(normalizeKnowledge(document))).digest('hex');
}
function scopeKey({ agentId, scope = 'agent' }) {
  if (scope === 'global') return 'global';
  if (scope !== 'agent' || !agentId) throw new Error('albdruck_scope_invalid');
  return `agent:${agentId}`;
}
export function validateOriginalRef(ref) {
  if (!ref || ref.kind !== 'conversation_entry' || !ref.agentId || !ref.sessionId || !ref.entryId) throw new Error('albdruck_original_conversation_ref_required');
  return { kind: ref.kind, agentId: String(ref.agentId), sessionId: String(ref.sessionId), entryId: String(ref.entryId) };
}

/** resolveOriginal must consult conversation authority, including reset archives.
 * It returns the original entry or null, never a summary or another memory. */
export class PostgresAlbdruckStore {
  constructor({ pool, resolveOriginal, searchHistory, maxPageSize = resolveAlbdruckConfig().maxPageSize }) {
    if (!pool || typeof resolveOriginal !== 'function') throw new Error('albdruck_dependencies_required');
    if (!Number.isInteger(maxPageSize) || maxPageSize < 1) throw new Error('albdruck_page_bound_invalid');
    this.searchHistory = searchHistory; this.pool = normalizePostgresPool(pool); this.resolveOriginal = resolveOriginal; this.maxPageSize = maxPageSize;
  }
  async purgeConversation({ agentId, sessionId, reason } = {}) {
    if ([agentId, sessionId, reason].some(value => typeof value !== 'string' || !value.trim())) throw new Error('albdruck_purge_invalid');
    agentId = agentId.trim(); sessionId = sessionId.trim();
    return withPostgresTransaction(this.pool, async client => {
      // Serialize evidence writes with purge; no content-bearing audit is written.
      await client.query('LOCK TABLE albdruck_knowledge, albdruck_evidence, albdruck_revisions IN SHARE ROW EXCLUSIVE MODE');
      const { rows } = await client.query('SELECT metadata FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, sessionId]);
      const active = await client.query('SELECT head_state,queue_status FROM continuity_state WHERE agent_id=$1 AND session_id=$2', [agentId, sessionId]);
      if (['running','finalizing'].includes(active.rows[0]?.head_state) || active.rows[0]?.queue_status === 'running') throw new Error('albdruck_purge_session_retention_active');
      try { if (rows.length) assertConversationDeletionAllowed(sessionId, rows[0].metadata); }
      catch (error) { throw new Error(`albdruck_purge_${error.message}`); }
      const affected = await client.query("SELECT DISTINCT knowledge_id FROM albdruck_evidence WHERE source_ref->>'agentId'=$1 AND source_ref->>'sessionId'=$2", [agentId, sessionId]);
      const ids = affected.rows.map(row => row.knowledge_id);
      // Revisions belong to knowledge, not to an individual source. Preserve them
      // whenever the knowledge survives with independent supporting evidence.
      const revisions = 0;
      const evidence = (await client.query("DELETE FROM albdruck_evidence WHERE source_ref->>'agentId'=$1 AND source_ref->>'sessionId'=$2", [agentId, sessionId])).rowCount;
      const knowledge = (await client.query(`DELETE FROM albdruck_knowledge k WHERE id=ANY($1::text[]) AND NOT EXISTS (SELECT 1 FROM albdruck_evidence e WHERE e.knowledge_id=k.id) AND NOT EXISTS (SELECT 1 FROM albdruck_revisions r WHERE r.knowledge_id=k.id AND r.operation='correct')`, [ids])).rowCount;
      const derived = {};
      for (const table of ['working_memory', 'continuity_handoffs']) {
        derived[table] = (await client.query(`DELETE FROM ${table} WHERE agent_id=$1
          AND (session_id=$2 OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(source_refs) ref WHERE starts_with(ref,$3)))
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(source_refs) ref WHERE NOT starts_with(ref,$3))
          ${table === 'working_memory' ? 'AND pinned=false' : ''}`, [agentId,sessionId,`session:${sessionId}:`])).rowCount;
        await client.query(`UPDATE ${table} SET source_refs=(SELECT coalesce(jsonb_agg(ref),'[]'::jsonb) FROM jsonb_array_elements_text(source_refs) ref WHERE NOT starts_with(ref,$2)) WHERE agent_id=$1 AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(source_refs) ref WHERE starts_with(ref,$2))`,[agentId,`session:${sessionId}:`]);
      }
      derived.conversation_project_bindings=(await client.query('DELETE FROM conversation_project_bindings WHERE agent_id=$1 AND session_id=$2',[agentId,sessionId])).rowCount;
      // Extraction batches are checkpoints tied to their original sources.
      derived.dream_extraction_batches = (await client.query("DELETE FROM dream_extraction_batches WHERE agent_id=$1 AND EXISTS (SELECT 1 FROM jsonb_array_elements(sources) source WHERE source->>'sessionId'=$2 OR source->>'session_id'=$2 OR starts_with(source->>'sourceRef','session:' || $2 || ':'))", [agentId, sessionId])).rowCount;
      derived.dream_diary_entries = (await client.query("DELETE FROM dream_diary_entries WHERE agent_id=$1 AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(source_refs) ref WHERE starts_with(ref,$2))", [agentId, `session:${sessionId}:`])).rowCount;
      // Aggregates lack reliable per-entry provenance: conservatively discard any
      // aggregate containing a reference to this conversation rather than redact.
      derived.working_memory_meta = (await client.query("DELETE FROM working_memory_meta WHERE value_json->>'agentId'=$1 AND strpos(value_json::text,$2)>0", [agentId, `session:${sessionId}:`])).rowCount;
      for (const kind of ['ledger', 'preload', 'scope_review']) {
        derived[`dream_${kind}_entries`] = (await client.query(`DELETE FROM dream_${kind}_entries d USING dream_state_envelopes e WHERE d.envelope_id=e.envelope_id AND e.agent_id=$1 AND d.source_sessions @> ARRAY[$2]::text[]`, [agentId, sessionId])).rowCount;
      }
      // Native continuity payloads may contain NUL/surrogates: inspect decoded
      // JSON in JS rather than casting payloads through jsonb or text extraction.
      const prefix = `session:${sessionId}:`;
      const references = value => {
        if (typeof value === 'string') return value.startsWith(prefix);
        if (Array.isArray(value)) return value.some(references);
        if (value && typeof value === 'object') return (value.sessionId === sessionId) || Object.values(value).some(references);
        return false;
      };
      await client.query('LOCK TABLE rolling_continuity_cards,rolling_continuity_envelopes,tiddle_entries,tiddle_envelopes IN SHARE ROW EXCLUSIVE MODE');
      derived.rolling_continuity_cards = 0;
      const cards = await client.query('SELECT project,card_id,card_json,legacy_card_json FROM rolling_continuity_cards WHERE agent_id=$1', [agentId]);
      for (const row of cards.rows) if (references(row.card_json) || references(row.legacy_card_json)) {
        derived.rolling_continuity_cards += (await client.query('DELETE FROM rolling_continuity_cards WHERE agent_id=$1 AND project=$2 AND card_id=$3', [agentId,row.project,row.card_id])).rowCount;
      }
      // Conservatively remove matching legacy envelopes and Tiddle aggregates.
      const envelopes = await client.query('SELECT legacy_source,legacy_key,envelope_agent_id,extra_metadata FROM rolling_continuity_envelopes');
      for (const row of envelopes.rows) if ((row.envelope_agent_id === agentId || row.legacy_key.startsWith(`rolling-continuity:${agentId}:`)) && references(row.extra_metadata)) await client.query('DELETE FROM rolling_continuity_envelopes WHERE legacy_source=$1 AND legacy_key=$2',[row.legacy_source,row.legacy_key]);
      derived.tiddle_entries = (await client.query('DELETE FROM tiddle_entries t USING tiddle_envelopes e WHERE t.envelope_id=e.envelope_id AND e.agent_id=$1 AND t.source_sessions @> ARRAY[$2]::text[]',[agentId,sessionId])).rowCount;
      await client.query('DELETE FROM tiddle_envelopes WHERE agent_id=$1 AND source_sessions @> ARRAY[$2]::text[]',[agentId,sessionId]);
      // Migration quarantine contains verbatim original conversation rows.
      // Erase only authority-owned raw rows; unrelated and derived stores are
      // deliberately outside this narrow source-erasure boundary.
      derived.legacy_timestamp_values = (await client.query(`DELETE FROM legacy_timestamp_values
        WHERE table_name = ANY($3::text[])
          AND row_identity->>'agent_id'=$1 AND row_identity->>'session_id'=$2`,
        [agentId, sessionId, ['conversation_sessions', 'conversation_entries', 'conversation_archives', 'conversation_archive_entries', 'conversation_original_rows']])).rowCount;
      // Generated DreamMemory bullets carry citations; remove solely dependent
      // bullets, retain independently cited or citation-free human text.
      const profiles = await client.query("SELECT markdown FROM agent_profile_documents WHERE agent_id=$1 AND kind='DREAM_MEMORY' FOR UPDATE",[agentId]);
      if (profiles.rows[0]) {
        const original=profiles.rows[0].markdown;
        const cleaned=original.split('\n').filter(line=>{
          const refs=line.match(/session:[^\s,]+/g) || [];
          return !refs.length || !refs.some(ref=>ref.startsWith(prefix)) || refs.some(ref=>!ref.startsWith(prefix));
        }).join('\n');
        if(cleaned!==original) await client.query("UPDATE agent_profile_documents SET markdown=$2,updated_at=now() WHERE agent_id=$1 AND kind='DREAM_MEMORY'",[agentId,cleaned]);
      }
      // Preference signals are derived evidence, not operator-authored guidance.
      const signalKey=`preference-signals:${agentId}`;
      const signalRows=await client.query('SELECT value_json::text AS value FROM settings_meta WHERE key=$1 FOR UPDATE',[signalKey]);
      if(signalRows.rows[0]) {
        const value=JSON.parse(signalRows.rows[0].value);
        value.signals=(value.signals || []).filter(signal=>!references(signal.sourceRefs));
        await client.query('UPDATE settings_meta SET value_json=$2::json,updated_at=now() WHERE key=$1',[signalKey,JSON.stringify(value)]);
      }
      const conversation = (await client.query('DELETE FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2', [agentId, sessionId])).rowCount;
      return { agentId, sessionId, deleted: conversation === 1, removed: { evidence, knowledge, revisions, ...derived } };
    });
  }
  async history(input) {
    if (!this.searchHistory) throw new Error('albdruck_history_unavailable');
    return this.searchHistory(input);
  }
  async readRetention() {
    const { rows } = await this.pool.query("SELECT policy FROM albdruck_retention WHERE owner_id='default'");
    return { ...DEFAULT_ALBDRUCK_RETENTION, ...rows[0]?.policy };
  }
  async saveRetention(input) {
    return withPostgresTransaction(this.pool, async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('albdruck-retention'))");
      const { rows } = await client.query("SELECT policy FROM albdruck_retention WHERE owner_id='default'");
      const policy = { ...DEFAULT_ALBDRUCK_RETENTION, ...rows[0]?.policy, ...input };
      for (const key of Object.keys(policy)) if (!Object.hasOwn(DEFAULT_ALBDRUCK_RETENTION, key) || (policy[key] !== null && (!Number.isInteger(policy[key]) || policy[key] < 1))) throw new Error('albdruck_retention_invalid');
      await client.query("INSERT INTO albdruck_retention(owner_id,policy) VALUES('default',$1) ON CONFLICT(owner_id) DO UPDATE SET policy=excluded.policy", [policy]);
      return policy;
    });
  }
  async prune() {
    const policy = await this.readRetention();
    return withPostgresTransaction(this.pool, async client => {
      const removed = {};
      if (policy.evidenceDays !== null) removed.evidence = (await client.query("UPDATE albdruck_evidence SET excerpt='' WHERE created_at < now()-($1 * interval '1 day') AND excerpt<>''", [policy.evidenceDays])).rowCount;
      if (policy.revisionDays !== null) removed.revisions = (await client.query("DELETE FROM albdruck_revisions WHERE created_at < now()-($1 * interval '1 day')", [policy.revisionDays])).rowCount;
      if (policy.knowledgeDays !== null) removed.knowledge = (await client.query("DELETE FROM albdruck_knowledge WHERE updated_at < now()-($1 * interval '1 day')", [policy.knowledgeDays])).rowCount;
      return removed;
    });
  }
  async recall({ agentId, query, pageSize = Math.min(50, this.maxPageSize), scope = 'agent' }) {
    if (typeof query !== 'string' || !query.trim()) return { items: [], nextCursor: null };
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > this.maxPageSize) throw new Error('albdruck_page_size_invalid');
    // PostgreSQL English lexemes remove stopwords and rank whole terms, not
    // accidental substrings or JSON field names. OR preserves partial recall.
    const { rows } = await this.pool.query(`WITH lexemes AS (
      SELECT unnest(tsvector_to_array(to_tsvector('english', $2))) AS term
    ), search AS (
      SELECT to_tsquery('english', string_agg(quote_literal(term), ' | ')) AS query FROM lexemes
    ), ranked AS (
      SELECT k.*, setweight(to_tsvector('english', coalesce(document->>'claim','')), 'A') ||
        setweight(to_tsvector('english', coalesce(document->>'rationale','') || ' ' ||
          coalesce(document->>'alternatives','') || ' ' || coalesce(document->>'constraints','') || ' ' ||
          coalesce(document->>'relationships','')), 'B') AS vector
      FROM albdruck_knowledge k WHERE scope=$1 AND state='active'
    ) SELECT ranked.*, ts_rank_cd(vector, search.query) AS score
      FROM ranked CROSS JOIN search WHERE vector @@ search.query
      ORDER BY score DESC, updated_at DESC, id LIMIT $3`, [scopeKey({agentId,scope}), query.trim(), pageSize]);
    const items = [];
    for (const row of rows) {
      const detail = await this.detail({ id: row.id, agentId, scope });
      if (detail?.state === 'active') items.push({ ...row, evidence: detail.evidence.map(({sourceRef,status}) => ({sourceRef,status})) });
    }
    return { items, nextCursor: null };
  }
  async reinforce(input) {
    const document = normalizeKnowledge(input.document);
    const scope = scopeKey(input);
    const proposal = input.reconciliation;
    if (proposal && (!['new','reinforce','supersede','contradiction'].includes(proposal.action) || typeof proposal.reason !== 'string' || !proposal.reason.trim())) throw new Error('albdruck_reconciliation_invalid');
    if (proposal && proposal.action !== 'new' && (!proposal.targetId || !proposal.expectedFingerprint)) throw new Error('albdruck_reconciliation_target_required');
    if (!Array.isArray(input.sourceRefs) || !input.sourceRefs.length) throw new Error('albdruck_evidence_required');
    const evidence = [];
    for (const source of input.sourceRefs) {
      const ref = validateOriginalRef(source);
      if (input.scope !== 'global' && ref.agentId !== String(input.agentId)) throw new Error('albdruck_evidence_scope_mismatch');
      const entry = await this.resolveOriginal(ref);
      if (!isChatMessage(entry) || typeof entry.content !== 'string') throw new Error('albdruck_original_evidence_unavailable');
      if (input.expectedOriginals) {
        const expected = input.expectedOriginals.find(item => JSON.stringify(canonical(item.ref)) === JSON.stringify(canonical(ref)));
        if (!expected || expected.content !== entry.content || expected.role !== entry.role) throw new Error('albdruck_original_evidence_changed');
      }
      evidence.push({ ref, key: JSON.stringify(canonical(ref)), excerpt: entry.content, role: entry.role });
    }
    return withPostgresTransaction(this.pool, async client => {
      await client.query('LOCK TABLE albdruck_knowledge, albdruck_evidence, albdruck_revisions IN SHARE ROW EXCLUSIVE MODE');
      for (const item of evidence) {
        const current = await this.resolveOriginal(item.ref, client);
        if (!isChatMessage(current) || current.content !== item.excerpt || current.role !== item.role) throw new Error('albdruck_original_evidence_changed');
      }
      let target = null;
      if (proposal && proposal.action !== 'new') {
        const result = await client.query('SELECT * FROM albdruck_knowledge WHERE id=$1 AND scope=$2 FOR UPDATE', [proposal.targetId, scope]);
        target = result.rows[0];
        if (!target || target.state !== 'active' || target.fingerprint !== proposal.expectedFingerprint) throw new Error('albdruck_reconciliation_stale_target');
        if (proposal.action === 'supersede' && !evidence.some(item => item.role === 'user')) throw new Error('albdruck_correction_user_evidence_required');
      }
      const fingerprint = proposal?.action === 'reinforce' ? target.fingerprint : knowledgeFingerprint(document);
      if (proposal?.action !== 'reinforce') await client.query(`INSERT INTO albdruck_knowledge(id,scope,fingerprint,document) VALUES($1,$2,$3,$4) ON CONFLICT(scope,fingerprint) DO NOTHING`, [randomUUID(), scope, fingerprint, document]);
      const { rows: [row] } = await client.query('SELECT * FROM albdruck_knowledge WHERE scope=$1 AND fingerprint=$2 FOR UPDATE', [scope, fingerprint]);
      if (row.state !== 'active') throw new Error('albdruck_inactive_requires_review');
      let added = 0;
      for (const item of evidence) {
        const result = await client.query(`INSERT INTO albdruck_evidence(knowledge_id,evidence_key,source_ref,excerpt) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING evidence_key`, [row.id, item.key, item.ref, item.excerpt]);
        added += result.rows.length;
      }
      if (added) {
        await client.query('UPDATE albdruck_knowledge SET updated_at=now() WHERE id=$1', [row.id]);
        await client.query(`INSERT INTO albdruck_revisions(knowledge_id,operation,document) VALUES($1,'reinforce',$2)`, [row.id, { document: row.document, observedDocument: document, reason: proposal?.reason ?? null, addedEvidence: added }]);
      }
      const superseded = [];
      if (proposal?.action === 'supersede') {
        const link = { reason: proposal.reason, before: target.document, after: document,
          supersededId: target.id, replacementId: row.id, sourceRefs: evidence.map(item => item.ref) };
        if (row.id === target.id) throw new Error('albdruck_self_supersession');
        await client.query("UPDATE albdruck_knowledge SET state='superseded',updated_at=now() WHERE id=$1", [target.id]);
        await client.query("INSERT INTO albdruck_revisions(knowledge_id,operation,document) VALUES($1,'supersede',$2),($3,'replace',$2)", [target.id, link, row.id]);
        superseded.push(target.id);
      }
      if (proposal?.action === 'contradiction') {
        const link = { reason: proposal.reason, conflictingId: target.id, candidateId: row.id, sourceRefs: evidence.map(item => item.ref) };
        await client.query("INSERT INTO albdruck_revisions(knowledge_id,operation,document) VALUES($1,'unresolved_contradiction',$2),($3,'unresolved_contradiction',$2)", [target.id, link, row.id]);
      }
      return { id: row.id, addedEvidence: added, changed: added > 0 || superseded.length > 0, superseded };
    });
  }
  async list({ agentId, scope = 'agent', query = '', cursor = '', pageSize = Math.min(50, this.maxPageSize), state = 'active' } = {}) {
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > this.maxPageSize) throw new Error('albdruck_page_size_invalid');
    if (!['active','superseded','deleted'].includes(state)) throw new Error('albdruck_state_invalid');
    const { rows } = await this.pool.query(`SELECT * FROM albdruck_knowledge WHERE scope=$1 AND state=$5 AND id>$2 AND ($3='' OR strpos(lower(document::text),lower($3))>0) ORDER BY id LIMIT $4`, [scopeKey({agentId,scope}), cursor, String(query), pageSize + 1, state]);
    const hasMore = rows.length > pageSize;
    const items = rows.slice(0,pageSize);
    return { items, nextCursor: hasMore ? items.at(-1).id : null };
  }
  async detail({ id, agentId, scope = 'agent', resolveOriginal = this.resolveOriginal }) {
    const { rows: [record] } = await this.pool.query('SELECT * FROM albdruck_knowledge WHERE id=$1 AND scope=$2', [id, scopeKey({agentId,scope})]);
    if (!record) return null;
    const { rows: sources } = await this.pool.query('SELECT source_ref,excerpt FROM albdruck_evidence WHERE knowledge_id=$1 ORDER BY evidence_key', [id]);
    const evidence = [];
    for (const source of sources) {
      const original = await resolveOriginal(source.source_ref);
      evidence.push({ sourceRef: source.source_ref, status: original ? 'live_original' : source.excerpt ? 'preserved_excerpt' : 'unavailable', content: original?.content ?? (source.excerpt || null) });
    }
    const { rows: revisions } = await this.pool.query('SELECT * FROM albdruck_revisions WHERE knowledge_id=$1 ORDER BY id', [id]);
    return { ...record, evidence, revisions };
  }
  async review({ id, agentId, scope = 'agent', operation, reason, document }) {
    if (!['correct','supersede','delete'].includes(operation) || typeof reason !== 'string' || !reason.trim()) throw new Error('albdruck_review_invalid');
    const replacement = operation === 'correct' ? normalizeKnowledge(document) : null;
    return withPostgresTransaction(this.pool, async client => {
      const { rows: [row] } = await client.query('SELECT * FROM albdruck_knowledge WHERE id=$1 AND scope=$2 FOR UPDATE', [id, scopeKey({agentId,scope})]);
      if (!row) return null;
      if (row.state !== 'active') throw new Error('albdruck_inactive_requires_review');
      await client.query('INSERT INTO albdruck_revisions(knowledge_id,operation,document) VALUES($1,$2,$3)', [id, operation, { reason, before: row.document, after: replacement }]);
      if (replacement) await client.query('UPDATE albdruck_knowledge SET document=$2,fingerprint=$3,updated_at=now() WHERE id=$1', [id,replacement,knowledgeFingerprint(replacement)]);
      else await client.query('UPDATE albdruck_knowledge SET state=$2,updated_at=now() WHERE id=$1', [id,operation === 'delete' ? 'deleted' : 'superseded']);
      return { id, operation };
    });
  }
}
