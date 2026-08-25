import { createHash, randomUUID } from 'node:crypto';
import { openSettingsDatabase, settingsDatabasePath } from './settings-database.mjs';

const MAX_NARRATIVE_CHARS = 12_000;
const MAX_SOURCE_REFS = 16;
const PHASES = new Set(['light', 'rem', 'deep', 'manual']);

function text(value) { return String(value ?? '').trim(); }
function now() { return new Date().toISOString(); }
function jsonArray(value) { return JSON.stringify(Array.isArray(value) ? value : []); }
function parseJsonArray(value) { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
function entryDate(value) {
  const result = text(value) || now().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result)) throw new Error('dream_diary_entry_date_invalid');
  return result;
}
function phase(value) {
  const result = text(value || 'manual').toLowerCase();
  if (!PHASES.has(result)) throw new Error('dream_diary_phase_invalid');
  return result;
}
function boundedNarrative(value) {
  const result = text(value);
  if (!result) throw new Error('dream_diary_narrative_required');
  if (result.length > MAX_NARRATIVE_CHARS) throw new Error('dream_diary_narrative_too_large');
  return result;
}
function sourceRefs(value) {
  return (Array.isArray(value) ? value : []).map(text).filter(Boolean).slice(0, MAX_SOURCE_REFS);
}
function makeId({ agentId, date, phaseName, narrative }) {
  const digest = createHash('sha256').update([agentId, date, phaseName, narrative].join('\u0000')).digest('hex').slice(0, 24);
  return `dream-diary-${digest}`;
}
function row(row) {
  return row && {
    id: row.id,
    agentId: row.agent_id,
    entryDate: row.entry_date,
    phase: row.phase,
    narrative: row.narrative,
    sourceRefs: parseJsonArray(row.source_refs),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class DreamDiaryStore {
  constructor({ databasePath } = {}) {
    this.db = openSettingsDatabase({ databasePath: databasePath || settingsDatabasePath() });
  }
  close() { this.db.close(); }
  append(agent, input = {}) {
    const agentId = text(agent || input.agentId);
    if (!agentId) throw new Error('dream_diary_agent_required');
    if (!this.db.prepare('SELECT id FROM agents WHERE id=?').get(agentId)) throw new Error('agent_not_found');
    const date = entryDate(input.entryDate || input.date);
    const phaseName = phase(input.phase);
    const narrative = boundedNarrative(input.narrative || input.markdown || input.content);
    const refs = sourceRefs(input.sourceRefs);
    const timestamp = now();
    const id = text(input.id) || makeId({ agentId, date, phaseName, narrative }) || randomUUID();
    this.db.prepare(`INSERT INTO dream_diary_entries (id,agent_id,entry_date,phase,narrative,source_refs,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?)
      ON CONFLICT(agent_id,entry_date,phase,narrative) DO UPDATE SET source_refs=excluded.source_refs, updated_at=excluded.updated_at`)
      .run(id, agentId, date, phaseName, narrative, jsonArray(refs), timestamp, timestamp);
    return row(this.db.prepare('SELECT * FROM dream_diary_entries WHERE agent_id=? AND entry_date=? AND phase=? AND narrative=?').get(agentId, date, phaseName, narrative));
  }
  list(agent, { date = null, phase: phaseFilter = null, limit = 30 } = {}) {
    const agentId = text(agent);
    if (!agentId) throw new Error('dream_diary_agent_required');
    if (!this.db.prepare('SELECT id FROM agents WHERE id=?').get(agentId)) throw new Error('agent_not_found');
    const normalizedDate = date ? entryDate(date) : null;
    const normalizedPhase = phaseFilter ? phase(phaseFilter) : null;
    return this.db.prepare(`SELECT * FROM dream_diary_entries
      WHERE agent_id=? AND (? IS NULL OR entry_date=?) AND (? IS NULL OR phase=?)
      ORDER BY entry_date DESC, created_at DESC LIMIT ?`)
      .all(agentId, normalizedDate, normalizedDate, normalizedPhase, normalizedPhase, Math.max(1, Math.min(200, Number(limit) || 30))).map(row);
  }
  get(agent, entryId) {
    const agentId = text(agent);
    const id = text(entryId);
    if (!agentId || !id) throw new Error('dream_diary_entry_required');
    const entry = row(this.db.prepare('SELECT * FROM dream_diary_entries WHERE agent_id=? AND id=?').get(agentId, id));
    if (!entry) throw new Error('dream_diary_entry_not_found');
    return entry;
  }
  renderMarkdown(agent, options = {}) {
    const entries = this.list(agent, options);
    const format = text(options.format || options.markdown);
    if (format === 'narrative' || format === 'narrative-only' || format === 'narrative-markdown') {
      const lines = [];
      for (const entry of entries) lines.push(`## ${entry.phase.toUpperCase()}`, '', entry.narrative, '');
      return `${lines.join('\n').trim()}\n`;
    }
    const lines = ['# DreamDiary', '', 'Human-readable dream narrative. Not agent authority, not durable truth, and not loaded into runtime prompt context.'];
    for (const entry of entries) {
      lines.push('', '---', '', `*${entry.entryDate} · ${entry.phase}*`, '', entry.narrative);
      if (entry.sourceRefs.length) lines.push('', `Sources: ${entry.sourceRefs.join(', ')}`);
    }
    return `${lines.join('\n')}\n`;
  }
}
