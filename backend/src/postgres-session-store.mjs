import { resolveAlbdruckConfig } from './config.mjs';
import { matchesQuery } from './session-search.mjs';
import { closeContinuityOwners } from './postgres-continuity-owner.mjs';
import { randomUUID } from 'node:crypto';
import { closePostgresPool, withPostgresTransaction } from './postgres-foundation.mjs';

export const POSTGRES_SESSION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS conversation_sessions (
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, session_id)
);
CREATE TABLE IF NOT EXISTS conversation_entries (
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  sequence BIGINT GENERATED ALWAYS AS IDENTITY,
  entry_id TEXT NOT NULL,
  idempotency_key TEXT,
  entry JSONB NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, session_id, sequence),
  UNIQUE (agent_id, session_id, entry_id),
  UNIQUE (agent_id, session_id, idempotency_key),
  FOREIGN KEY (agent_id, session_id) REFERENCES conversation_sessions(agent_id, session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS conversation_entries_session_order_idx ON conversation_entries(agent_id, session_id, sequence);

`;

export const POSTGRES_SESSION_ARCHIVE_SCHEMA_SQL = `
-- Additive authority structures. Archives are immutable generation snapshots;
-- metadata remains scoped by agent so identical session ids cannot cross agents.
CREATE TABLE IF NOT EXISTS conversation_archives (
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  archive_id TEXT NOT NULL,
  generation BIGINT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'archive',
  entries JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TEXT NOT NULL,
  PRIMARY KEY (agent_id, session_id, archive_id),
  FOREIGN KEY (agent_id, session_id) REFERENCES conversation_sessions(agent_id, session_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS conversation_archives_session_order_idx ON conversation_archives(agent_id, session_id, created_at DESC);
`;

// v1-v3 schema constants remain immutable for adopted migration checksums.
// PostgreSQL jsonb decodes JSON string escapes into text (rejecting \u0000 and
// malformed surrogate pairs); json retains the original JSON lexical payload.
export const POSTGRES_SESSION_LOSSLESS_JSON_SCHEMA_SQL = `
ALTER TABLE conversation_entries ALTER COLUMN entry TYPE JSON USING entry::json;
ALTER TABLE conversation_archives ALTER COLUMN entries DROP DEFAULT;
ALTER TABLE conversation_archives ALTER COLUMN entries TYPE JSON USING entries::json;
ALTER TABLE conversation_archives ALTER COLUMN entries SET DEFAULT '[]'::json;
`;

export const POSTGRES_SESSION_OPERATOR_LOOKUP_SCHEMA_SQL = `CREATE INDEX IF NOT EXISTS conversation_entries_agent_recent_idx ON conversation_entries(agent_id, created_at DESC, sequence DESC);`;

export const POSTGRES_SESSION_ORIGINAL_LOOKUP_SCHEMA_SQL = `
-- Lexical top-level member scanner: no JSON string is decoded into PostgreSQL text.
CREATE OR REPLACE FUNCTION burrow_json_member(payload json, member text) RETURNS json
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE s text := payload::text; i int := 1; start_at int;
 depth int := 0; quoted boolean := false; escaped boolean := false;
 key_start int := 0; wanted boolean := false; c text;
BEGIN
 WHILE i <= length(s) LOOP
  c := substr(s,i,1);
  IF quoted THEN
   IF escaped THEN escaped := false;
   ELSIF c = chr(92) THEN escaped := true;
   ELSIF c = '"' THEN
    quoted := false;
    IF depth = 1 AND key_start > 0 THEN
     wanted := substr(s,key_start,i-key_start+1) = to_json(member)::text;
     key_start := 0;
    END IF;
   END IF;
  ELSE
   IF c = '"' THEN
    quoted := true;
    IF depth = 1 AND start_at IS NULL THEN key_start := i; END IF;
   ELSIF c = ':' AND depth = 1 THEN
    IF wanted THEN
     start_at := i+1;
     -- Scan the value lexically through the next top-level delimiter.
    END IF;
   ELSIF c IN ('{','[') THEN depth := depth+1;
   ELSIF c IN ('}',']') THEN
    depth := depth-1;
    IF depth = 0 AND start_at IS NOT NULL THEN RETURN substr(s,start_at,i-start_at)::json; END IF;
   ELSIF c = ',' AND depth = 1 THEN
    IF start_at IS NOT NULL THEN RETURN substr(s,start_at,i-start_at)::json; END IF;
    wanted := false;
   END IF;
  END IF;
  i := i+1;
 END LOOP;
 RETURN NULL;
END $$;
`;

export const POSTGRES_SESSION_FULL_SCHEMA_SQL = POSTGRES_SESSION_SCHEMA_SQL + POSTGRES_SESSION_ARCHIVE_SCHEMA_SQL + POSTGRES_SESSION_LOSSLESS_JSON_SCHEMA_SQL + POSTGRES_SESSION_OPERATOR_LOOKUP_SCHEMA_SQL + POSTGRES_SESSION_ORIGINAL_LOOKUP_SCHEMA_SQL;


const text = (value) => String(value ?? '');
const required = (value, name) => { const result = text(value).trim(); if (!result) throw new Error(`${name} is required`); return result; };
const stamp = () => new Date().toISOString();
const cursorValue = (value, name = 'after') => {
  if (value === undefined || value === null || value === '') return 0n;
  const result = typeof value === 'bigint' ? value : (typeof value === 'number' && Number.isSafeInteger(value) ? BigInt(value) : (typeof value === 'string' && /^[0-9]+$/.test(value) ? BigInt(value) : null));
  if (result === null || result < 0n) throw new Error(`${name} must be a non-negative integer cursor`);
  return result;
};
const limitValue = (value) => {
  if (value === undefined || value === null || value === '') return 20;
  if ((typeof value === 'number' && Number.isInteger(value) && value > 0) || (typeof value === 'string' && /^[1-9][0-9]*$/.test(value))) return Number(value);
  throw new Error('limit must be a positive integer');
};
function rowEntry(row) { return row ? { ...row.entry, sequence: String(row.sequence) } : null; }

export function assertConversationDeletionAllowed(sessionId, metadata = {}) {
  if (['running', 'finalizing'].includes(metadata.continuityHead?.state)) throw new Error('session_retention_active');
  if (metadata.current === true || metadata.currentMain === true || (['main', 'default'].includes(sessionId) && (!metadata.kind || metadata.kind === 'main'))) throw new Error('retention_refused_current_main');
}

/** Staged PostgreSQL authority boundary; callers explicitly own the pool. */
export class PostgresSessionStore {
  constructor({ pool, ownsPool = false, clock = stamp } = {}) {
    if (!pool?.query || !pool?.connect) throw new Error('session_postgres_pool_required');
    this.pool = pool; this.ownsPool = ownsPool; this.clock = clock;
  }
  async deleteSession({agentId: rawAgentId, sessionId: rawSessionId} = {}) {
    const agentId = required(rawAgentId, 'agentId');
    const sessionId = required(rawSessionId, 'sessionId');
    return withPostgresTransaction(this.pool, async client => {
      // Lock the authority row before cascaded deletion; active continuity is
      // never eligible even if a retention plan was built before a new run.
      const selected = await client.query('SELECT metadata FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, sessionId]);
      if (!selected.rows.length) return {deleted:false};
      assertConversationDeletionAllowed(sessionId, selected.rows[0].metadata);
      const result = await client.query('DELETE FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2', [agentId, sessionId]);
      return {deleted:result.rowCount === 1};
    });
  }

  async close() { await closeContinuityOwners(this.pool); if (this.ownsPool) await closePostgresPool(this.pool); }

  /** Original JSON is decoded in JS: SQL JSON extraction is not lossless for NUL. */
  async history({ agentId, scope = 'agent', query, cursor = '', pageSize = Math.min(50, resolveAlbdruckConfig().maxPageSize) } = {}) {
    if (!['agent', 'global'].includes(scope) || (scope === 'agent' && (typeof agentId !== 'string' || !agentId.trim()))) throw new Error('albdruck_scope_invalid');
    if (typeof query !== 'string' || !query.trim()) throw new Error('albdruck_query_required');
    if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > resolveAlbdruckConfig().maxPageSize) throw new Error('albdruck_page_size_invalid');
    const binding = JSON.stringify([scope, scope === 'agent' ? agentId : null, query.trim()]);
    let after = null;
    if (cursor) {
      try {
        const value = JSON.parse(Buffer.from(cursor, 'base64url').toString());
        if (value.v !== 1 || value.binding !== binding || !Array.isArray(value.key) || value.key.length !== 3 || value.key.some(x => typeof x !== 'string')) throw new Error();
        after = value.key;
      } catch { throw new Error('albdruck_cursor_invalid'); }
    } else if (typeof cursor !== 'string') throw new Error('albdruck_cursor_invalid');
    const compare = (a, b) => { for (let i = 0; i < 3; i++) { if (a[i] < b[i]) return -1; if (a[i] > b[i]) return 1; } return 0; };
    const originals = new Map();
    const consider = (row, entry, provenance) => {
      if (entry?.type !== 'message' || entry.metadata?.compressionSummary || !['user','assistant','agent'].includes(entry.role) || typeof entry.content !== 'string') return;
      const entryId = entry.id || row.entry_id;
      if (typeof entryId !== 'string' || !entryId) return;
      const key = [row.agent_id, row.session_id, entryId];
      if ((after && compare(key, after) <= 0) || !matchesQuery(entry, query.trim())) return;
      const id = JSON.stringify(key);
      if (!originals.has(id)) originals.set(id, { key, item: {
        agentId: row.agent_id, sessionId: row.session_id, entryId,
        timestamp: entry.timestamp ?? row.created_at, role: entry.role, content: entry.content,
        sourceRef: { kind: 'conversation_entry', agentId: row.agent_id, sessionId: row.session_id, entryId },
        provenance,
      } });
      // Retain only the smallest page plus lookahead while scanning authority.
      if (originals.size > pageSize + 1) {
        const largest = [...originals.entries()].reduce((a,b) => compare(a[1].key,b[1].key) > 0 ? a : b);
        originals.delete(largest[0]);
      }
    };
    // One repeatable-read snapshot keeps reset/compaction from hiding a turn during scanning.
    return withPostgresTransaction(this.pool, async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
      let sequence = '0';
      for (;;) {
        const { rows } = await client.query(`SELECT agent_id,session_id,entry_id,entry,created_at,sequence FROM conversation_entries
          WHERE ($1::text IS NULL OR agent_id=$1) AND sequence>$2::bigint ORDER BY sequence LIMIT 256`, [scope === 'agent' ? agentId : null, sequence]);
        for (const row of rows) consider(row, row.entry, { store: 'live', reset: false });
        if (rows.length < 256) break;
        sequence = String(rows.at(-1).sequence);
      }
      let archiveKey = null;
      for (;;) {
        const { rows } = await client.query(`SELECT agent_id,session_id,archive_id,entries,generation,kind,created_at FROM conversation_archives
          WHERE ($1::text IS NULL OR agent_id=$1) AND ($2::text IS NULL OR (agent_id,session_id,archive_id)>($2,$3,$4))
          ORDER BY agent_id,session_id,archive_id LIMIT 64`, [scope === 'agent' ? agentId : null, ...(archiveKey || [null,null,null])]);
        for (const row of rows) for (const entry of row.entries) consider(row, entry, { store: 'archive', reset: row.kind === 'reset', archiveId: row.archive_id, kind: row.kind, generation: Number(row.generation), archivedAt: row.created_at });
        if (rows.length < 64) break;
        const last = rows.at(-1); archiveKey = [last.agent_id,last.session_id,last.archive_id];
      }
      const ordered = [...originals.values()].sort((a,b) => compare(a.key,b.key));
      const page = ordered.slice(0,pageSize);
      return { items: page.map(x => x.item), nextCursor: ordered.length > pageSize ? Buffer.from(JSON.stringify({ v: 1, binding, key: page.at(-1).key })).toString('base64url') : null };
    });
  }

  async resolveOriginal({ agentId, sessionId, entryId }) {
    const { rows } = entryId.includes('\u0000') ? { rows: [] } : await this.pool.query('SELECT entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 AND entry_id=$3', [agentId, sessionId, entryId]);
    if (rows[0]) return rows[0].entry;
    // Project only lexical JSON IDs: even -> can decode unrelated NUL strings.
    // Decode IDs in JS, then fetch just the matching lexical JSON element.
    // Archive ordering and first duplicate within a snapshot match the old scan.
    let before = null;
    for (;;) {
      const { rows: archives } = await this.pool.query(`SELECT archive_id, (SELECT json_agg(burrow_json_member(value,'id') ORDER BY ordinal) FROM json_array_elements(entries) WITH ORDINALITY AS e(value,ordinal)) AS entry_ids FROM conversation_archives WHERE agent_id=$1 AND session_id=$2 AND ($3::text IS NULL OR archive_id<$3) ORDER BY archive_id DESC LIMIT 64`, [agentId, sessionId, before]);
      for (const archive of archives) {
        const index = (archive.entry_ids || []).findIndex(id => id === entryId);
        if (index !== -1) {
          const result = await this.pool.query('SELECT (SELECT value FROM json_array_elements(entries) WITH ORDINALITY AS e(value,ordinal) WHERE ordinal=$4::int+1) AS entry FROM conversation_archives WHERE agent_id=$1 AND session_id=$2 AND archive_id=$3', [agentId, sessionId, archive.archive_id, index]);
          if (result.rows[0]) return result.rows[0].entry;
        }
      }
      if (archives.length < 64) return null;
      before = archives.at(-1).archive_id;
    }
  }

  async append({ agentId: rawAgentId, sessionId: rawSessionId, entry, idempotencyKey = null } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId');
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('session_entry_required');
    const value = { ...entry };
    const entryId = text(value.id).trim() || randomUUID();
    const key = idempotencyKey == null ? (value.metadata?.idempotencyKey || null) : text(idempotencyKey);
    const now = this.clock();
    return withPostgresTransaction(this.pool, async (client) => {
      await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,'{}'::jsonb,$3,$3) ON CONFLICT(agent_id,session_id) DO NOTHING`, [agentId, sid, now]);
      // Row lock serializes appenders before identity allocation, making commit-order paging complete.
      await client.query('SELECT 1 FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, sid]);
      const result = await client.query(`INSERT INTO conversation_entries(agent_id,session_id,entry_id,idempotency_key,entry,created_at) VALUES($1,$2,$3,$4,$5::json,$6) ON CONFLICT DO NOTHING RETURNING sequence,entry`, [agentId, sid, entryId, key, JSON.stringify(value), now]);
      if (result.rows[0]) {
        await client.query('UPDATE conversation_sessions SET updated_at=$3 WHERE agent_id=$1 AND session_id=$2', [agentId, sid, now]);
        return { ...rowEntry(result.rows[0]), idempotent: false };
      }
      const existing = await client.query(`SELECT sequence,entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 AND (entry_id=$3 OR ($4::text IS NOT NULL AND idempotency_key=$4::text)) ORDER BY sequence LIMIT 1`, [agentId, sid, entryId, key]);
      if (!existing.rows[0]) throw new Error('session_entry_conflict');
      return { ...rowEntry(existing.rows[0]), idempotent: true };
    });
  }
  async appendIfAbsent(args = {}) { return this.append(args); }

  async read({ agentId: rawAgentId, sessionId: rawSessionId, limit = 20, after = 0 } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId'); const size = limitValue(limit); const cursor = cursorValue(after);
    const result = await this.pool.query(`SELECT sequence,entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 AND sequence>$3 ORDER BY sequence LIMIT $4`, [agentId, sid, cursor.toString(), size]);
    return result.rows.map(rowEntry);
  }

  async projection({ agentId, sessionId, visibility, limit }) {
    // Never invoke PostgreSQL JSON extraction on the entry: even extracting an
    // unrelated field decodes escaped NUL and fails with 22P05. Scan newest first
    // in bounded batches so the limit applies *after* visibility filtering.
    const aid = required(agentId, 'agentId'); const sid = required(sessionId, 'sessionId');
    const size = limitValue(limit); const matches = []; let before = null;
    while (matches.length < size) {
      const result = await this.pool.query(`SELECT sequence,entry FROM conversation_entries
        WHERE agent_id=$1 AND session_id=$2 AND ($3::bigint IS NULL OR sequence<$3::bigint)
        ORDER BY sequence DESC LIMIT $4`, [aid, sid, before, 256]);
      for (const row of result.rows) {
        if (row.entry.visibility === visibility) matches.push(rowEntry(row));
        if (matches.length === size) break;
      }
      if (result.rows.length < 256) break;
      before = String(result.rows.at(-1).sequence);
    }
    return matches.reverse();
  }

  async page(args = {}) {
    const size = limitValue(args.limit); const cursor = cursorValue(args.after); const agentId = required(args.agentId, 'agentId'); const sid = required(args.sessionId, 'sessionId');
    const result = await this.pool.query(`SELECT sequence,entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 AND sequence>$3 ORDER BY sequence LIMIT $4`, [agentId, sid, cursor.toString(), size + 1]);
    const hasMore = result.rows.length > size; const rows = hasMore ? result.rows.slice(0, size) : result.rows;
    return { entries: rows.map(rowEntry), next: hasMore ? String(rows.at(-1).sequence) : null, hasMore };
  }

  async lastOperatorMessageAt({ agentId: rawAgentId } = {}) {
    const agentId = required(rawAgentId, 'agentId');
    let newest = null;
    const consider = (entry) => {
      if (entry?.type !== 'message' || entry?.role !== 'user') return;
      if (entry?.metadata?.source === 'scheduled' || String(entry?.runId || '').startsWith('scheduled-')) return;
      const at = new Date(entry.ts);
      if (Number.isFinite(at.getTime()) && (!newest || at > newest)) newest = at;
    };
    let beforeAt = null; let beforeSequence = null;
    // Decode JSON in JS: PostgreSQL JSON extraction can fail on escaped NUL.
    // Compaction moves messages to archives, so active entries alone are not
    // sufficient. Walk both sources without a history depth cutoff.
    for (;;) {
      const rows = (await this.pool.query(`SELECT sequence,entry,created_at FROM conversation_entries
        WHERE agent_id=$1 AND ($2::text IS NULL OR (created_at,sequence)<($2::text,$3::bigint))
        ORDER BY created_at DESC,sequence DESC LIMIT 256`, [agentId, beforeAt, beforeSequence])).rows;
      for (const row of rows) consider(row.entry);
      if (rows.length < 256) break;
      beforeAt = rows.at(-1).created_at;
      beforeSequence = String(rows.at(-1).sequence);
    }
    let beforeArchive = null;
    for (;;) {
      const rows = (await this.pool.query(`SELECT archive_id,entries FROM conversation_archives
        WHERE agent_id=$1 AND ($2::text IS NULL OR archive_id<$2::text)
        ORDER BY archive_id DESC LIMIT 64`, [agentId, beforeArchive])).rows;
      for (const row of rows) for (const entry of row.entries || []) consider(entry);
      if (rows.length < 64) break;
      beforeArchive = rows.at(-1).archive_id;
    }
    return newest?.toISOString() || null;
  }

  async listSessions({ agentId: rawAgentId, includeArchived = true } = {}) {
    const agentId = required(rawAgentId, 'agentId');
    const result = await this.pool.query(`SELECT session_id,metadata,created_at,updated_at FROM conversation_sessions WHERE agent_id=$1 ${includeArchived ? '' : "AND COALESCE((metadata->>'archived')::boolean,false)=false"} ORDER BY updated_at DESC`, [agentId]);
    return result.rows.map((row) => ({ ...row.metadata, sessionId: row.session_id, createdAt: row.created_at, updatedAt: row.updated_at }));
  }

  // A single statement gives metadata, retained generations and active entries one
  // MVCC snapshot. Reset documents are separate exports, never active history.
  async exportTranscript({ agentId, sessionId } = {}) {
    const result = await this.pool.query(`
      SELECT s.metadata,s.created_at,s.updated_at,
        COALESCE((SELECT json_agg(a.entries ORDER BY a.generation,a.created_at,a.archive_id)
          FROM conversation_archives a WHERE a.agent_id=s.agent_id AND a.session_id=s.session_id
          AND a.kind='compacted' AND a.generation >= COALESCE(
            (s.metadata->>'resetGeneration')::bigint,
            (SELECT max(r.generation)+1 FROM conversation_archives r
              WHERE r.agent_id=s.agent_id AND r.session_id=s.session_id AND r.kind='reset'),0)), '[]'::json) AS history,
        COALESCE((SELECT json_agg(e.entry ORDER BY e.sequence) FROM conversation_entries e
          WHERE e.agent_id=s.agent_id AND e.session_id=s.session_id), '[]'::json) AS entries
      FROM conversation_sessions s WHERE s.agent_id=$1 AND s.session_id=$2`,
    [required(agentId, 'agentId'), required(sessionId, 'sessionId')]);
    const row = result.rows[0];
    if (!row) return null;
    return { schemaVersion: '1', session: { id: sessionId, metadata: { ...row.metadata, createdAt: row.created_at, updatedAt: row.updated_at } }, entries: [...row.history.flat(), ...row.entries] };
  }

  async getMetadata({ agentId: rawAgentId, sessionId: rawSessionId } = {}) {
    const result = await this.pool.query('SELECT metadata,created_at,updated_at FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2', [required(rawAgentId, 'agentId'), required(rawSessionId, 'sessionId')]);
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
    const result = await this.pool.query(`UPDATE conversation_archives SET metadata=metadata || $4::jsonb WHERE agent_id=$1 AND session_id=$2 AND archive_id=$3 RETURNING metadata`, [required(agentId,'agentId'),required(sessionId,'sessionId'),required(archiveId,'archiveId'),JSON.stringify(metadata)]);
    return result.rows[0]?.metadata || null;
  }

  async compact({ agentId: rawAgentId, sessionId: rawSessionId, summary, tailEntries = [] } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId');
    if (!summary || typeof summary !== 'object' || !String(summary.text || '').trim()) throw new Error('session_compaction_summary_required');
    const now = this.clock();
    return withPostgresTransaction(this.pool, async (client) => {
      await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,'{}'::jsonb,$3,$3) ON CONFLICT DO NOTHING`, [agentId, sid, now]);
      const session = await client.query('SELECT metadata FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, sid]);
      const prior = session.rows[0]?.metadata || {};
      const old = await client.query('SELECT entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 ORDER BY sequence', [agentId, sid]);
      const archiveId = old.rows.length ? randomUUID() : null;
      const generation = Number(prior.generation || 0) + 1;
      if (archiveId) await client.query('INSERT INTO conversation_archives(agent_id,session_id,archive_id,generation,kind,entries,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6::json,$7::jsonb,$8)', [agentId, sid, archiveId, generation - 1, 'compacted', JSON.stringify(old.rows.map((row) => row.entry)), JSON.stringify({ ...prior, compressionSummary: summary }), now]);
      await client.query('DELETE FROM conversation_entries WHERE agent_id=$1 AND session_id=$2', [agentId, sid]);
      const summaryEntry = { id: randomUUID(), ts: now, sessionId: sid, type: 'summary', role: null, content: String(summary.text), visibility: 'debug', entersPrompt: false, metadata: { compressionSummary: summary } };
      const retained = (Array.isArray(tailEntries) ? tailEntries : []).map((entry) => ({ ...entry, sessionId: sid, metadata: { ...(entry.metadata || {}) } }));
      for (const entry of [summaryEntry, ...retained]) {
        await client.query('INSERT INTO conversation_entries(agent_id,session_id,entry_id,entry,created_at) VALUES($1,$2,$3,$4::json,$5)', [agentId, sid, text(entry.id).trim() || randomUUID(), JSON.stringify(entry), now]);
      }
      const next = { ...prior, generation, archived: false, transcriptGeneration: randomUUID(), activeTranscript: 'postgres', archiveId, updatedAt: now, turnCount: 1 + retained.length, chatTurnCount: retained.filter((entry) => entry.type === 'message' && ['user','assistant','agent'].includes(entry.role)).length };
      await client.query('UPDATE conversation_sessions SET metadata=$3::jsonb,updated_at=$4 WHERE agent_id=$1 AND session_id=$2', [agentId, sid, JSON.stringify(next), now]);
      return { archiveId, generation, summaryEntry, retainedCount: retained.length, metadata: next };
    });
  }

  async reset({ agentId: rawAgentId, sessionId: rawSessionId, metadata = {} } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId'); const now = this.clock();
    return withPostgresTransaction(this.pool, async (client) => {
      await client.query(`INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,'{}'::jsonb,$3,$3) ON CONFLICT DO NOTHING`, [agentId, sid, now]);
      const session = await client.query('SELECT metadata FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, sid]);
      const prior = session.rows[0]?.metadata || {};
      const rows = await client.query('SELECT entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 ORDER BY sequence', [agentId, sid]);
      const archiveId = rows.rows.length ? randomUUID() : null;
      const generation = Number(prior.generation || 0) + 1;
      if (archiveId) await client.query('INSERT INTO conversation_archives(agent_id,session_id,archive_id,generation,kind,entries,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6::json,$7::jsonb,$8)', [agentId, sid, archiveId, generation - 1, 'reset', JSON.stringify(rows.rows.map((row) => row.entry)), JSON.stringify({ ...prior, ...metadata }), now]);
      await client.query('DELETE FROM conversation_entries WHERE agent_id=$1 AND session_id=$2', [agentId, sid]);
      const next = { ...prior, ...metadata, generation, resetGeneration: generation, archived: false, resetAt: now, archiveId, turnCount: 0, chatTurnCount: 0 };
      await client.query('UPDATE conversation_sessions SET metadata=$3::jsonb,updated_at=$4 WHERE agent_id=$1 AND session_id=$2', [agentId, sid, JSON.stringify(next), now]);
      return { ok: true, agentId, sessionId: sid, archiveId, generation, metadata: { ...next, updatedAt: now } };
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
      const sourceRows = await client.query('SELECT entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 ORDER BY sequence DESC LIMIT $3', [sourceAgent, source, size]);
      const entries = sourceRows.rows.reverse().map((row) => row.entry);
      for (const entry of entries) { const value = { ...entry, metadata: { ...(entry.metadata || {}), forkedFrom: source } }; await client.query('INSERT INTO conversation_entries(agent_id,session_id,entry_id,entry,created_at) VALUES($1,$2,$3,$4::json,$5)', [targetAgent, target, text(value.id).trim() || randomUUID(), JSON.stringify(value), now]); }
      return { ok: true, sourceAgentId: sourceAgent, targetAgentId: targetAgent, sourceSessionId: source, targetSessionId: target, copiedEntries: entries.length };
    });
  }

  async rename({ agentId: rawAgentId, sessionId: rawSessionId, targetSessionId: rawTarget } = {}) {
    const agentId = required(rawAgentId, 'agentId');
    const source = required(rawSessionId, 'sessionId');
    const target = required(rawTarget, 'targetSessionId');
    if (source === target) return { ok: true, agentId, sessionId: source, targetSessionId: target };
    return withPostgresTransaction(this.pool, async (client) => {
      const sourceRow = await client.query('SELECT metadata,created_at,updated_at FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE', [agentId, source]);
      if (!sourceRow.rows[0]) return null;
      const reserved = await client.query('INSERT INTO conversation_sessions(agent_id,session_id,metadata,created_at,updated_at) VALUES($1,$2,$3::jsonb,$4,$5) ON CONFLICT DO NOTHING RETURNING session_id', [agentId, target, JSON.stringify({ ...sourceRow.rows[0].metadata, sessionId: target }), sourceRow.rows[0].created_at, sourceRow.rows[0].updated_at]);
      if (!reserved.rows[0]) throw new Error('rename_target_exists');
      await client.query(`INSERT INTO conversation_entries(agent_id,session_id,entry_id,idempotency_key,entry,created_at) SELECT agent_id,$3,entry_id,idempotency_key,entry,created_at FROM conversation_entries WHERE agent_id=$1 AND session_id=$2`, [agentId, source, target]);
      await client.query(`INSERT INTO conversation_archives(agent_id,session_id,archive_id,generation,kind,entries,metadata,created_at) SELECT agent_id,$3,archive_id,generation,kind,entries,metadata,created_at FROM conversation_archives WHERE agent_id=$1 AND session_id=$2`, [agentId, source, target]);
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

  async listArchives({ agentId: rawAgentId, sessionId: rawSessionId, limit = 100 } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const params = [agentId]; let where = 'agent_id=$1';
    if (rawSessionId != null) { params.push(required(rawSessionId, 'sessionId')); where += ` AND session_id=$${params.length}`; }
    const unbounded = limit === null;
    if (!unbounded) params.push(limitValue(limit));
    const result = await this.pool.query(`SELECT archive_id,session_id,generation,kind,entries,metadata,created_at FROM conversation_archives WHERE ${where} ORDER BY created_at DESC, archive_id DESC${unbounded ? '' : ` LIMIT $${params.length}`}`, params);
    return result.rows.map((row) => ({ archiveId: row.archive_id, sessionId: row.session_id, generation: Number(row.generation), kind: row.kind, entries: row.entries, metadata: row.metadata, createdAt: row.created_at }));
  }

  async readArchive({ agentId: rawAgentId, sessionId: rawSessionId, archiveId } = {}) {
    const agentId = required(rawAgentId, 'agentId'); const sid = required(rawSessionId, 'sessionId'); const id = required(archiveId, 'archiveId');
    const result = await this.pool.query('SELECT archive_id,session_id,generation,kind,entries,metadata,created_at FROM conversation_archives WHERE agent_id=$1 AND session_id=$2 AND archive_id=$3', [agentId, sid, id]);
    const row = result.rows[0];
    return row ? { archiveId: row.archive_id, sessionId: row.session_id, generation: Number(row.generation), kind: row.kind, entries: row.entries, metadata: row.metadata, createdAt: row.created_at } : null;
  }
}

export const SESSION_SCHEMA_SQL = POSTGRES_SESSION_FULL_SCHEMA_SQL;
