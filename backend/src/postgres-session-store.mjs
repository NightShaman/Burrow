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

export const POSTGRES_SESSION_FULL_SCHEMA_SQL = POSTGRES_SESSION_SCHEMA_SQL + POSTGRES_SESSION_ARCHIVE_SCHEMA_SQL;


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

/** Staged PostgreSQL authority boundary; callers explicitly own the pool. */
export class PostgresSessionStore {
  constructor({ pool, ownsPool = false, clock = stamp } = {}) {
    if (!pool?.query || !pool?.connect) throw new Error('session_postgres_pool_required');
    this.pool = pool; this.ownsPool = ownsPool; this.clock = clock;
  }
  async close() { await closeContinuityOwners(this.pool); if (this.ownsPool) await closePostgresPool(this.pool); }

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
      const result = await client.query(`INSERT INTO conversation_entries(agent_id,session_id,entry_id,idempotency_key,entry,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT DO NOTHING RETURNING sequence,entry`, [agentId, sid, entryId, key, JSON.stringify(value), now]);
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
    const result = await this.pool.query(`SELECT sequence,entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 AND entry->>'visibility'=$3 ORDER BY sequence DESC LIMIT $4`, [required(agentId, 'agentId'), required(sessionId, 'sessionId'), visibility, limitValue(limit)]);
    return result.rows.reverse().map(rowEntry);
  }

  async page(args = {}) {
    const size = limitValue(args.limit); const cursor = cursorValue(args.after); const agentId = required(args.agentId, 'agentId'); const sid = required(args.sessionId, 'sessionId');
    const result = await this.pool.query(`SELECT sequence,entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 AND sequence>$3 ORDER BY sequence LIMIT $4`, [agentId, sid, cursor.toString(), size + 1]);
    const hasMore = result.rows.length > size; const rows = hasMore ? result.rows.slice(0, size) : result.rows;
    return { entries: rows.map(rowEntry), next: hasMore ? String(rows.at(-1).sequence) : null, hasMore };
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
        COALESCE((SELECT jsonb_agg(a.entries ORDER BY a.generation,a.created_at,a.archive_id)
          FROM conversation_archives a WHERE a.agent_id=s.agent_id AND a.session_id=s.session_id
          AND a.kind='compacted' AND a.generation >= COALESCE(
            (s.metadata->>'resetGeneration')::bigint,
            (SELECT max(r.generation)+1 FROM conversation_archives r
              WHERE r.agent_id=s.agent_id AND r.session_id=s.session_id AND r.kind='reset'),0)), '[]'::jsonb) AS history,
        COALESCE((SELECT jsonb_agg(e.entry ORDER BY e.sequence) FROM conversation_entries e
          WHERE e.agent_id=s.agent_id AND e.session_id=s.session_id), '[]'::jsonb) AS entries
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
      await client.query('UPDATE conversation_sessions SET metadata=$3::jsonb,updated_at=$4 WHERE agent_id=$1 AND session_id=$2',[aid,sid,JSON.stringify(metadata),now]);
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
      if (archiveId) await client.query('INSERT INTO conversation_archives(agent_id,session_id,archive_id,generation,kind,entries,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)', [agentId, sid, archiveId, generation - 1, 'compacted', JSON.stringify(old.rows.map((row) => row.entry)), JSON.stringify({ ...prior, compressionSummary: summary }), now]);
      await client.query('DELETE FROM conversation_entries WHERE agent_id=$1 AND session_id=$2', [agentId, sid]);
      const summaryEntry = { id: randomUUID(), ts: now, sessionId: sid, type: 'summary', role: null, content: String(summary.text), visibility: 'debug', entersPrompt: false, metadata: { compressionSummary: summary } };
      const retained = (Array.isArray(tailEntries) ? tailEntries : []).map((entry) => ({ ...entry, sessionId: sid, metadata: { ...(entry.metadata || {}) } }));
      for (const entry of [summaryEntry, ...retained]) {
        await client.query('INSERT INTO conversation_entries(agent_id,session_id,entry_id,entry,created_at) VALUES($1,$2,$3,$4::jsonb,$5)', [agentId, sid, text(entry.id).trim() || randomUUID(), JSON.stringify(entry), now]);
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
      if (archiveId) await client.query('INSERT INTO conversation_archives(agent_id,session_id,archive_id,generation,kind,entries,metadata,created_at) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)', [agentId, sid, archiveId, generation - 1, 'reset', JSON.stringify(rows.rows.map((row) => row.entry)), JSON.stringify({ ...prior, ...metadata }), now]);
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
      for (const entry of entries) { const value = { ...entry, metadata: { ...(entry.metadata || {}), forkedFrom: source } }; await client.query('INSERT INTO conversation_entries(agent_id,session_id,entry_id,entry,created_at) VALUES($1,$2,$3,$4::jsonb,$5)', [targetAgent, target, text(value.id).trim() || randomUUID(), JSON.stringify(value), now]); }
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
