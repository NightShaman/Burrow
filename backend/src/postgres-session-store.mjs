import { PostgresSessionReadStore, sessionReadQuery } from './postgres-session-read.mjs';
import { text, required, cursorValue, limitValue, rowEntry, proofRunKey } from './postgres-session-values.mjs';
import { withArchiveRead } from './postgres-archive-read.mjs';
import { archivePayloadKeySQL } from './postgres-archive-lexical.mjs';
import { searchRecallCandidates, recallNeighbors } from './postgres-session-retrieval.mjs';
import { projectPendingActions } from './session-entry.mjs';
import { fenceChatInputsForReset } from './postgres-chat-input-store.mjs';
import { matchCompactionOccurrences, COMPACTION_COPY_BATCH_SIZE } from './postgres-compaction.mjs';
import { readArchiveTranscriptPage } from './postgres-archive-page.mjs';
import { retentionSessionCandidate } from './retention.mjs';
import { normalizePostgresPool } from './postgres-foundation.mjs';
import { PostgresAgentDeliveryStore } from './postgres-agent-delivery-store.mjs';
import { closeContinuityOwners } from './postgres-continuity-owner.mjs';
import { randomUUID } from 'node:crypto';
import { closePostgresPool, withPostgresTransaction, migrationLockKey } from './postgres-foundation.mjs';

// Caller holds the session row lock: append, compact and delivery share one boundary.
export async function findSessionReplay(client, agentId, sessionId, entryId, key) {
  const { rows } = await client.query(`SELECT sequence,entry FROM (
      SELECT sequence,entry,entry_id,idempotency_key,0 AS priority,0::bigint AS generation FROM conversation_entries WHERE agent_id=$1 AND session_id=$2
      UNION ALL SELECT ordinal,entry,entry_id,idempotency_key,1,generation FROM conversation_archive_entries
      WHERE agent_id=$1 AND session_id=$2 AND archive_kind='compacted'
        AND generation >= COALESCE((SELECT (metadata->>'resetGeneration')::bigint FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2),0)
    ) r
    WHERE (entry_id=$3 OR ($4::text IS NOT NULL AND idempotency_key=$4))
    ORDER BY priority,generation DESC,sequence LIMIT 1`,
    [agentId, sessionId, entryId, key]);
  return rows[0] || null;
}

import { POSTGRES_SESSION_FULL_SCHEMA_SQL } from './postgres-session-schema.mjs';
export { POSTGRES_SESSION_SCHEMA_SQL, POSTGRES_SESSION_ARCHIVE_SCHEMA_SQL, POSTGRES_SESSION_LOSSLESS_JSON_SCHEMA_SQL, POSTGRES_SESSION_OPERATOR_LOOKUP_SCHEMA_SQL, POSTGRES_ARCHIVE_LISTING_INDEX_SQL, POSTGRES_ARCHIVE_RUN_INDEX_SQL, POSTGRES_SESSION_ORIGINAL_LOOKUP_SCHEMA_SQL, POSTGRES_SESSION_ORIGINAL_ROWS_SCHEMA_SQL, POSTGRES_SESSION_SEARCH_SCHEMA_SQL, POSTGRES_SESSION_NATIVE_SCHEMA_SQL, POSTGRES_SESSION_METADATA_SCHEMA_SQL, POSTGRES_SESSION_ASCII_SEARCH_SCHEMA_SQL, POSTGRES_SESSION_FULL_SCHEMA_SQL } from './postgres-session-schema.mjs';

const stamp = () => new Date().toISOString();

export function assertConversationDeletionAllowed(sessionId, metadata = {}) {
  if (['running', 'finalizing'].includes(metadata.continuityHead?.state)) throw new Error('session_retention_active');
  if (metadata.current === true || metadata.currentMain === true || (['main', 'default'].includes(sessionId) && (!metadata.kind || metadata.kind === 'main'))) throw new Error('retention_refused_current_main');
}

/** Staged PostgreSQL authority boundary; callers explicitly own the pool. */
export class PostgresSessionStore {
  constructor({ pool, ownsPool = false, clock = stamp } = {}) {
    if (!pool?.query || !pool?.connect) throw new Error('session_postgres_pool_required');
    this.pool = normalizePostgresPool(pool); this.ownsPool = ownsPool; this.clock = clock; this.proofProjection = null;
  }
  // A separate read owner, never given the facade or its mutation callbacks.
  // Lazy creation also preserves lightweight prototype-based read adapters.
  get archiveReads() { return this.archiveReadStore ||= new PostgresSessionReadStore({ pool: this.pool }); }
  async hasProofProjection(client = this.pool) {
    // Callers already holding a transaction must use that checked-out client.
    // Querying the pool here self-deadlocks when its only connection is the
    // transaction waiting for this capability check to finish.
    // A pending probe belongs to its transaction: sharing it couples unrelated
    // owners' cancellation and can keep a cancelled waiter holding its locks.
    // Only cache a completed boolean; cold callers probe on their own client.
    if (this.proofProjection !== null) return this.proofProjection;
    const result = await client.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='conversation_entries' AND column_name='run_key') AS available`);
    const available = result.rows[0]?.available === true;
    // An older probe must not replace a result already installed by another.
    if (this.proofProjection === null) this.proofProjection = available;
    return available;
  }
  async hasArchiveDateProjection(client = this.pool) { return this.archiveReads.hasArchiveDateProjection(client); }
  get agentDeliveries() { return this.deliveryStore ||= new PostgresAgentDeliveryStore(this.pool); }
  async claimAgentMessageDelivery({ deliveryId, request } = {}) {
    return this.agentDeliveries.claim({ deliveryId: required(deliveryId, 'deliveryId'), request: request && typeof request === 'object' ? request : {} });
  }
  async completeAgentMessageDelivery(args = {}) {
    required(args.deliveryId, 'deliveryId');
    return this.agentDeliveries.complete(args);
  }
  async readAgentMessageDelivery({ deliveryId } = {}) {
    return this.agentDeliveries.read(required(deliveryId, 'deliveryId'));
  }
  async assertAgentMessageDeliveryOwner(args) { return this.agentDeliveries.assertOwner(args); }
  async executeAgentMessageDelivery(args, work) { return this.agentDeliveries.execute(args, work); }

  // Operator-owned display transcripts have no main-session/retention policy.
  // Keep this API structurally scoped: callers cannot choose an agent identity.
  async deleteGroupChannelTranscript({ channelId } = {}) {
    const id = required(channelId, 'channelId');
    const result = await this.pool.query("DELETE FROM conversation_sessions WHERE agent_id='group-channel' AND session_id=$1", [id]);
    return { deleted: result.rowCount === 1 };
  }

  async deleteSession({agentId: rawAgentId, sessionId: rawSessionId, retentionPolicy = null} = {}) {
    const agentId = required(rawAgentId, 'agentId');
    const sessionId = required(rawSessionId, 'sessionId');
    return withPostgresTransaction(this.pool, async client => {
      // Lock the authority row before cascaded deletion; active continuity is
      // never eligible even if a retention plan was built before a new run.
      const selected = await client.query('SELECT metadata,updated_at FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, sessionId]);
      if (!selected.rows.length) return {deleted:false};
      const active = await client.query('SELECT head_state,queue_status FROM continuity_state WHERE agent_id=$1 AND session_id=$2',[agentId,sessionId]);
      if (['running','finalizing'].includes(active.rows[0]?.head_state) || active.rows[0]?.queue_status==='running') throw new Error('session_retention_active');
      assertConversationDeletionAllowed(sessionId, selected.rows[0].metadata);
      const metadata = selected.rows[0].metadata;
      // Retention must re-evaluate age, kind and terminal task ownership under
      // locks, not trust a plan made before a task reopen or metadata edit.
      if (retentionPolicy) {
        const taskStore = { getTask: async taskId => {
          const result = await client.query('SELECT status,metadata_json FROM task_board_tasks WHERE id=$1 FOR UPDATE', [taskId]);
          return result.rows[0] && { status: result.rows[0].status, metadata: result.rows[0].metadata_json };
        } };
        if (!await retentionSessionCandidate({ record: { ...metadata, updatedAt: selected.rows[0].updated_at, id: sessionId }, taskStore, ...retentionPolicy, agentId })) return { deleted: false };
      } else if (metadata.kind === 'task' || (metadata.kind && metadata.kind !== 'main' && !metadata.completedAt)) {
        throw new Error('session_retention_eligibility_required');
      }
      const result = await client.query('DELETE FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2', [agentId, sessionId]);
      return {deleted:result.rowCount === 1};
    });
  }

  async close() { await this.deliveryStore?.close(); await closeContinuityOwners(this.pool); if (this.ownsPool) await closePostgresPool(this.pool); }

  /** Original JSON is decoded in JS: SQL JSON extraction is not lossless for NUL. */
  async history(args = {}) { return this.archiveReads.history(args); }

  // Dream-only raw chronological timeline. No Albdruck search, logical-key
  // authority reconciliation. Legacy Dream suppressed truthy IDs per session;
  // preserve that acquisition-first rule without authority joins. Equal instants
  // retain deterministic session/store/source/ordinal acquisition order.
  async dreamTimeline(args = {}) { return this.archiveReads.dreamTimeline(args); }

  // Shared original-history projection for Dream and conversation context.
  // Live wins over snapshots; snapshot precedence matches resolveOriginal.
  // One stable snapshot, indexed occurrence candidates, bounded transfer batches.
  async dreamWindow(args = {}) { return this.archiveReads.dreamWindow(args); }

  // Resolve each logical ID through the same indexed precedence as resolveOriginal.
  // LATERAL keeps each probe parameterized, not a retained-history scan.
  async listOriginalEntriesById(args = {}) { return this.archiveReads.listOriginalEntriesById(args); }

  async sessionSnapshot({ agentId: rawAgentId, sessionId: rawSessionId, signal } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sessionId = required(rawSessionId, 'sessionId');
    return withPostgresTransaction(this.pool, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const result = await client.query('SELECT metadata,created_at,updated_at FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2', [agentId, sessionId]);
      const row = result.rows[0];
      const metadata = row ? { ...row.metadata, createdAt: row.created_at, updatedAt: row.updated_at } : null;
      const entries = []; let after = '0';
      for (;;) {
        signal?.throwIfAborted();
        const page = await client.query('SELECT sequence,entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 AND sequence>$3::bigint ORDER BY sequence LIMIT 256', [agentId, sessionId, after]);
        entries.push(...page.rows.map(rowEntry));
        if (page.rows.length < 256) break;
        after = String(page.rows.at(-1).sequence);
      }
      signal?.throwIfAborted();
      return { entries, metadata, pendingActions: projectPendingActions(entries) };
    }, { signal });
  }

  async listOriginalEntries(args = {}) { return this.archiveReads.listOriginalEntries(args); }

  async resolveOriginal(args, client = this.pool) { return this.archiveReads.resolveOriginal(args, client); }

  // Caller holds the authority row lock; shared with single append so replay,
  // archive idempotency and run projection remain identical for batch writes.
  async appendLocked(client, { agentId, sid, entry, idempotencyKey, now }) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('session_entry_required');
    const value = { ...entry };
    const entryId = text(value.id).trim() || randomUUID();
    const key = idempotencyKey == null ? (value.metadata?.idempotencyKey || null) : text(idempotencyKey);
    const replay = await findSessionReplay(client, agentId, sid, entryId, key);
    if (replay) return { ...rowEntry(replay), idempotent: true };
    const hasProofProjection = await this.hasProofProjection(client);
    const result = hasProofProjection
      ? await client.query(`INSERT INTO conversation_entries(agent_id,session_id,entry_id,idempotency_key,entry,created_at,run_key) VALUES($1,$2,$3,$4,$5::json,$6,$7) ON CONFLICT DO NOTHING RETURNING sequence,entry`, [agentId, sid, entryId, key, JSON.stringify(value), now, proofRunKey(value)])
      : await client.query(`INSERT INTO conversation_entries(agent_id,session_id,entry_id,idempotency_key,entry,created_at) VALUES($1,$2,$3,$4,$5::json,$6) ON CONFLICT DO NOTHING RETURNING sequence,entry`, [agentId, sid, entryId, key, JSON.stringify(value), now]);
    if (result.rows[0]) {
      await client.query('UPDATE conversation_sessions SET updated_at=$3 WHERE agent_id=$1 AND session_id=$2', [agentId, sid, now]);
      if (hasProofProjection && typeof value.runId === 'string' && value.runId) {
        const at = typeof value.ts === 'string' && value.ts ? value.ts : now;
        const completedAt = value.type === 'message' && value.role === 'assistant' ? at : null;
        await client.query(`INSERT INTO conversation_archive_runs(agent_id,session_id,run_key,run_id,started_at,completed_at,last_activity_at,sort_timestamp)
          VALUES($1,$2,$3,$4,$5::timestamptz,$6::timestamptz,$5::timestamptz,COALESCE($6,$5))
          ON CONFLICT(agent_id,session_id,run_key) DO UPDATE SET run_id=EXCLUDED.run_id,
            started_at=LEAST(conversation_archive_runs.started_at,EXCLUDED.started_at),
            completed_at=COALESCE(GREATEST(conversation_archive_runs.completed_at,EXCLUDED.completed_at),conversation_archive_runs.completed_at,EXCLUDED.completed_at),
            last_activity_at=GREATEST(conversation_archive_runs.last_activity_at,EXCLUDED.last_activity_at),
            sort_timestamp=COALESCE(GREATEST(conversation_archive_runs.completed_at,EXCLUDED.completed_at)::text,LEAST(conversation_archive_runs.started_at,EXCLUDED.started_at)::text,'')`,
        [agentId, sid, proofRunKey(value), value.runId, at, completedAt]);
      }
      return { ...rowEntry(result.rows[0]), idempotent: false };
    }
    const existing = await client.query(`SELECT sequence,entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 AND (entry_id=$3 OR ($4::text IS NOT NULL AND idempotency_key=$4::text)) ORDER BY sequence LIMIT 1`, [agentId, sid, entryId, key]);
    if (!existing.rows[0]) throw new Error('session_entry_conflict');
    return { ...rowEntry(existing.rows[0]), idempotent: true };

  }

  async append({ agentId: rawAgentId, sessionId: rawSessionId, entry, idempotencyKey = null } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId');
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('session_entry_required');
    const now = this.clock();
    return withPostgresTransaction(this.pool, async client => {
      await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,'{}'::jsonb,$3,$3) ON CONFLICT(agent_id,session_id) DO NOTHING`, [agentId, sid, now]);
      // Row lock serializes appenders before identity allocation, making commit-order paging complete.
      await client.query('SELECT 1 FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, sid]);
      return this.appendLocked(client, { agentId, sid, entry, idempotencyKey, now });
    });
  }

  async appendBatchIfGeneration({ agentId: rawAgentId, sessionId: rawSessionId, expectedGeneration = 0, signal, entries } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId');
    if (!Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) throw new Error('session_generation_invalid');
    if (!Array.isArray(entries)) throw new Error('session_entries_required');
    signal?.throwIfAborted();
    const now = this.clock();
    return withPostgresTransaction(this.pool, async client => {
      await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,'{}'::jsonb,$3,$3) ON CONFLICT(agent_id,session_id) DO NOTHING`, [agentId, sid, now]);
      const session = await client.query('SELECT metadata FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, sid]);
      const currentGeneration = Number(session.rows[0]?.metadata?.generation || 0);
      if (currentGeneration !== expectedGeneration) throw new Error('session_generation_stale');
      const results = [];
      for (const item of entries) {
        signal?.throwIfAborted();
        results.push(await this.appendLocked(client, { agentId, sid, entry: item?.entry, idempotencyKey: item?.idempotencyKey, now }));
      }
      signal?.throwIfAborted();
      return results;
    }, { signal });
  }
  async appendIfAbsent(args = {}) { return this.append(args); }

  async read({ agentId: rawAgentId, sessionId: rawSessionId, limit = 20, after = 0 , signal, deadline } = {}) {
    const readQuery = (sql, values) => sessionReadQuery(this.pool, sql, values, { signal, deadline });
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId'); const size = limitValue(limit); const cursor = cursorValue(after);
    const result = await readQuery(`SELECT sequence,entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 AND sequence>$3 ORDER BY sequence LIMIT $4`, [agentId, sid, cursor.toString(), size]);
    return result.rows.map(rowEntry);
  }

  async readMessageTail({ agentId: rawAgentId, sessionId: rawSessionId, limit = 200, before = null } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sessionId = required(rawSessionId, 'sessionId');
    const size = limitValue(limit); let cursor = before == null ? null : cursorValue(before).toString();
    const matches = [];
    while (matches.length <= size) {
      const { rows } = await this.pool.query(`SELECT sequence,entry FROM conversation_entries
        WHERE agent_id=$1 AND session_id=$2 AND ($3::bigint IS NULL OR sequence<$3::bigint)
        ORDER BY sequence DESC LIMIT $4`, [agentId, sessionId, cursor, 256]);
      for (const row of rows) {
        if (row.entry.type === 'message') matches.push(rowEntry(row));
        if (matches.length > size) break;
      }
      if (matches.length > size || rows.length < 256) break;
      cursor = String(rows.at(-1).sequence);
    }
    const hasMore = matches.length > size;
    const entries = matches.slice(0, size).reverse();
    return { entries, olderCursor: hasMore ? String(entries[0].sequence) : null };
  }

  async projection({ agentId, sessionId, visibility, limit, predicate = null, transactionClient = null, indexedVisibility = false }) {
    // Display reads use the existing conservative GIN candidate projection, then
    // compare the visibility scalar before hydrating matching entries.
    // Validate before native extraction: unrelated NUL/surrogate escapes or
    // JSONB-incompatible numbers must use the lossless lexical fallback. Both
    // paths preserve escaped keys/values and JS's last-member semantics. NULL
    // grams stay eligible. Normal payloads avoid a PL/pgSQL scan of every body.
    // Keep the older generic path for callers on pre-Archive schemas.
    const aid = required(agentId, 'agentId'); const sid = required(sessionId, 'sessionId');
    const grams = indexedVisibility ? [...new Set(Array.from({ length: visibility.length - 2 }, (_, i) => visibility.slice(i, i + 3)))] : null;
    const candidate = indexedVisibility ? `AND (search_grams IS NULL OR search_grams @> $5::text[])
        AND CASE WHEN search_grams IS NULL OR search_grams @> $5::text[] THEN
          CASE WHEN pg_input_is_valid(entry::text,'jsonb') THEN entry::jsonb->'visibility'=to_jsonb($6::text)
            ELSE burrow_history_key((burrow_json_members(entry,ARRAY['visibility']))[1]::text)=burrow_history_text($6) END
          ELSE false END` : '';
    const size = limitValue(limit); const matches = []; let before = null;
    while (matches.length < size) {
      const result = await (transactionClient || this.pool).query(`SELECT sequence,entry FROM conversation_entries
        WHERE agent_id=$1 AND session_id=$2 AND ($3::bigint IS NULL OR sequence<$3::bigint)
        ${candidate}
        ORDER BY sequence DESC LIMIT $4`, [aid, sid, before, 256, ...(indexedVisibility ? [grams, visibility] : [])]);
      for (const row of result.rows) {
        if (row.entry.visibility === visibility && (!predicate || predicate(row.entry))) matches.push(rowEntry(row));
        if (matches.length === size) break;
      }
      if (result.rows.length < 256) break;
      before = String(result.rows.at(-1).sequence);
    }
    return matches.reverse();
  }

  async page(args = {}) {
    const size = limitValue(args.limit); const cursor = cursorValue(args.after); const agentId = required(args.agentId, 'agentId'); const sid = required(args.sessionId, 'sessionId');
    const result = await sessionReadQuery(this.pool, `SELECT sequence,entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 AND sequence>$3 ORDER BY sequence LIMIT $4`, [agentId, sid, cursor.toString(), size + 1], args);
    const hasMore = result.rows.length > size; const rows = hasMore ? result.rows.slice(0, size) : result.rows;
    return { entries: rows.map(rowEntry), next: hasMore ? String(rows.at(-1).sequence) : null, hasMore };
  }

  async searchRecallCandidates(args = {}) { return searchRecallCandidates(this.pool, args); }
  async recallNeighbors(args = {}) { return recallNeighbors(this.pool, args); }

  // Indexed candidate pages; final query/ranking/filter semantics stay in JS.
  async searchEvidencePage(args = {}) { return this.archiveReads.searchEvidencePage(args); }

  async lastOperatorMessageAt(args = {}) { return this.archiveReads.lastOperatorMessageAt(args); }

  async listSessions({ agentId: rawAgentId, includeArchived = true , signal, deadline } = {}) {
    const readQuery = (sql, values) => sessionReadQuery(this.pool, sql, values, { signal, deadline });
    const agentId = required(rawAgentId, 'agentId');
    const result = await readQuery(`SELECT session_id,metadata,created_at,updated_at,(SELECT head FROM continuity_state c WHERE c.agent_id=conversation_sessions.agent_id AND c.session_id=conversation_sessions.session_id) AS continuity_head FROM conversation_sessions WHERE agent_id=$1 ${includeArchived ? '' : "AND COALESCE((metadata->>'archived')::boolean,false)=false"} ORDER BY updated_at DESC`, [agentId]);
    return result.rows.map((row) => ({ ...row.metadata, ...(row.continuity_head ? {continuityHead:row.continuity_head} : {}), sessionId: row.session_id, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  // A single statement gives metadata, retained generations and active entries one
  // MVCC snapshot. Reset documents are separate exports, never active history.
  async exportRawEvidence(args = {}) { return this.archiveReads.exportRawEvidence(args); }

  async exportTranscript(args = {}) { return this.archiveReads.exportTranscript(args); }


  // Native Archive detail pages keep retained bodies in PostgreSQL until the
  // bounded canonical page has been selected.
  async readArchiveTranscriptPage(args = {}) { return this.archiveReads.readArchiveTranscriptPage(args); }

  // Page, live projections and metadata must share one reset-generation snapshot.
  async readActiveSessionDisplay(args = {}) {
    return withArchiveRead(this.pool, async transactionClient => {
      const page = await readArchiveTranscriptPage(this.pool, args, transactionClient);
      if (!page || page.archiveSnapshot || args.before) return { page, activity: [], liveChat: [] };
      const activity = await this.projection({ ...args, visibility: 'activity', limit: 20, transactionClient, indexedVisibility: true });
      const liveChat = await this.projection({ ...args, visibility: 'chat', limit: 200, transactionClient, indexedVisibility: true });
      return { page, activity, liveChat };
    }, args);
  }

  // Reconstruct a reset's entire conversation without rewriting immutable
  // evidence. The target's generation window, not today's live metadata, owns
  // its history. One statement gives selection and payloads one MVCC snapshot.
  async exportArchiveTranscript(args = {}) { return this.archiveReads.exportArchiveTranscript(args); }

  async getMetadata({ agentId: rawAgentId, sessionId: rawSessionId, signal, deadline } = {}) {
    const sql = 'SELECT metadata,created_at,updated_at FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2';
    const args = [required(rawAgentId, 'agentId'), required(rawSessionId, 'sessionId')];
    const result = await sessionReadQuery(this.pool, sql, args, { signal, deadline });
    if (!result.rows[0]) return null;
    return { ...result.rows[0].metadata, createdAt: result.rows[0].created_at, updatedAt: result.rows[0].updated_at };
  }

  async writeMetadata({ agentId: rawAgentId, sessionId: rawSessionId, metadata = {} } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId'); const now = this.clock();
    return withPostgresTransaction(this.pool, async (client) => {
      const result = await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,$3::jsonb,$4,$4) ON CONFLICT(agent_id,session_id) DO UPDATE SET metadata=$3::jsonb,updated_at=$4 RETURNING created_at,updated_at`, [agentId, sid, JSON.stringify(metadata), now]);
      return { ...metadata, createdAt: result.rows[0].created_at, updatedAt: result.rows[0].updated_at };
    });
  }

  async updateMetadata({ agentId, sessionId, update } = {}) {
    const aid=required(agentId,'agentId'); const sid=required(sessionId,'sessionId');
    if (typeof update !== 'function') throw new TypeError('metadata_update_required');
    return withPostgresTransaction(this.pool,async client=>{
      const now=this.clock();
      await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,'{}'::jsonb,$3,$3) ON CONFLICT DO NOTHING`,[aid,sid,now]);
      const row=await client.query('SELECT metadata FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE',[aid,sid]);
      const metadata=await update(row.rows[0].metadata);
      await client.query('UPDATE conversation_sessions SET metadata=$3::jsonb,updated_at=$4 WHERE agent_id=$1 AND session_id=$2 AND metadata IS DISTINCT FROM $3::jsonb',[aid,sid,JSON.stringify(metadata),now]);
      return metadata;
    });
  }

  async patchMetadata({ agentId, sessionId, metadata = {} } = {}) {
    const now = this.clock();
    const result = await this.pool.query(`UPDATE conversation_sessions SET metadata=metadata || $3::jsonb,updated_at=$4 WHERE agent_id=$1 AND session_id=$2 RETURNING metadata`, [required(agentId,'agentId'),required(sessionId,'sessionId'),JSON.stringify(metadata),now]);
    return result.rows[0]?.metadata || null;
  }

  async patchArchiveMetadata({ agentId, sessionId, archiveId, metadata = {} } = {}) {
    const result = await this.pool.query(`UPDATE conversation_archives SET metadata=CASE WHEN $4::jsonb ? 'resetGeneration' AND metadata->'resetGeneration' IS DISTINCT FROM $4::jsonb->'resetGeneration' THEN (metadata || $4::jsonb) - 'archiveTranscriptTurnCount' ELSE metadata || $4::jsonb END WHERE agent_id=$1 AND session_id=$2 AND archive_id=$3 RETURNING metadata`, [required(agentId,'agentId'),required(sessionId,'sessionId'),required(archiveId,'archiveId'),JSON.stringify(metadata)]);
    return result.rows[0]?.metadata || null;
  }

  async compact({ agentId: rawAgentId, sessionId: rawSessionId, summary, tailEntries = [], expectedEntries = null, expectedGeneration = null, signal } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId');
    if (!summary || typeof summary !== 'object' || !String(summary.text || '').trim()) throw new Error('session_compaction_summary_required');
    const now = this.clock();
    return withPostgresTransaction(this.pool, async (client) => {
      await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,'{}'::jsonb,$3,$3) ON CONFLICT DO NOTHING`, [agentId, sid, now]);
      const session = await client.query('SELECT metadata FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, sid]);
      const prior = session.rows[0]?.metadata || {};
      const old = await client.query('SELECT sequence,entry,entry_id FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 ORDER BY sequence', [agentId, sid]);
      const currentGeneration = Number(prior.generation || 0);
      if (expectedGeneration !== null && expectedGeneration !== undefined && Number(expectedGeneration) !== currentGeneration) {
        return { stale: true, currentEntries: old.rows.map(rowEntry), metadata: prior };
      }
      if (Array.isArray(expectedEntries)) {
        const expectedIds = expectedEntries.map(entry => String(entry?.id || ''));
        const currentIds = old.rows.map(row => String(row.entry?.id || ''));
        if (expectedIds.length !== currentIds.length || expectedIds.some((id, index) => id !== currentIds[index])) {
          return { stale: true, currentEntries: old.rows.map(rowEntry), metadata: prior };
        }
      }
      const archiveId = old.rows.length ? randomUUID() : null;
      const generation = Number(prior.generation || 0) + 1;
      if (archiveId) await client.query('INSERT INTO conversation_archives(agent_id,session_id,archive_id,generation,kind,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)', [agentId, sid, archiveId, generation - 1, 'compacted', JSON.stringify({ ...prior, compressionSummary: summary }), now]);
      const hasProofProjection = await this.hasProofProjection(client);
      const projections = 'entry_key,search_projection,search_grams,has_payload_id,has_compression_summary,operator_at,operator_ts_fallback,operator_projected';
      const runColumn = hasProofProjection ? ',run_key' : '';
      // Copy originals in bounded ordered ranges, including relational identity and
      // projections. Never reserialize payloads or recompute their candidate index.
      for (let offset = 0; offset < old.rows.length; offset += COMPACTION_COPY_BATCH_SIZE) {
        signal?.throwIfAborted();
        const batch = old.rows.slice(offset, offset + COMPACTION_COPY_BATCH_SIZE);
        await client.query(`INSERT INTO conversation_archive_entries
          (agent_id,session_id,source_store,source_id,ordinal,entry,created_at,archive_kind,generation,entry_id,idempotency_key,${projections}${runColumn})
          SELECT agent_id,session_id,'archive',$3,sequence,entry,created_at,'compacted',$4,entry_id,idempotency_key,${projections}${runColumn}
          FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 AND sequence >= $5::bigint AND sequence <= $6::bigint
          ORDER BY sequence`, [agentId,sid,archiveId,generation-1,String(batch[0].sequence),String(batch.at(-1).sequence)]);
      }
      const retained = Array.isArray(tailEntries) ? tailEntries : [];
      const originals = matchCompactionOccurrences(old.rows, retained, sid);
      await client.query('DELETE FROM conversation_entries WHERE agent_id=$1 AND session_id=$2', [agentId, sid]);
      const summaryEntry = { id: randomUUID(), ts: now, sessionId: sid, type: 'summary', role: null, content: String(summary.text), visibility: 'debug', entersPrompt: false, metadata: { compressionSummary: summary } };
      const insertNew = async entry => {
        const args = [agentId,sid,text(entry.id).trim() || randomUUID(),null,JSON.stringify(entry),now];
        if (hasProofProjection) await client.query('INSERT INTO conversation_entries(agent_id,session_id,entry_id,idempotency_key,entry,created_at,run_key) VALUES($1,$2,$3,$4,$5::json,$6,$7)', [...args,proofRunKey(entry)]);
        else await client.query('INSERT INTO conversation_entries(agent_id,session_id,entry_id,idempotency_key,entry,created_at) VALUES($1,$2,$3,$4,$5::json,$6)', args);
      };
      await insertNew(summaryEntry);
      for (let offset = 0; offset < retained.length;) {
        signal?.throwIfAborted();
        if (!originals[offset]) {
          await insertNew(retained[offset++]);
          continue;
        }
        // Consecutive matched occurrences share one copy. WITH ORDINALITY keeps
        // arbitrary caller order, and omitted sequence allocates fresh cursors.
        const ordinals = [];
        while (offset < retained.length && originals[offset] && ordinals.length < COMPACTION_COPY_BATCH_SIZE) {
          ordinals.push(String(originals[offset++].sequence));
        }
        await client.query(`INSERT INTO conversation_entries
          (agent_id,session_id,entry_id,idempotency_key,entry,created_at,${projections}${runColumn})
          SELECT e.agent_id,e.session_id,e.entry_id,e.idempotency_key,e.entry,$5,${projections.split(',').map(column => `e.${column}`).join(',')}${hasProofProjection ? ',e.run_key' : ''}
          FROM unnest($4::bigint[]) WITH ORDINALITY AS retained(ordinal,position)
          JOIN conversation_archive_entries e ON e.agent_id=$1 AND e.session_id=$2 AND e.source_store='archive' AND e.source_id=$3 AND e.ordinal=retained.ordinal
          ORDER BY retained.position`, [agentId,sid,archiveId,ordinals,now]);
      }
      const next = { ...prior, generation, archived: false, transcriptGeneration: randomUUID(), activeTranscript: 'postgres', archiveId, updatedAt: now, turnCount: 1 + retained.length, chatTurnCount: retained.filter((entry) => entry.type === 'message' && ['user','assistant','agent'].includes(entry.role)).length };
      await client.query('UPDATE conversation_sessions SET metadata=$3::jsonb,updated_at=$4 WHERE agent_id=$1 AND session_id=$2', [agentId, sid, JSON.stringify(next), now]);
      return { archiveId, generation, summaryEntry, retainedCount: retained.length, metadata: next };
    }, { signal });
  }

  // The named history row is the cross-process family lock. Reservations are
  // durable even before a continuity head exists; an unfinished exchange is not
  // inferred closed merely because its most recent reply returned.
  async prepareA2AHistory({ agentId, sessionId, executionSessionId, sourceAgentId, sourceSessionId, sourceRunId }) {
    if (sessionId === 'default') throw new Error('context_boundary_named_session_required');
    await this.updateMetadata({ agentId, sessionId: executionSessionId, update: metadata => ({
      ...metadata, contextIsolation: { ...metadata.contextIsolation, historySessionId: sessionId },
      a2aExchange: metadata.a2aExchange || { state: 'open', sourceAgentId, sourceSessionId, sourceRunId },
    }) });
    return this.reset({ agentId, sessionId, freshExecutionSessionId: executionSessionId, a2aReservation: true });
  }

  async reset({ agentId: rawAgentId, sessionId: rawSessionId, metadata = {}, operationId = null, freshExecutionSessionId = null, a2aReservation = false } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId'); const now = this.clock();
    return withPostgresTransaction(this.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [migrationLockKey(`burrow-session-boundary:${JSON.stringify([agentId,sid])}`)]);
      await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,'{}'::jsonb,$3,$3) ON CONFLICT DO NOTHING`, [agentId, sid, now]);
      const session = await client.query('SELECT metadata FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, sid]);
      const prior = session.rows[0]?.metadata || {};
      if (freshExecutionSessionId) {
        if (sid === 'default') throw new Error('context_boundary_named_session_required');
        const execution = await client.query('SELECT metadata FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, freshExecutionSessionId]);
        const executionMetadata = execution.rows[0]?.metadata;
        if (executionMetadata?.contextIsolation?.historySessionId !== sid) throw new Error('context_history_reset_execution_required');
        // Durable per-execution receipt: retrying any older run must not erase
        // its own projected turns (or a newer run's visible history).
        if (executionMetadata.contextIsolation.historyReset) return { ok: true, replay: true };
        if (a2aReservation) {
          const open = await client.query(`SELECT s.session_id FROM conversation_sessions s
            WHERE s.agent_id=$1 AND s.session_id<>$3 AND s.metadata->'contextIsolation'->>'historySessionId'=$2
            AND s.metadata->'a2aExchange'->>'state'='open'
            AND NOT EXISTS (SELECT 1 FROM continuity_log parent
              WHERE parent.agent_id=s.metadata->'a2aExchange'->>'sourceAgentId'
              AND parent.session_id=s.metadata->'a2aExchange'->>'sourceSessionId'
              AND parent.head->>'runId'=s.metadata->'a2aExchange'->>'sourceRunId'
              AND parent.head->>'state'='completed') LIMIT 1`, [agentId, sid, freshExecutionSessionId]);
          await client.query(`UPDATE conversation_sessions SET metadata=metadata ||
            jsonb_build_object('a2aExchange',metadata->'a2aExchange' || jsonb_build_object('state','open')) WHERE agent_id=$1 AND session_id=$2`, [agentId, freshExecutionSessionId]);
          if (open.rows.length) {
            await client.query(`UPDATE conversation_sessions SET metadata=jsonb_set(metadata,'{contextIsolation,historyReset}','true'::jsonb)
              WHERE agent_id=$1 AND session_id=$2`, [agentId, freshExecutionSessionId]);
            return { ok: true, deferred: true };
          }
        }
        const busy = await client.query(`SELECT s.session_id FROM conversation_sessions s
          LEFT JOIN continuity_state c USING(agent_id,session_id)
          WHERE s.agent_id=$1 AND (s.session_id=$2 OR s.metadata->'contextIsolation'->>'historySessionId'=$2)
          AND (c.head_state IN ('running','finalizing','interrupted') OR c.queue_status IN ('pending','running')
            OR c.manifest->>'status'='interrupted'
            OR (s.metadata->'contextIsolation'->>'historyReset'='true' AND c.head_state IS NULL)) LIMIT 1`, [agentId, sid]);
        if (busy.rows.length) {
          if (!a2aReservation) throw new Error('context_history_reset_busy');
          await client.query(`UPDATE conversation_sessions SET metadata=jsonb_set(metadata,'{contextIsolation,historyReset}','true'::jsonb)
            WHERE agent_id=$1 AND session_id=$2`, [agentId, freshExecutionSessionId]);
          return { ok: true, deferred: true };
        }
        await client.query(`UPDATE conversation_sessions SET metadata=jsonb_set(metadata,'{contextIsolation,historyReset}','true'::jsonb),updated_at=$3
          WHERE agent_id=$1 AND session_id=$2`, [agentId, freshExecutionSessionId, now]);
      }
      // Fence accepted input ownership in the same transaction as archival. A
      // submission racing reset either belongs to this archived generation or
      // the next one; it can never become invisible pending work.
      if ((await client.query("SELECT to_regclass('chat_inputs') AS relation")).rows[0].relation) {
        await fenceChatInputsForReset(client, { agentId, sessionId:sid, generation:Number(prior.resetGeneration || 0), now });
      }
      // Keep the head generation monotonic, but revoke all old ownership and recovery.
      await client.query(`UPDATE continuity_state SET head=(head::jsonb || jsonb_build_object('state','reset','ownerId',NULL))::json,
        head_state='reset',owner_id=NULL,manifest=NULL,queue=NULL,queue_status=NULL,auto_resume=false,queued_at=NULL,updated_at=$3
        WHERE agent_id=$1 AND session_id=$2`, [agentId,sid,now]);
      await client.query(`INSERT INTO continuity_log(agent_id,session_id,head,manifest,queue,created_at)
        SELECT agent_id,session_id,head,manifest,queue,$3 FROM continuity_state WHERE agent_id=$1 AND session_id=$2`, [agentId,sid,now]);
      // Reset needs existence, not 28 MB of JSON transferred to Node and parsed.
      const rows = await client.query('SELECT 1 FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 LIMIT 1', [agentId, sid]);
      const archiveId = rows.rows.length ? randomUUID() : null;
      const generation = Number(prior.generation || 0) + 1;
      // Materialize the reconstructed count once at reset, not on every Archive
      // listing page. This uses the same occurrence identity/window as the legacy
      // listing fallback, including id-less duplicates and compacted overlaps.
      // Canonical counts have the same cold numeric/array coercion branches as
      // Archive discovery. Avoid compiling those branches while holding reset's
      // session lock, and restore this transaction's caller setting afterwards.
      const countJit = archiveId ? (await client.query("SELECT current_setting('jit') AS value")).rows[0].value : null;
      if (archiveId) await client.query('SET LOCAL jit=off');
      const archiveTranscriptTurnCount = archiveId ? Number((await client.query(`
        SELECT count(DISTINCT identity) AS count FROM (
          SELECT COALESCE('payload:' || ${archivePayloadKeySQL('e')},
            'occurrence:' || NULLIF(e.entry_id,''), 'row:' || e.source_id || ':' || e.ordinal::text) AS identity
          FROM conversation_archive_entries e JOIN conversation_archives a
            ON a.agent_id=e.agent_id AND a.session_id=e.session_id AND a.archive_id=e.source_id
          WHERE a.agent_id=$1 AND a.session_id=$2 AND a.kind='compacted'
            AND a.generation<=$3::bigint AND a.generation>=COALESCE($4::bigint,
              (SELECT max(r.generation)+1 FROM conversation_archives r
                WHERE r.agent_id=$1 AND r.session_id=$2 AND r.kind='reset' AND r.generation<$3::bigint),0)
          UNION ALL
          SELECT COALESCE('payload:' || ${archivePayloadKeySQL('e')},
            'occurrence:' || NULLIF(e.entry_id,''), 'row:live:' || e.sequence::text)
          FROM conversation_entries e WHERE e.agent_id=$1 AND e.session_id=$2
        ) occurrences`, [agentId, sid, generation - 1, prior.resetGeneration ?? null])).rows[0].count) : null;
      if (archiveId) await client.query("SELECT set_config('jit',$1,true)", [countJit]);
      if (archiveId) await client.query('INSERT INTO conversation_archives(agent_id,session_id,archive_id,generation,kind,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)', [agentId, sid, archiveId, generation - 1, 'reset', JSON.stringify({ ...prior, ...metadata, sourceSessionId: sid, archivedAt: now, chatTurnCount: null, archiveTranscriptTurnCount }), now]);
      const resetProofColumn = await this.hasProofProjection(client) ? ',run_key' : '';
      // Older direct-schema fixtures do not include the chat projection yet.
      // Production always has v82+, and copies its completed marker verbatim.
      const hasChatProjection = (await client.query(`SELECT EXISTS(SELECT 1 FROM information_schema.columns
        WHERE table_schema=current_schema() AND table_name='conversation_entries' AND column_name='archive_chat_projected') AS available`)).rows[0]?.available === true;
      const projections = 'entry_key,search_projection,search_grams,has_payload_id,has_compression_summary,operator_at,operator_ts_fallback,operator_projected'
        + (hasChatProjection ? ',archive_chat_visible,archive_chat_at,archive_chat_projected' : '');
      if (archiveId) await client.query(`INSERT INTO conversation_archive_entries
        (agent_id,session_id,source_store,source_id,ordinal,entry,created_at,archive_kind,generation,entry_id,idempotency_key,${projections}${resetProofColumn})
        SELECT agent_id,session_id,'archive',$3,sequence,entry,created_at,$4,$5,entry_id,idempotency_key,${projections}${resetProofColumn}
        FROM conversation_entries WHERE agent_id=$1 AND session_id=$2`, [agentId,sid,archiveId,'reset',generation-1]);
      await client.query('DELETE FROM conversation_entries WHERE agent_id=$1 AND session_id=$2', [agentId, sid]);
      const next = { ...prior, ...metadata, generation, resetGeneration: generation, archived: false, resetAt: now, resetOperationId: operationId, archiveId, turnCount: 0, chatTurnCount: 0 };
      await client.query('UPDATE conversation_sessions SET metadata=$3::jsonb,updated_at=$4 WHERE agent_id=$1 AND session_id=$2', [agentId, sid, JSON.stringify(next), now]);
      return { ok: true, agentId, sessionId: sid, archiveId, generation, metadata: { ...next, updatedAt: now } };
    });
  }

  async createEmpty({ agentId: rawAgent, sessionId: rawSession, operationId: rawOperation } = {}) {
    const agentId = required(rawAgent, 'agentId'), sessionId = required(rawSession, 'sessionId');
    const operationId = required(rawOperation, 'operationId'), now = this.clock();
    return withPostgresTransaction(this.pool, async client => {
      const metadata = { creationOperationId: operationId, generation: 0, turnCount: 0, chatTurnCount: 0 };
      const inserted = await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,$3::jsonb,$4,$4) ON CONFLICT DO NOTHING RETURNING session_id`, [agentId,sessionId,JSON.stringify(metadata),now]);
      if (!inserted.rows[0]) {
        const prior = await client.query('SELECT metadata FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId,sessionId]);
        if (prior.rows[0]?.metadata?.creationOperationId !== operationId) throw new Error('session_target_exists');
      }
      // Replay never clears messages sent after creation.
      return { ok: true, agentId, sessionId, operationId };
    });
  }

  async fork({ sourceAgentId = null, targetAgentId = null, agentId = null, sourceSessionId: rawSource, targetSessionId: rawTarget, limit = 200 } = {}) {
    const sourceAgent = required(sourceAgentId || agentId, 'sourceAgentId'); const targetAgent = required(targetAgentId || agentId, 'targetAgentId');
    const source = required(rawSource, 'sourceSessionId'); const target = required(rawTarget, 'targetSessionId'); const size = limitValue(limit); const now = this.clock();
    if (sourceAgent === targetAgent && source === target) throw new Error('fork_source_target_same');
    return withPostgresTransaction(this.pool, async (client) => {
      const sourceSession = await client.query('SELECT 1 FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [sourceAgent, source]);
      if (!sourceSession.rows[0]) throw new Error('fork_source_not_found');
      // Reserve the target atomically. A preliminary existence check races with
      // concurrent forks and the old upsert/delete path could overwrite the winner.
      const reservation = await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,$3::jsonb,$4,$4) ON CONFLICT(agent_id,session_id) DO NOTHING RETURNING session_id`, [targetAgent, target, JSON.stringify({ forkedFrom: source, forkedAt: now, generation: 0 }), now]);
      if (!reservation.rows[0]) throw new Error('fork_target_exists');
      const sourceRows = await client.query('SELECT entry,entry::text AS raw_entry,entry_id FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 ORDER BY sequence DESC LIMIT $3', [sourceAgent, source, size]);
      const sourceEntries = sourceRows.rows.reverse();
      const entries = sourceEntries.map((row) => row.entry);
      const hasProofProjection = await this.hasProofProjection(client);
      for (const row of sourceEntries) {
        const args=[targetAgent,target,row.entry_id || randomUUID(),row.raw_entry,now];
        if (hasProofProjection) await client.query('INSERT INTO conversation_entries(agent_id,session_id,entry_id,entry,created_at,run_key) VALUES($1,$2,$3,$4::json,$5,$6)', [...args,proofRunKey(row.entry)]);
        else await client.query('INSERT INTO conversation_entries(agent_id,session_id,entry_id,entry,created_at) VALUES($1,$2,$3,$4::json,$5)', args);
      }
      return { ok: true, sourceAgentId: sourceAgent, targetAgentId: targetAgent, sourceSessionId: source, targetSessionId: target, copiedEntries: entries.length };
    });
  }

  async rename({ agentId: rawAgentId, sessionId: rawSessionId, targetSessionId: rawTarget } = {}) {
    const agentId = required(rawAgentId, 'agentId');
    const source = required(rawSessionId, 'sessionId');
    const target = required(rawTarget, 'targetSessionId');
    if (source === target) return { ok: true, agentId, sessionId: source, targetSessionId: target };
    return withPostgresTransaction(this.pool, async (client) => {
      const exists = async name => (await client.query('SELECT to_regclass($1) AS relation',[name])).rows[0].relation !== null;
      const sourceRow = await client.query('SELECT metadata,created_at,updated_at FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, source]);
      if (!sourceRow.rows[0]) return null;
      const reserved = await client.query('INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT DO NOTHING RETURNING session_id', [agentId, target, JSON.stringify({ ...sourceRow.rows[0].metadata, sessionId: target }), sourceRow.rows[0].created_at, sourceRow.rows[0].updated_at]);
      if (!reserved.rows[0]) throw new Error('rename_target_exists');
      const hasProofProjection = await this.hasProofProjection(client);
      const runColumn = hasProofProjection ? ',run_key' : '';
      // Owned occurrence payloads and complete mutable projections move together.
      // Copy JSON directly in SQL: parsing/serializing would destroy lexical
      // evidence (duplicate keys, escapes, whitespace and unsafe Unicode).
      const projections = 'entry_key,search_projection,search_grams,has_payload_id,has_compression_summary,operator_at,operator_ts_fallback,operator_projected';
      await client.query(`INSERT INTO conversation_entries(agent_id,session_id,entry_id,idempotency_key,entry,created_at,${projections}${runColumn})
        SELECT agent_id,$3,entry_id,idempotency_key,entry,created_at,${projections}${runColumn}
        FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 ORDER BY sequence`, [agentId, source, target]);
      await client.query(`INSERT INTO conversation_archives(agent_id,session_id,archive_id,generation,kind,metadata,created_at) SELECT agent_id,$3,archive_id,generation,kind,CASE WHEN kind='reset' THEN metadata || jsonb_build_object('sourceSessionId',COALESCE(NULLIF(metadata->>'sourceSessionId',''),session_id)) ELSE metadata END,created_at FROM conversation_archives WHERE agent_id=$1 AND session_id=$2`, [agentId, source, target]);
      await client.query(`INSERT INTO conversation_archive_entries
        (agent_id,session_id,source_store,source_id,ordinal,entry,created_at,archive_kind,generation,entry_id,idempotency_key,${projections}${runColumn})
        SELECT agent_id,$3,source_store,source_id,ordinal,entry,created_at,archive_kind,generation,entry_id,idempotency_key,${projections}${runColumn}
        FROM conversation_archive_entries WHERE agent_id=$1 AND session_id=$2`, [agentId,source,target]);
      // Session metadata's runEvidence trigger may already have inserted a
      // subset. The source directory is authoritative, including runs with no
      // runEvidence and their exact timestamps/sort keys.
      if (hasProofProjection) await client.query(`INSERT INTO conversation_archive_runs
        (agent_id,session_id,run_key,run_id,started_at,completed_at,last_activity_at,sort_timestamp)
        SELECT agent_id,$3,run_key,run_id,started_at,completed_at,last_activity_at,sort_timestamp
        FROM conversation_archive_runs WHERE agent_id=$1 AND session_id=$2
        ON CONFLICT(agent_id,session_id,run_key) DO UPDATE SET run_id=EXCLUDED.run_id,
          started_at=EXCLUDED.started_at,completed_at=EXCLUDED.completed_at,
          last_activity_at=EXCLUDED.last_activity_at,sort_timestamp=EXCLUDED.sort_timestamp`, [agentId,source,target]);
      // Mutable ownership and citations follow the new identity; original JSON
      // entries/archives above remain byte-for-byte lexical evidence.
      if (await exists('chat_inputs')) {
        const running = await client.query("SELECT 1 FROM chat_inputs WHERE agent_id=$1 AND session_id=$2 AND status='running' LIMIT 1",[agentId,source]);
        if (running.rows.length) throw Object.assign(new Error('session_busy_chat_inputs'),{statusCode:409});
        await client.query('UPDATE chat_inputs SET session_id=$3 WHERE agent_id=$1 AND session_id=$2',[agentId,source,target]);
      }
      if (await exists('chat_input_sessions')) await client.query('UPDATE chat_input_sessions SET session_id=$3 WHERE agent_id=$1 AND session_id=$2',[agentId,source,target]);
      if (await exists('conversation_project_bindings')) await client.query('UPDATE conversation_project_bindings SET session_id=$3 WHERE agent_id=$1 AND session_id=$2',[agentId,source,target]);
      if (await exists('working_memory')) await client.query(`UPDATE working_memory SET session_id=$3,conversation_id=CASE WHEN conversation_id=$2 THEN $3 WHEN conversation_id=$1 || ':' || $2 THEN $1 || ':' || $3 ELSE conversation_id END WHERE agent_id=$1 AND session_id=$2`,[agentId,source,target]);
      if (await exists('continuity_handoffs')) {
        const oldId = `continuity:${agentId}:${source}`, newId = `continuity:${agentId}:${target}`;
        // Only the canonical session-derived id changes; arbitrary historical
        // ids stay stable. Never overwrite an existing destination handoff.
        const collision = await client.query(`SELECT 1 FROM continuity_handoffs
          WHERE id=$2 AND EXISTS (SELECT 1 FROM continuity_handoffs WHERE id=$1 AND agent_id=$3 AND session_id=$4)`, [oldId,newId,agentId,source]);
        if (collision.rows[0]) throw new Error('rename_handoff_target_exists');
        await client.query(`UPDATE continuity_handoffs SET session_id=$3,id=CASE WHEN id=$4 THEN $5 ELSE id END
          WHERE agent_id=$1 AND session_id=$2`, [agentId,source,target,oldId,newId]);
      }
      // Steering is a mutable run/input directory with cascading owner FKs.
      // Reserve parents before copying inputs, then source deletion is safe.
      if (await exists('chat_steering_runs')) {
        await client.query(`INSERT INTO chat_steering_runs(agent_id,session_id,run_id,accepting,generation)
          SELECT agent_id,$3,run_id,accepting,generation FROM chat_steering_runs WHERE agent_id=$1 AND session_id=$2`, [agentId,source,target]);
        await client.query(`INSERT INTO chat_steering_inputs
          (agent_id,session_id,run_id,ordinal,input_id,idempotency_key,payload,status,created_at,delivered_at) OVERRIDING SYSTEM VALUE
          SELECT agent_id,$3,run_id,ordinal,input_id,idempotency_key,payload,status,created_at,delivered_at
          FROM chat_steering_inputs WHERE agent_id=$1 AND session_id=$2`, [agentId,source,target]);
      }
      if (await exists('scheduled_jobs')) await client.query('UPDATE scheduled_jobs SET session_id=$3 WHERE agent_id=$1 AND session_id=$2',[agentId,source,target]);
      if (await exists('scheduled_job_runs')) await client.query('UPDATE scheduled_job_runs SET session_id=$3 WHERE agent_id=$1 AND session_id=$2',[agentId,source,target]);
      if (await exists('albdruck_evidence')) await client.query(`UPDATE albdruck_evidence SET source_ref=jsonb_set(source_ref,'{sessionId}',to_jsonb($3::text)) WHERE source_ref->>'agentId'=$1 AND source_ref->>'sessionId'=$2`,[agentId,source,target]);
      const oldRef=`session:${source}:`, newRef=`session:${target}:`;
      for (const table of ['working_memory','continuity_handoffs']) {
        if (!await exists(table)) continue;
        await client.query(`UPDATE ${table} SET source_refs=(SELECT jsonb_agg(CASE WHEN ref.value=$4 THEN $5 WHEN starts_with(ref.value,$2) THEN $3 || substr(ref.value,length($2)+1) ELSE ref.value END ORDER BY ref.ordinality) FROM jsonb_array_elements_text(source_refs) WITH ORDINALITY ref(value,ordinality)) WHERE agent_id=$1 AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(source_refs) ref(value) WHERE ref.value=$4 OR starts_with(ref.value,$2))`,[agentId,oldRef,newRef,`session:${source}`,`session:${target}`]);
      }
      // Only rewrite typed mutable identity fields, never prose or historical
      // lexical originals (archive entries, Tiddle history, legacy card JSON).
      const rewriteIdentity = (value, key = '') => {
        if (typeof value === 'string') {
          if (['sessionId','conversationId'].includes(key) && value === source) return target;
          if (key === 'conversationId' && value === `${agentId}:${source}`) return `${agentId}:${target}`;
          if (['project','scope'].includes(key) && value === `conversation:${source}`) return `conversation:${target}`;
          if (['ref','sourceRef','sourceRefs','recentRefs'].includes(key)) {
            if (value === `session:${source}`) return `session:${target}`;
            if (value.startsWith(oldRef)) return newRef + value.slice(oldRef.length);
          }
          return value;
        }
        if (Array.isArray(value)) return value.map(item => rewriteIdentity(item, key));
        if (value && typeof value === 'object') {
          if (value.agentId && value.agentId !== agentId) return value;
          return Object.fromEntries(Object.entries(value).map(([field,item]) => [field,rewriteIdentity(item,field)]));
        }
        return value;
      };
      const rewriteRows = async (sql, params, update) => {
        for (const row of (await client.query(sql, params)).rows) {
          const next = rewriteIdentity(row.payload);
          if (JSON.stringify(next) !== JSON.stringify(row.payload)) await update(row, JSON.stringify(next));
        }
      };
      // Read residue before settings locks: an in-flight pass may already have
      // captured a run even if it has not yet written a preference signal.
      const residueRefs = [];
      if (await exists('tiddle_envelopes')) {
        const residue = await client.query(`SELECT t.value_json AS payload FROM tiddle_entries t JOIN tiddle_envelopes e USING(envelope_id)
          WHERE e.agent_id=$1 AND e.kind='tiddle-residue' AND t.source_sessions @> ARRAY[$2]::text[]`,[agentId,source]);
        for (const row of residue.rows) if (row.payload?.sessionId === source) residueRefs.push(row.payload.ref);
      }
      if (await exists('settings_meta')) {
        // These are the same sorted locks used by the preference writer and
        // purge, including when a metadata row does not yet exist. Never touch
        // the public PREFERENCES document, or rewrite prose / opaque hashes.
        const signalKey = `preference-signals:${agentId}`;
        const auditKey = `preference-audit:${agentId}`;
        const stateKey = `preference-learning:${agentId}`;
        for (const key of [auditKey,stateKey,signalKey].sort()) {
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`settings-meta:${key}`]);
        }
        const readPreference = async key => {
          const row = (await client.query('SELECT value_json::text AS payload FROM settings_meta WHERE key=$1 FOR UPDATE',[key])).rows[0];
          if (!row) return null;
          let value;
          try { value = JSON.parse(row.payload); } catch { throw new Error('rename_preference_envelope_invalid'); }
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('rename_preference_envelope_invalid');
          return value;
        };
        const audit = await readPreference(auditKey);
        const state = await readPreference(stateKey);
        const envelope = await readPreference(signalKey);
        for (const [value,field] of [[audit,'entries'],[state,'reviewedSignalIds'],[envelope,'signals'],[envelope,'resolvedEvidence'],[envelope,'sessionAliases']]) {
          if (value && Object.hasOwn(value,field) && !Array.isArray(value[field])) throw new Error('rename_preference_envelope_invalid');
        }
        // A source ref is the smallest available rename fence: unlike a bare
        // session alias it does not capture new messages when the old name is
        // reused. Keep every old original, even when no signal existed yet: an
        // extraction already in flight may cite any of them after this commit.
        const oldRefs = new Set();
        // Session names may contain colons; a lexical prefix alone would turn
        // `session:old:child:message:x` into an unrelated renamed citation.
        const preferenceRef = ref => typeof ref === 'string' && (ref === `session:${source}` ||
          ['message:','run:'].some(kind => ref.startsWith(`${oldRef}${kind}`)));
        const rewritePreferenceRef = value => {
          if (Array.isArray(value)) return value.map(rewritePreferenceRef);
          return preferenceRef(value) ? rewriteIdentity(value,'sourceRef') : value;
        };
        const remember = value => {
          if (Array.isArray(value)) { for (const ref of value) remember(ref); return; }
          if (preferenceRef(value)) oldRefs.add(value);
        };
        for (const ref of residueRefs) remember(ref);
        const originals = await client.query('SELECT DISTINCT entry_key,has_payload_id FROM conversation_original_rows WHERE agent_id=$1 AND session_id=$2',[agentId,source]);
        for (const row of originals.rows) {
          try {
            // Dream interpolates the payload id (including undefined/null),
            // rather than the relational fallback for id-less payloads.
            const id = row.has_payload_id ? JSON.parse(row.entry_key) : undefined;
            oldRefs.add(`session:${source}:message:${id}`);
          } catch { throw new Error('rename_preference_source_identity_invalid'); }
        }
        const rewriteItems = (items, evidence = false) => items?.map(item => {
          if (!item || typeof item !== 'object' || Array.isArray(item) || (item.agentId && item.agentId !== agentId)) return item;
          let next = item;
          if (Object.hasOwn(item,'sourceRefs')) {
            remember(item.sourceRefs);
            next = { ...next, sourceRefs: rewritePreferenceRef(item.sourceRefs) };
          }
          if (evidence && Array.isArray(item.evidence)) next = { ...next, evidence: item.evidence.map(entry => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry) || !Object.hasOwn(entry,'sourceRef')) return entry;
            remember(entry.sourceRef);
            return { ...entry, sourceRef: rewritePreferenceRef(entry.sourceRef) };
          }) };
          if (evidence && Array.isArray(item.context)) next = { ...next, context: item.context.map(entry => {
            remember(entry.sourceRef);
            return { ...entry, sourceRef: rewritePreferenceRef(entry.sourceRef) };
          }) };
          return next;
        });
        const nextAudit = audit && { ...audit, ...(audit.entries ? { entries: rewriteItems(audit.entries) } : {}) };
        const signals = rewriteItems(envelope?.signals, true);
        const resolvedEvidence = rewriteItems(envelope?.resolvedEvidence, true);
        // Flatten historical aliases on subsequent renames. If an old message
        // spelling was reused for a different occurrence, its two owners are
        // indistinguishable; fail closed instead of stealing either identity.
        const aliases = new Map();
        const addAlias = (from,to) => {
          if (from === to) return;
          if (aliases.has(from) && aliases.get(from) !== to) throw new Error('rename_preference_source_alias_conflict');
          aliases.set(from,to);
        };
        for (const alias of envelope?.sessionAliases || []) {
          if (!alias || typeof alias !== 'object' || Array.isArray(alias) || typeof alias.sourceRef !== 'string' || typeof alias.targetRef !== 'string') throw new Error('rename_preference_envelope_invalid');
          addAlias(alias.sourceRef,rewritePreferenceRef(alias.targetRef));
        }
        for (const ref of oldRefs) addAlias(ref,rewriteIdentity(ref,'sourceRef'));
        const nextSignals = {
          ...(envelope || { version: 2, agentId, signals: [] }),
          ...(signals ? { signals } : {}),
          ...(resolvedEvidence ? { resolvedEvidence } : {}),
          ...(aliases.size || envelope?.sessionAliases ? { sessionAliases: [...aliases].map(([sourceRef,targetRef]) => ({ sourceRef,targetRef })) } : {}),
        };
        const writePreference = (key,value) => client.query(`INSERT INTO settings_meta(key,value_json,updated_at) VALUES($1,$2,$3)
          ON CONFLICT(key) DO UPDATE SET value_json=EXCLUDED.value_json,updated_at=EXCLUDED.updated_at`,[key,JSON.stringify(value),this.clock()]);
        if (audit && JSON.stringify(audit) !== JSON.stringify(nextAudit)) await writePreference(auditKey,nextAudit);
        if ((envelope || aliases.size) && JSON.stringify(envelope) !== JSON.stringify(nextSignals)) await writePreference(signalKey,nextSignals);
      }
      if (await exists('rolling_continuity_cards')) {
        await rewriteRows('SELECT project,card_id,card_json AS payload FROM rolling_continuity_cards WHERE agent_id=$1 FOR UPDATE',[agentId],
          (row,json) => client.query('UPDATE rolling_continuity_cards SET card_json=$4::json WHERE agent_id=$1 AND project=$2 AND card_id=$3',[agentId,row.project,row.card_id,json]));
        await client.query('UPDATE rolling_continuity_cards SET project=$3 WHERE agent_id=$1 AND project=$2',[agentId,`conversation:${source}`,`conversation:${target}`]);
      }
      if (await exists('tiddle_envelopes')) {
        await rewriteRows("SELECT envelope_id,value_json AS payload FROM tiddle_envelopes WHERE agent_id=$1 AND kind <> 'tiddle-history' FOR UPDATE",[agentId],
          (row,json) => client.query('UPDATE tiddle_envelopes SET value_json=$2::json WHERE envelope_id=$1',[row.envelope_id,json]));
        await rewriteRows("SELECT t.id,t.value_json AS payload FROM tiddle_entries t JOIN tiddle_envelopes e USING(envelope_id) WHERE e.agent_id=$1 AND e.kind='tiddle-residue' FOR UPDATE OF t",[agentId],
          (row,json) => client.query("UPDATE tiddle_entries SET value_json=$2::json,ref=$2::json->>'ref' WHERE id=$1",[row.id,json]));
        await client.query("UPDATE tiddle_envelopes SET scope=$3 WHERE agent_id=$1 AND kind='tiddle-pass-scope' AND scope=$2",[agentId,`conversation:${source}`,`conversation:${target}`]);
      }
      if (await exists('task_board_tasks')) {
        for (const column of ['metadata_json','execution_json']) {
          await rewriteRows(`SELECT id,${column} AS payload FROM task_board_tasks WHERE COALESCE(${column}->>'agentId',assigned_agent_id)=$1 FOR UPDATE`,[agentId],
            (row,json) => client.query(`UPDATE task_board_tasks SET ${column}=$2::jsonb WHERE id=$1`,[row.id,json]));
        }
      }
      for (const column of ['head','manifest','queue']) {
        await rewriteRows(`SELECT session_id,${column} AS payload FROM continuity_state WHERE agent_id=$1 AND session_id=$2 FOR UPDATE`,[agentId,source],
          (row,json) => client.query(`UPDATE continuity_state SET ${column}=$3::json WHERE agent_id=$1 AND session_id=$2`,[agentId,row.session_id,json]));
      }
      await client.query('UPDATE continuity_state SET session_id=$3 WHERE agent_id=$1 AND session_id=$2',[agentId,source,target]);
      await client.query('UPDATE continuity_log SET session_id=$3 WHERE agent_id=$1 AND session_id=$2',[agentId,source,target]);
      await client.query('DELETE FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2', [agentId, source]);
      return { ok: true, agentId, sessionId: source, targetSessionId: target };
    });
  }

  async archive({ agentId: rawAgentId, sessionId: rawSessionId, archived = true } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId'); const now = this.clock();
    return withPostgresTransaction(this.pool, async (client) => {
      const result = await client.query('UPDATE conversation_sessions SET metadata=jsonb_set(metadata, ARRAY[\'archived\'], $3::jsonb, true),updated_at=$4 WHERE agent_id=$1 AND session_id=$2 RETURNING metadata,created_at,updated_at', [agentId, sid, JSON.stringify(Boolean(archived)), now]);
      if (!result.rows[0]) return null;
      return { ok: true, agentId, sessionId: sid, archived: Boolean(archived), metadata: { ...result.rows[0].metadata, createdAt: result.rows[0].created_at, updatedAt: result.rows[0].updated_at } };
    });
  }

  async listArchiveRunDirectory(args = {}) { return this.archiveReads.listArchiveRunDirectory(args); }

  async readArchiveRunSources(args = {}) { return this.archiveReads.readArchiveRunSources(args); }

  async readArchiveRunSource(args = {}) { return this.archiveReads.readArchiveRunSource(args); }

  async listArchiveSessions(args = {}) { return this.archiveReads.listArchiveSessions(args); }

  async listArchiveCalendarDates(args = {}) { return this.archiveReads.listArchiveCalendarDates(args); }

  async listArchives(args = {}) { return this.archiveReads.listArchives(args); }

  async readArchiveById(args = {}) { return this.archiveReads.readArchiveById(args); }

  async readArchive(args = {}) { return this.archiveReads.readArchive(args); }
}

export const SESSION_SCHEMA_SQL = POSTGRES_SESSION_FULL_SCHEMA_SQL;
