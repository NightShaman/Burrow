import { createHash } from 'node:crypto';
import { closePostgresPool, withPostgresTransaction } from './postgres-foundation.mjs';

export const POSTGRES_DREAM_DIARY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dream_diary_entries (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  entry_date TEXT NOT NULL,
  phase TEXT NOT NULL CHECK (phase IN ('light','rem','deep','manual')),
  narrative TEXT NOT NULL,
  narrative_digest TEXT NOT NULL,
  source_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  UNIQUE (agent_id, entry_date, phase, narrative_digest)
);
CREATE INDEX IF NOT EXISTS dream_diary_entries_agent_idx ON dream_diary_entries (agent_id, entry_date DESC, created_at DESC);
`;
export const DREAM_DIARY_SCHEMA_SQL = POSTGRES_DREAM_DIARY_SCHEMA_SQL;

const MAX_NARRATIVE_CHARS = 12_000;
const MAX_SOURCE_REFS = 16;
const phases = new Set(['light', 'rem', 'deep', 'manual']);
const text = (value) => String(value ?? '').trim();
const iso = (value) => value instanceof Date ? value.toISOString() : value;
function date(value) {
  const result = text(value) || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new Error('dream_diary_entry_date_invalid');
  return result;
}
function phase(value) { const result = text(value || 'manual').toLowerCase(); if (!phases.has(result)) throw new Error('dream_diary_phase_invalid'); return result; }
function narrative(value) { const result = text(value); if (!result) throw new Error('dream_diary_narrative_required'); if (result.length > MAX_NARRATIVE_CHARS) throw new Error('dream_diary_narrative_too_large'); return result; }
function refs(value) { return (Array.isArray(value) ? value : []).map(text).filter(Boolean).slice(0, MAX_SOURCE_REFS); }
function digest(agentId, entryDate, entryPhase, body) { return createHash('sha256').update([agentId, entryDate, entryPhase, body].join('\u0000')).digest('hex'); }
function makeId(agentId, entryDate, entryPhase, body) { return `dream-diary-${digest(agentId, entryDate, entryPhase, body).slice(0, 24)}`; }
function parseRefs(value) { if (Array.isArray(value)) return value; if (typeof value === 'string') { try { return JSON.parse(value); } catch { return []; } } return []; }
function publicRow(row) { return row && { id: row.id, agentId: row.agent_id, entryDate: row.entry_date instanceof Date ? row.entry_date.toISOString().slice(0, 10) : row.entry_date, phase: row.phase, narrative: row.narrative, sourceRefs: parseRefs(row.source_refs), createdAt: iso(row.created_at), updatedAt: iso(row.updated_at) }; }

export class PostgresDreamDiaryStore {
  constructor({ pool, ownsPool = false } = {}) { if (!pool?.query || !pool?.connect) throw new Error('dream_diary_postgres_pool_required'); this.pool = pool; this.ownsPool = ownsPool; }
  async close() { if (this.ownsPool) await closePostgresPool(this.pool); }
  async append(agent, input = {}) {
    const agentId = text(agent || input.agentId); if (!agentId) throw new Error('dream_diary_agent_required');
    const check = await this.pool.query('SELECT id FROM agents WHERE id=$1', [agentId]); if (!check.rows[0]) throw new Error('agent_not_found');
    const entryDate = date(input.entryDate || input.date), entryPhase = phase(input.phase), body = narrative(input.narrative || input.markdown || input.content), sourceRefs = refs(input.sourceRefs), narrativeDigest = digest(agentId, entryDate, entryPhase, body), id = text(input.id) || makeId(agentId, entryDate, entryPhase, body), at = new Date().toISOString();
    await withPostgresTransaction(this.pool, async (client) => {
      const result = await client.query(`INSERT INTO dream_diary_entries (id,agent_id,entry_date,phase,narrative,narrative_digest,source_refs,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$8) ON CONFLICT (agent_id,entry_date,phase,narrative_digest) DO UPDATE SET source_refs=EXCLUDED.source_refs,updated_at=EXCLUDED.updated_at WHERE dream_diary_entries.narrative=EXCLUDED.narrative RETURNING id`, [id, agentId, entryDate, entryPhase, body, narrativeDigest, JSON.stringify(sourceRefs), at]);
      if (!result.rows[0]) throw new Error('dream_diary_narrative_digest_collision');
    });
    const result = await this.pool.query('SELECT * FROM dream_diary_entries WHERE agent_id=$1 AND entry_date=$2 AND phase=$3 AND narrative_digest=$4 AND narrative=$5', [agentId, entryDate, entryPhase, narrativeDigest, body]);
    return publicRow(result.rows[0]);
  }
  async list(agent, { date: filterDate = null, phase: filterPhase = null, limit = 30 } = {}) {
    const agentId = text(agent); if (!agentId) throw new Error('dream_diary_agent_required');
    const check = await this.pool.query('SELECT id FROM agents WHERE id=$1', [agentId]); if (!check.rows[0]) throw new Error('agent_not_found');
    const d = filterDate ? date(filterDate) : null, p = filterPhase ? phase(filterPhase) : null, n = Math.max(1, Math.min(200, Number(limit) || 30));
    const result = await this.pool.query(`SELECT * FROM dream_diary_entries WHERE agent_id=$1 AND ($2::text IS NULL OR entry_date=$2::text) AND ($3::text IS NULL OR phase=$3::text) ORDER BY entry_date DESC,created_at DESC LIMIT $4`, [agentId, d, p, n]);
    return result.rows.map(publicRow);
  }
  async get(agent, entryId) {
    const agentId = text(agent), id = text(entryId); if (!agentId || !id) throw new Error('dream_diary_entry_required');
    const result = await this.pool.query('SELECT * FROM dream_diary_entries WHERE agent_id=$1 AND id=$2', [agentId, id]); if (!result.rows[0]) throw new Error('dream_diary_entry_not_found'); return publicRow(result.rows[0]);
  }
  async renderMarkdown(agent, options = {}) {
    const entries = await this.list(agent, options), format = text(options.format || options.markdown);
    if (format === 'narrative' || format === 'narrative-only' || format === 'narrative-markdown') return `${entries.flatMap((entry) => [`## ${entry.phase.toUpperCase()}`, '', entry.narrative, '']).join('\n').trim()}\n`;
    const lines = ['# DreamDiary', '', 'Human-readable dream narrative. Not agent authority, not durable truth, and not loaded into runtime prompt context.'];
    for (const entry of entries) { lines.push('', '---', '', `*${entry.entryDate} · ${entry.phase}*`, '', entry.narrative); if (entry.sourceRefs.length) lines.push('', `Sources: ${entry.sourceRefs.join(', ')}`); }
    return `${lines.join('\n')}\n`;
  }
}
export default PostgresDreamDiaryStore;
