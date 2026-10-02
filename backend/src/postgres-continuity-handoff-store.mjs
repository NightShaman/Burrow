import { normalizePostgresPool } from './postgres-foundation.mjs';
import { closePostgresPool, withPostgresTransaction } from './postgres-foundation.mjs';

const MAX_TITLE_CHARS = 240;
const MAX_EVIDENCE_SUMMARY_CHARS = 480;
const MAX_HANDOFF_CONTENT_CHARS = 24_000;
const DEFAULT_TTL_DAYS = 14;

/** Schema owned by this store; the central migration manifest can import it later. */
export const POSTGRES_CONTINUITY_HANDOFF_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS continuity_handoffs (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'runtime',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_refs JSONB NOT NULL,
  evidence_summary TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS continuity_handoffs_agent_idx
  ON continuity_handoffs (agent_id, expires_at, updated_at DESC);
`;
export const CONTINUITY_HANDOFF_SCHEMA_SQL = POSTGRES_CONTINUITY_HANDOFF_SCHEMA_SQL;

function text(value) { return String(value ?? '').trim(); }
function bounded(value, limit) { const source = text(value); return source.length <= limit ? source : source.slice(0, limit).trim(); }
function expiry(days = DEFAULT_TTL_DAYS) { return new Date(Date.now() + Math.max(1, Number(days) || DEFAULT_TTL_DAYS) * 86_400_000).toISOString(); }
function now() { return new Date().toISOString(); }
function contentOrReject(value) {
  const source = text(value);
  if (source.length > MAX_HANDOFF_CONTENT_CHARS) throw new Error('continuity_handoff_content_too_large');
  return source;
}
function validate(record = {}) {
  const sourceRefs = [...new Set((Array.isArray(record.sourceRefs) ? record.sourceRefs : []).map(text).filter(Boolean))].slice(0, 8);
  const value = {
    id: text(record.id), agentId: text(record.agentId), sessionId: text(record.sessionId), runId: text(record.runId),
    source: text(record.source) || 'runtime', title: bounded(record.title, MAX_TITLE_CHARS), content: contentOrReject(record.content),
    sourceRefs, evidenceSummary: bounded(record.evidenceSummary, MAX_EVIDENCE_SUMMARY_CHARS), expiresAt: text(record.expiresAt) || expiry(record.ttlDays),
  };
  for (const key of ['id', 'agentId', 'sessionId', 'runId', 'title', 'content', 'evidenceSummary']) if (!value[key]) throw new Error(`continuity_handoff_${key}_required`);
  if (!value.sourceRefs.length) throw new Error('continuity_handoff_source_refs_required');
  if (Number.isNaN(Date.parse(value.expiresAt))) throw new Error('continuity_handoff_expiry_invalid');
  return value;
}

function parseRefs(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return []; } }
  return value && typeof value === 'object' ? value : [];
}
export function publicRecord(row) {
  return row && {
    version: 1, kind: 'continuity_handoff', id: row.id, agentId: row.agent_id, sessionId: row.session_id, runId: row.run_id,
    source: row.source || 'runtime', title: row.title, content: row.content, contentChars: String(row.content || '').length,
    contentComplete: true, sourceRefs: parseRefs(row.source_refs), evidenceSummary: row.evidence_summary,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : row.updated_at,
    expiresAt: row.expires_at instanceof Date ? row.expires_at.toISOString() : row.expires_at,
  };
}

const UPSERT_SQL = `INSERT INTO continuity_handoffs
  (id,agent_id,session_id,run_id,source,title,content,source_refs,evidence_summary,created_at,updated_at,expires_at)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$10,$11)
  ON CONFLICT (id) DO UPDATE SET run_id=EXCLUDED.run_id, source=EXCLUDED.source, title=EXCLUDED.title,
    content=EXCLUDED.content, source_refs=EXCLUDED.source_refs, evidence_summary=EXCLUDED.evidence_summary,
    updated_at=EXCLUDED.updated_at, expires_at=EXCLUDED.expires_at
    WHERE NOT (continuity_handoffs.source='explicit' AND EXCLUDED.source='runtime')`;

export class PostgresContinuityHandoffStore {
  constructor({ pool, ownsPool = false } = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new Error('continuity_handoff_postgres_pool_required');
    this.pool = normalizePostgresPool(pool);
    this.ownsPool = ownsPool;
  }
  async close() { if (this.ownsPool) await closePostgresPool(this.pool); }
  async upsert(record = {}) {
    const value = validate(record);
    const timestamp = now();
    return withPostgresTransaction(this.pool, async (client) => {
      const existing = await client.query('SELECT * FROM continuity_handoffs WHERE id=$1', [value.id]);
      if (existing.rows[0]?.source === 'explicit' && value.source === 'runtime') return publicRecord(existing.rows[0]);
      await client.query(UPSERT_SQL, [value.id, value.agentId, value.sessionId, value.runId, value.source, value.title, value.content, JSON.stringify(value.sourceRefs), value.evidenceSummary, timestamp, value.expiresAt]);
      await client.query('DELETE FROM continuity_handoffs WHERE expires_at < $1', [timestamp]);
      const result = await client.query('SELECT * FROM continuity_handoffs WHERE id=$1', [value.id]);
      return publicRecord(result.rows[0]);
    });
  }
  async list({ agentId, limit = 3 } = {}) {
    if (!text(agentId)) throw new Error('continuity_handoff_agent_id_required');
    const result = await this.pool.query(`SELECT * FROM continuity_handoffs WHERE agent_id=$1 AND expires_at >= $2 ORDER BY updated_at DESC LIMIT $3`, [text(agentId), now(), Math.max(1, Math.min(5, Number(limit) || 3))]);
    return result.rows.map(publicRecord);
  }
  async get({ agentId, sessionId } = {}) {
    if (!text(agentId) || !text(sessionId)) return null;
    const result = await this.pool.query('SELECT * FROM continuity_handoffs WHERE agent_id=$1 AND session_id=$2 AND expires_at >= $3', [text(agentId), text(sessionId), now()]);
    return publicRecord(result.rows[0]);
  }
  async getRecent({ agentId, sessionId = null } = {}) {
    if (!text(agentId)) return null;
    const result = await this.pool.query(`SELECT * FROM continuity_handoffs WHERE agent_id=$1 AND expires_at >= $2
      ORDER BY CASE WHEN source='explicit' THEN 0 ELSE 1 END, CASE WHEN session_id=$3 THEN 0 ELSE 1 END,
      updated_at DESC, id DESC LIMIT 1`, [text(agentId), now(), text(sessionId)]);
    return publicRecord(result.rows[0]);
  }
}

export async function listContinuityHandoffs({ pool, agentId, limit = 3 } = {}) {
  if (!pool) return [];
  const store = new PostgresContinuityHandoffStore({ pool });
  return store.list({ agentId, limit });
}

export function buildContinuityHandoff({ agentId, sessionId, runId, message = '', answerText = '', toolResults = [], curated = null } = {}) {
  const user = text(message), answer = text(answerText);
  const successful = (Array.isArray(toolResults) ? toolResults : []).filter((result) => result?.ok === true);
  if (!user || !answer || (!successful.length && user.length + answer.length < 240)) return null;
  const actions = successful.slice(0, 6).map((result) => text(result.tool || result.label || 'tool')).filter(Boolean);
  return { id: `continuity:${text(agentId)}:${text(sessionId)}`, agentId, sessionId, runId, source: 'runtime',
    title: bounded(curated?.title || user.replace(/\s+/g, ' '), 180), content: curated?.content ? `User goal/request:\n${user}\n\nHandoff:\n${text(curated.content)}` : `User goal/request:\n${user}\n\nLatest outcome:\n${answer}`,
    sourceRefs: [`session:${text(sessionId)}`, `run:${text(runId)}`], evidenceSummary: actions.length ? `Successful runtime actions: ${[...new Set(actions)].join(', ')}` : 'Conversation-backed continuity; verify live state before relying on claims.', ttlDays: DEFAULT_TTL_DAYS };
}
