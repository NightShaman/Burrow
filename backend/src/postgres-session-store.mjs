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
  async close() { if (this.ownsPool) await closePostgresPool(this.pool); }

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

  async page(args = {}) {
    const size = limitValue(args.limit); const cursor = cursorValue(args.after); const agentId = required(args.agentId, 'agentId'); const sid = required(args.sessionId, 'sessionId');
    const result = await this.pool.query(`SELECT sequence,entry FROM conversation_entries WHERE agent_id=$1 AND session_id=$2 AND sequence>$3 ORDER BY sequence LIMIT $4`, [agentId, sid, cursor.toString(), size + 1]);
    const hasMore = result.rows.length > size; const rows = hasMore ? result.rows.slice(0, size) : result.rows;
    return { entries: rows.map(rowEntry), next: hasMore ? String(rows.at(-1).sequence) : null, hasMore };
  }

  async getMetadata({ agentId: rawAgentId, sessionId: rawSessionId } = {}) {
    const result = await this.pool.query('SELECT metadata,created_at,updated_at FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2', [required(rawAgentId, 'agentId'), required(rawSessionId, 'sessionId')]);
    if (!result.rows[0]) return null;
    return { ...result.rows[0].metadata, createdAt: result.rows[0].created_at, updatedAt: result.rows[0].updated_at };
  }
}

export const SESSION_SCHEMA_SQL = POSTGRES_SESSION_SCHEMA_SQL;
