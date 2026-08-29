import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { settingsDatabasePath } from './model-settings-store.mjs';

const KINDS = new Set(['decision', 'finding', 'blocker', 'handoff', 'task']);
const STATES = new Set(['active', 'resolved', 'superseded']);
const DEFAULT_TTL_DAYS = 30;
const DEFAULT_ROLLING_CONTINUITY_TTL_DAYS = 30;
const MAX_COMPACT_CONTENT_CHARS = 2_400;

function now() { return new Date().toISOString(); }
function text(value) { return String(value ?? '').trim(); }
function bounded(value, limit) { const source = text(value); return source.length <= limit ? source : source.slice(0, limit).trim(); }
function compactContentOrReject(value, errorCode) {
  const source = text(value);
  if (source.length > MAX_COMPACT_CONTENT_CHARS) throw new Error(errorCode);
  return source;
}
function json(value) { return JSON.stringify(Array.isArray(value) ? value : []); }
function parseJson(value) { try { return JSON.parse(value); } catch { return []; } }
function expiry(days = DEFAULT_TTL_DAYS) { return new Date(Date.now() + Math.max(1, Number(days) || DEFAULT_TTL_DAYS) * 86400_000).toISOString(); }
function ftsQuery(query) { return text(query).match(/[\p{L}\p{N}_-]{2,}/gu)?.map((word) => `"${word.replaceAll('"', '""')}"`).join(' AND ') || ''; }
function warmKey(value = '') { return createHash('sha256').update(text(value).toLowerCase().replace(/\s+/g, ' ')).digest('hex').slice(0, 24); }
function warmTokens(value = '') { return [...new Set(text(value).toLowerCase().split(/[^a-z0-9_-]+/u).filter((token) => token.length >= 4))]; }
function warmSimilarity(left = '', right = '') {
  const a = new Set(warmTokens(left)); const b = new Set(warmTokens(right));
  if (!a.size || !b.size) return 0;
  let shared = 0; for (const token of a) if (b.has(token)) shared += 1;
  return shared / Math.min(a.size, b.size);
}
function sharedWarmRefs(left = [], right = []) {
  const known = new Set((Array.isArray(left) ? left : []).map(text).filter(Boolean));
  return (Array.isArray(right) ? right : []).some((ref) => known.has(text(ref)));
}

function initialize(db) {
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS working_memory (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL,
      project TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('decision','finding','blocker','handoff','task')),
      state TEXT NOT NULL CHECK(state IN ('active','resolved','superseded')) DEFAULT 'active',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source_refs TEXT NOT NULL DEFAULT '[]',
      pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_recalled_at TEXT
    );
    CREATE INDEX IF NOT EXISTS working_memory_scope_idx ON working_memory(agent_id, project, state, expires_at);
    CREATE TABLE IF NOT EXISTS settings_meta (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS working_memory_fts USING fts5(title, content, content='working_memory', content_rowid='rowid');
    CREATE TRIGGER IF NOT EXISTS working_memory_ai AFTER INSERT ON working_memory BEGIN
      INSERT INTO working_memory_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS working_memory_ad AFTER DELETE ON working_memory BEGIN
      INSERT INTO working_memory_fts(working_memory_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
    END;
    CREATE TRIGGER IF NOT EXISTS working_memory_au AFTER UPDATE OF title, content ON working_memory BEGIN
      INSERT INTO working_memory_fts(working_memory_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
      INSERT INTO working_memory_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
    END;
  `);
}

function assertRecord(input = {}) {
  const record = {
    id: text(input.id), agentId: text(input.agentId), sessionId: text(input.sessionId), conversationId: text(input.conversationId), project: text(input.project),
    kind: text(input.kind), state: text(input.state || 'active'), title: text(input.title), content: text(input.content),
    sourceRefs: Array.isArray(input.sourceRefs) ? input.sourceRefs.map(text).filter(Boolean).slice(0, 12) : [], pinned: input.pinned === true,
  };
  if (!record.id) throw new Error('working_memory_id_required');
  for (const key of ['agentId', 'sessionId', 'conversationId', 'project', 'title', 'content']) if (!record[key]) throw new Error(`working_memory_${key}_required`);
  if (!KINDS.has(record.kind)) throw new Error('working_memory_kind_invalid');
  if (!STATES.has(record.state)) throw new Error('working_memory_state_invalid');
  if (record.title.length > 240 || record.content.length > 6000) throw new Error('working_memory_content_too_large');
  return record;
}

function publicRow(row) {
  return row && { id: row.id, agentId: row.agent_id, sessionId: row.session_id, conversationId: row.conversation_id, project: row.project, kind: row.kind, state: row.state, title: row.title, content: row.content, sourceRefs: parseJson(row.source_refs), pinned: Boolean(row.pinned), createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at, lastRecalledAt: row.last_recalled_at || null };
}

export class WorkingMemoryStore {
  constructor({ databasePath } = {}) {
    this.databasePath = databasePath || settingsDatabasePath();
    mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.databasePath);
    chmodSync(this.databasePath, 0o600);
    initialize(this.db);
  }
  close() { this.db.close(); }
  record(input = {}) {
    const item = assertRecord(input); const timestamp = now();
    const existing = this.db.prepare('SELECT * FROM working_memory WHERE id=? AND agent_id=?').get(item.id, item.agentId);
    const sourceRefs = json(item.sourceRefs);
    const material = !existing || [
      existing.session_id !== item.sessionId, existing.conversation_id !== item.conversationId, existing.project !== item.project,
      existing.kind !== item.kind, existing.state !== item.state, existing.title !== item.title, existing.content !== item.content,
      existing.source_refs !== sourceRefs, Boolean(existing.pinned) !== item.pinned,
    ].some(Boolean);
    // Recall never reaches this method. A no-op write also cannot quietly turn
    // into a retention refresh; expiry changes require a material event change
    // or an explicit pin transition.
    const expiresAt = material ? (input.expiresAt || expiry(input.ttlDays)) : existing.expires_at;
    this.db.prepare(`INSERT INTO working_memory (id,agent_id,session_id,conversation_id,project,kind,state,title,content,source_refs,pinned,created_at,updated_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET session_id=excluded.session_id, conversation_id=excluded.conversation_id, project=excluded.project, kind=excluded.kind, state=excluded.state, title=excluded.title, content=excluded.content, source_refs=excluded.source_refs, pinned=excluded.pinned, updated_at=excluded.updated_at, expires_at=excluded.expires_at`)
      .run(item.id, item.agentId, item.sessionId, item.conversationId, item.project, item.kind, item.state, item.title, item.content, sourceRefs, item.pinned ? 1 : 0, timestamp, timestamp, expiresAt);
    return this.get(item.id, item.agentId);
  }
  get(id, agentId) { return publicRow(this.db.prepare('SELECT * FROM working_memory WHERE id=? AND agent_id=?').get(id, agentId)); }
  list({ agentId, project = null, includeInactive = false, limit = 50 } = {}) {
    if (!text(agentId)) throw new Error('working_memory_agent_id_required');
    const rows = this.db.prepare(`SELECT * FROM working_memory
      WHERE agent_id=? AND (? IS NULL OR project=?) AND (pinned=1 OR expires_at>=?) AND (?=1 OR state='active')
      ORDER BY updated_at DESC LIMIT ?`)
      .all(agentId, project || null, project || null, now(), includeInactive ? 1 : 0, Math.max(1, Math.min(100, Number(limit) || 50)));
    return rows.map(publicRow);
  }
  replaceDreamPreload({ agentId, project, items = [], expiresAt } = {}) {
    if (!text(agentId) || !text(project)) throw new Error('dream_preload_scope_required');
    const normalized = (Array.isArray(items) ? items : []).slice(0, 5).map((item) => ({
      id: text(item.id), title: bounded(item.title, 240), content: compactContentOrReject(item.content, 'dream_preload_content_too_large'), sourceRefs: Array.isArray(item.sourceRefs) ? item.sourceRefs.map(text).filter(Boolean).slice(0, 12) : [],
    })).filter((item) => item.id && item.title && item.content && item.sourceRefs.length);
    const timestamp = now();
    const value = JSON.stringify({ version: 1, agentId: text(agentId), project: text(project), items: normalized, expiresAt: text(expiresAt), updatedAt: timestamp });
    this.db.prepare(`INSERT INTO settings_meta (key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .run(`dream-preload:${agentId}:${project}`, value, timestamp);
    return JSON.parse(value);
  }
  getDreamPreload({ agentId, project } = {}) {
    if (!text(agentId) || !text(project)) return null;
    const row = this.db.prepare('SELECT value_json FROM settings_meta WHERE key=?').get(`dream-preload:${agentId}:${project}`);
    if (!row) return null;
    try {
      const value = JSON.parse(row.value_json);
      return value?.expiresAt && value.expiresAt < now() ? null : value;
    } catch { return null; }
  }
  appendDreamLedger({ agentId, project, mode, entries = [] } = {}) {
    if (!text(agentId) || !text(project) || !text(mode)) throw new Error('dream_ledger_scope_required');
    const normalized = (Array.isArray(entries) ? entries : []).slice(0, 32).map((entry) => ({
      action: text(entry.action), candidateKey: text(entry.candidateKey), memoryId: text(entry.memoryId) || null,
      recordId: text(entry.recordId) || null, sourceRefs: Array.isArray(entry.sourceRefs) ? entry.sourceRefs.map(text).filter(Boolean).slice(0, 12) : [],
      reason: bounded(entry.reason, 240) || null, ts: text(entry.ts) || now(),
    })).filter((entry) => entry.action && entry.candidateKey);
    const key = `dream-ledger:${agentId}:${project}`;
    const prior = this.getDreamLedger({ agentId, project })?.entries || [];
    const value = JSON.stringify({ version: 1, agentId: text(agentId), project: text(project), entries: [...normalized, ...prior].slice(0, 100), updatedAt: now() });
    this.db.prepare(`INSERT INTO settings_meta (key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .run(key, value, now());
    return JSON.parse(value);
  }
  getDreamLedger({ agentId, project } = {}) {
    if (!text(agentId) || !text(project)) return null;
    const row = this.db.prepare('SELECT value_json FROM settings_meta WHERE key=?').get(`dream-ledger:${agentId}:${project}`);
    try { return row ? JSON.parse(row.value_json) : null; } catch { return null; }
  }
  supersedeDreamRecords({ agentId, project, keepIds = [] } = {}) {
    if (!text(agentId) || !text(project)) throw new Error('dream_preload_scope_required');
    const keep = new Set((Array.isArray(keepIds) ? keepIds : []).map(text).filter(Boolean));
    const records = this.list({ agentId, project, includeInactive: false, limit: 100 })
      .filter((record) => record.id.startsWith('dream-') && !keep.has(record.id));
    for (const record of records) {
      this.record({
        id: record.id, agentId: record.agentId, sessionId: record.sessionId, conversationId: record.conversationId,
        project: record.project, kind: record.kind, state: 'superseded', title: record.title, content: record.content,
        sourceRefs: record.sourceRefs, pinned: record.pinned, expiresAt: record.expiresAt,
      });
    }
    return records.map((record) => this.get(record.id, agentId));
  }
  replaceDreamScopeReviewQueue({ agentId, mode, candidates = [], expiresAt } = {}) {
    if (!text(agentId)) throw new Error('dream_scope_review_agent_required');
    const normalized = (Array.isArray(candidates) ? candidates : []).slice(0, 8).map((candidate) => ({
      kind: text(candidate.kind || candidate.type), title: bounded(candidate.title, 240), content: compactContentOrReject(candidate.content, 'dream_scope_review_content_too_large'),
      sourceRefs: Array.isArray(candidate.sourceRefs) ? candidate.sourceRefs.map(text).filter(Boolean).slice(0, 12) : [], confidence: Number(candidate.confidence),
    })).filter((candidate) => candidate.kind && candidate.title && candidate.content && candidate.sourceRefs.length && Number.isFinite(candidate.confidence));
    const timestamp = now();
    const value = JSON.stringify({ version: 1, agentId: text(agentId), mode: text(mode), disposition: 'scope_uncertain', items: normalized, expiresAt: text(expiresAt), updatedAt: timestamp });
    this.db.prepare(`INSERT INTO settings_meta (key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .run(`dream-scope-review:${agentId}`, value, timestamp);
    return JSON.parse(value);
  }
  getDreamScopeReviewQueue({ agentId } = {}) {
    if (!text(agentId)) return null;
    const row = this.db.prepare('SELECT value_json FROM settings_meta WHERE key=?').get(`dream-scope-review:${agentId}`);
    if (!row) return null;
    try {
      const value = JSON.parse(row.value_json);
      return value?.expiresAt && value.expiresAt < now() ? null : value;
    } catch { return null; }
  }
  assignDreamScopeReview({ agentId, index, project } = {}) {
    const selectedProject = text(project);
    if (!text(agentId)) throw new Error('dream_scope_review_agent_required');
    if (!['user', 'openclaw', 'Burrow', 'GKD'].includes(selectedProject)) throw new Error('dream_scope_review_project_invalid');
    const queue = this.getDreamScopeReviewQueue({ agentId });
    if (!queue) throw new Error('dream_scope_review_not_found');
    const selectedIndex = Number(index);
    if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= queue.items.length) throw new Error('dream_scope_review_index_invalid');
    const item = queue.items[selectedIndex];
    const id = `dream-${createHash('sha256').update([agentId, selectedProject, item.kind, item.title].join('\u0000')).digest('hex').slice(0, 32)}`;
    const record = this.record({ id, agentId, sessionId: 'dream-scope-review', conversationId: 'dream-scope-review', project: selectedProject, kind: item.kind, state: 'active', title: item.title, content: item.content, sourceRefs: item.sourceRefs, expiresAt: queue.expiresAt });
    const remaining = queue.items.filter((_, itemIndex) => itemIndex !== selectedIndex);
    this.replaceDreamScopeReviewQueue({ agentId, mode: queue.mode, candidates: remaining, expiresAt: queue.expiresAt });
    return { record, assignedIndex: selectedIndex, remainingCount: remaining.length, disposition: 'assigned_local_only' };
  }
  search({ agentId, project = null, query, limit = 5, includeInactive = false } = {}) {
    const match = ftsQuery(query); if (!text(agentId)) throw new Error('working_memory_agent_id_required'); if (!match) return [];
    const rows = this.db.prepare(`SELECT m.*, bm25(working_memory_fts) AS score FROM working_memory_fts JOIN working_memory m ON m.rowid=working_memory_fts.rowid
      WHERE working_memory_fts MATCH ? AND m.agent_id=? AND (? IS NULL OR m.project=?) AND (m.pinned=1 OR m.expires_at>=?) AND (?=1 OR m.state='active') ORDER BY score LIMIT ?`)
      .all(match, agentId, project || null, project || null, now(), includeInactive ? 1 : 0, Math.max(1, Math.min(10, Number(limit) || 5)));
    return rows.map((row) => ({ ...publicRow(row), score: Number(row.score) }));
  }
  upsertRollingContinuityCard({ agentId, project, title, content, sourceRefs = [], evidence = 'conversation', reason = null, ttlDays = DEFAULT_ROLLING_CONTINUITY_TTL_DAYS } = {}) {
    if (!text(agentId) || !text(project) || !text(title)) throw new Error('rolling_continuity_scope_required');
    const key = `rolling-continuity:${text(agentId)}:${text(project)}`;
    const row = this.db.prepare('SELECT value_json FROM settings_meta WHERE key=?').get(key);
    let value = null;
    try { value = row ? JSON.parse(row.value_json) : null; } catch { value = null; }
    const timestamp = now();
    const cards = Array.isArray(value?.cards) ? value.cards : [];
    const incomingRefs = Array.isArray(sourceRefs) ? sourceRefs.map(text).filter(Boolean) : [];
    // A curator may phrase the same thread differently on adjacent turns. Keep
    // one stable card when source lineage overlaps, then use conservative title
    // similarity for later recurrence without shared receipts.
    const existing = cards.find((card) => sharedWarmRefs(card.recentRefs, incomingRefs))
      || cards.find((card) => warmSimilarity(`${card.title || ''} ${card.summary || ''}`, `${title} ${content}`) >= 0.8)
      || null;
    const cardId = existing?.id || `warm:${warmKey(`${agentId}\u0000${project}\u0000${title}`)}`;
    const refs = [...new Set([...(Array.isArray(existing?.recentRefs) ? existing.recentRefs : []), ...incomingRefs])].slice(-20);
    const card = {
      id: cardId,
      agentId: text(agentId),
      project: text(project),
      title: bounded(title, 240),
      summary: compactContentOrReject(content || existing?.summary || '', 'rolling_continuity_summary_too_large'),
      firstSeen: existing?.firstSeen || timestamp,
      lastSeen: timestamp,
      recurrence: Number(existing?.recurrence || 0) + 1,
      recentRefs: refs,
      evidence: bounded(evidence || existing?.evidence || 'conversation', 80),
      reason: bounded(reason, 360) || null,
      expiresAt: expiry(ttlDays),
    };
    const nextCards = [card, ...cards.filter((item) => item.id !== cardId && (!item.expiresAt || item.expiresAt >= timestamp))].slice(0, 100);
    const next = { version: 1, agentId: text(agentId), project: text(project), cards: nextCards, updatedAt: timestamp };
    this.db.prepare(`INSERT INTO settings_meta (key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .run(key, JSON.stringify(next), timestamp);
    return card;
  }
  listRollingContinuityCards({ agentId, project = null, limit = 20 } = {}) {
    if (!text(agentId)) return [];
    if (!text(project)) return this.listAllRollingContinuityCards({ agentId, limit });
    const row = this.db.prepare('SELECT value_json FROM settings_meta WHERE key=?').get(`rolling-continuity:${text(agentId)}:${text(project)}`);
    let value = null;
    try { value = row ? JSON.parse(row.value_json) : null; } catch { value = null; }
    const timestamp = now();
    return (Array.isArray(value?.cards) ? value.cards : [])
      .filter((card) => !card.expiresAt || card.expiresAt >= timestamp)
      .sort((left, right) => String(right.lastSeen || '').localeCompare(String(left.lastSeen || '')) || Number(right.recurrence || 0) - Number(left.recurrence || 0))
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
  }
  listAllRollingContinuityCards({ agentId, limit = 20 } = {}) {
    if (!text(agentId)) return [];
    const rows = this.db.prepare('SELECT value_json FROM settings_meta WHERE key LIKE ?').all(`rolling-continuity:${text(agentId)}:%`);
    const timestamp = now();
    const cards = [];
    for (const row of rows) {
      try {
        for (const card of JSON.parse(row.value_json)?.cards || []) {
          if (card?.agentId === text(agentId) && (!card.expiresAt || card.expiresAt >= timestamp)) cards.push(card);
        }
      } catch {}
    }
    return cards
      .sort((left, right) => String(right.lastSeen || '').localeCompare(String(left.lastSeen || '')) || Number(right.recurrence || 0) - Number(left.recurrence || 0))
      .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
  }
  searchRollingContinuityCards({ agentId, project, query, limit = 5 } = {}) {
    const needle = text(query).toLowerCase();
    if (!needle) return [];
    return this.listRollingContinuityCards({ agentId, project, limit: 100 })
      .map((card) => {
        const haystack = `${card.title || ''} ${card.summary || ''}`.toLowerCase();
        const exact = haystack.includes(needle);
        const tokens = needle.split(/[^a-z0-9_-]+/u).filter((token) => token.length >= 2);
        const hits = tokens.filter((token) => haystack.includes(token)).length;
        const score = (exact ? 100 : 0) + hits * 10 + Math.min(20, Number(card.recurrence || 0));
        return { ...card, score };
      })
      .filter((card) => card.score > 0)
      .sort((left, right) => Number(right.score || 0) - Number(left.score || 0) || String(right.lastSeen || '').localeCompare(String(left.lastSeen || '')))
      .slice(0, Math.max(1, Math.min(20, Number(limit) || 5)));
  }
  listBrainPromotionCandidates({ agentId, status = 'pending', limit = 20 } = {}) {
    if (!text(agentId)) throw new Error('brain_promotion_agent_id_required');
    const row = this.db.prepare('SELECT value_json FROM settings_meta WHERE key=?').get(`brain-promotion-candidates:${agentId}`);
    let entries = [];
    try { entries = row ? JSON.parse(row.value_json)?.entries || [] : []; } catch { entries = []; }
    const wanted = text(status) || 'pending';
    return entries.filter((entry) => wanted === 'all' || entry.status === wanted).slice(0, Math.max(1, Math.min(50, Number(limit) || 20)));
  }
  upsertBrainPromotionCandidate({ agentId, record, reason = null } = {}) {
    if (!text(agentId) || !record?.id) throw new Error('brain_promotion_scope_required');
    if (!['decision', 'finding', 'blocker', 'handoff'].includes(record.kind) || record.state !== 'active') return null;
    const key = `brain-promotion-candidates:${agentId}`;
    const existing = this.listBrainPromotionCandidates({ agentId, status: 'all', limit: 50 });
    const timestamp = now();
    const candidate = {
      id: `brain-candidate:${record.id}`,
      status: 'pending',
      agentId,
      recordId: record.id,
      project: record.project,
      kind: record.kind,
      title: bounded(record.title, 240),
      content: bounded(record.content, 1800),
      sourceRefs: Array.isArray(record.sourceRefs) ? record.sourceRefs.slice(0, 12) : [],
      reason: bounded(reason, 360) || 'STM record may be durable enough for deliberate Brain promotion review.',
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const merged = [candidate, ...existing.filter((entry) => entry.id !== candidate.id)].slice(0, 50);
    this.db.prepare(`INSERT INTO settings_meta (key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .run(key, JSON.stringify({ version: 1, agentId: text(agentId), entries: merged, updatedAt: timestamp }), timestamp);
    return candidate;
  }
  updateBrainPromotionCandidate({ agentId, candidateId, status, reason = null } = {}) {
    if (!text(agentId) || !text(candidateId)) throw new Error('brain_promotion_scope_required');
    const nextStatus = text(status);
    if (!['pending', 'promoted', 'dismissed'].includes(nextStatus)) throw new Error('brain_promotion_status_invalid');
    const key = `brain-promotion-candidates:${agentId}`;
    const entries = this.listBrainPromotionCandidates({ agentId, status: 'all', limit: 50 });
    const timestamp = now();
    let found = null;
    const updated = entries.map((entry) => {
      if (entry.id !== candidateId) return entry;
      found = { ...entry, status: nextStatus, dispositionReason: bounded(reason, 360) || null, updatedAt: timestamp };
      return found;
    });
    if (!found) throw new Error('brain_promotion_candidate_not_found');
    this.db.prepare(`INSERT INTO settings_meta (key,value_json,updated_at) VALUES (?,?,?)
      ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
      .run(key, JSON.stringify({ version: 1, agentId: text(agentId), entries: updated, updatedAt: timestamp }), timestamp);
    return found;
  }
}

export const __test__ = { ftsQuery };
