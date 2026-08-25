import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import path from 'node:path';

const MAX_TITLE_CHARS = 240;
const MAX_EVIDENCE_SUMMARY_CHARS = 480;
const MAX_HANDOFF_CONTENT_CHARS = 24_000;
const DEFAULT_TTL_DAYS = 14;

function now() { return new Date().toISOString(); }
function text(value) { return String(value ?? '').trim(); }
function bounded(value, limit) { const source = text(value); return source.length <= limit ? source : source.slice(0, limit).trim(); }
function contentOrReject(value) {
  const source = text(value);
  if (source.length > MAX_HANDOFF_CONTENT_CHARS) throw new Error('continuity_handoff_content_too_large');
  return source;
}
function expiry(days = DEFAULT_TTL_DAYS) { return new Date(Date.now() + Math.max(1, Number(days) || DEFAULT_TTL_DAYS) * 86_400_000).toISOString(); }

function initialize(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS continuity_handoffs (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'runtime',
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source_refs TEXT NOT NULL,
      evidence_summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);
  const columns = db.prepare('PRAGMA table_info(continuity_handoffs)').all().map((column) => column.name);
  if (!columns.includes('source')) db.exec("ALTER TABLE continuity_handoffs ADD COLUMN source TEXT NOT NULL DEFAULT 'runtime'");
  // Older databases used run-specific IDs for explicit writes. Infer their
  // provenance so they remain readable during the ID migration.
  db.exec("UPDATE continuity_handoffs SET source='explicit' WHERE source='runtime' AND id LIKE 'continuity:%:%:%'");
  db.exec('CREATE INDEX IF NOT EXISTS continuity_handoffs_agent_idx ON continuity_handoffs(agent_id, expires_at, updated_at)');
}

function parseRefs(value) { try { return JSON.parse(value); } catch { return []; } }
export function publicRecord(row) {
  return row && {
    version: 1,
    kind: 'continuity_handoff',
    id: row.id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    runId: row.run_id,
    source: row.source || 'runtime',
    title: row.title,
    content: row.content,
    contentChars: String(row.content || '').length,
    contentComplete: true,
    sourceRefs: parseRefs(row.source_refs),
    evidenceSummary: row.evidence_summary,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at,
  };
}

function validate(record = {}) {
  const sourceRefs = [...new Set((Array.isArray(record.sourceRefs) ? record.sourceRefs : []).map(text).filter(Boolean))].slice(0, 8);
  const value = {
    id: text(record.id), agentId: text(record.agentId), sessionId: text(record.sessionId), runId: text(record.runId), source: text(record.source) || 'runtime',
    title: bounded(record.title, MAX_TITLE_CHARS), content: contentOrReject(record.content),
    sourceRefs, evidenceSummary: bounded(record.evidenceSummary, MAX_EVIDENCE_SUMMARY_CHARS), expiresAt: text(record.expiresAt) || expiry(record.ttlDays),
  };
  for (const key of ['id', 'agentId', 'sessionId', 'runId', 'title', 'content', 'evidenceSummary']) if (!value[key]) throw new Error(`continuity_handoff_${key}_required`);
  if (!value.sourceRefs.length) throw new Error('continuity_handoff_source_refs_required');
  if (Number.isNaN(Date.parse(value.expiresAt))) throw new Error('continuity_handoff_expiry_invalid');
  return value;
}

export class ContinuityHandoffStore {
  constructor({ dataRoot, databasePath } = {}) {
    if (!databasePath && !text(dataRoot)) throw new Error('continuity_handoff_data_root_required');
    this.databasePath = databasePath || path.join(path.resolve(dataRoot), 'continuity-handoffs.sqlite');
    mkdirSync(path.dirname(this.databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.databasePath);
    this.db.exec('PRAGMA busy_timeout = 5000;');
    chmodSync(this.databasePath, 0o600);
    initialize(this.db);
  }
  close() { this.db.close(); }
  upsert(record = {}) {
    const value = validate(record);
    const timestamp = now();
    const existing = this.db.prepare('SELECT * FROM continuity_handoffs WHERE id=?').get(value.id);
    // An automatic curation pass must not erase a more deliberate explicit
    // handoff written earlier in the same session.
    if (existing?.source === 'explicit' && value.source === 'runtime') return publicRecord(existing);
    this.db.prepare(`INSERT INTO continuity_handoffs (id,agent_id,session_id,run_id,source,title,content,source_refs,evidence_summary,created_at,updated_at,expires_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET run_id=excluded.run_id,source=excluded.source,title=excluded.title,content=excluded.content,source_refs=excluded.source_refs,evidence_summary=excluded.evidence_summary,updated_at=excluded.updated_at,expires_at=excluded.expires_at`)
      .run(value.id, value.agentId, value.sessionId, value.runId, value.source, value.title, value.content, JSON.stringify(value.sourceRefs), value.evidenceSummary, timestamp, timestamp, value.expiresAt);
    // Storage retention is owned solely by each handoff's expiry. Read paths
    // apply their own non-destructive context/display limits.
    this.db.prepare('DELETE FROM continuity_handoffs WHERE expires_at<?').run(timestamp);
    return publicRecord(this.db.prepare('SELECT * FROM continuity_handoffs WHERE id=?').get(value.id));
  }
  list({ agentId, limit = 3 } = {}) {
    if (!text(agentId)) throw new Error('continuity_handoff_agent_id_required');
    return this.db.prepare(`SELECT * FROM continuity_handoffs WHERE agent_id=? AND expires_at>=? ORDER BY updated_at DESC LIMIT ?`)
      .all(text(agentId), now(), Math.max(1, Math.min(5, Number(limit) || 3))).map(publicRecord);
  }
  get({ agentId, sessionId } = {}) {
    if (!text(agentId) || !text(sessionId)) return null;
    return publicRecord(this.db.prepare(`SELECT * FROM continuity_handoffs WHERE agent_id=? AND session_id=? AND expires_at>=?`)
      .get(text(agentId), text(sessionId), now()));
  }
  getRecent({ agentId, sessionId = null } = {}) {
    if (!text(agentId)) return null;
    return publicRecord(this.db.prepare(`SELECT * FROM continuity_handoffs
      WHERE agent_id=? AND expires_at>=?
      ORDER BY CASE WHEN source='explicit' THEN 0 ELSE 1 END,
        CASE WHEN session_id=? THEN 0 ELSE 1 END,
        updated_at DESC LIMIT 1`)
      .get(text(agentId), now(), text(sessionId)));
  }
}

export function listContinuityHandoffs({ dataRoot, agentId, limit = 3 } = {}) {
  const databasePath = path.join(path.resolve(text(dataRoot)), 'continuity-handoffs.sqlite');
  if (!text(dataRoot) || !existsSync(databasePath)) return [];
  const store = new ContinuityHandoffStore({ databasePath });
  try { return store.list({ agentId, limit }); } finally { store.close(); }
}

export function buildContinuityHandoff({ agentId, sessionId, runId, message = '', answerText = '', toolResults = [], curated = null } = {}) {
  const user = text(message);
  const answer = text(answerText);
  const successful = (Array.isArray(toolResults) ? toolResults : []).filter((result) => result?.ok === true);
  // This is support context rather than durable memory. Avoid replacing useful
  // handoffs with greetings or acknowledgements, but retain substantive
  // non-tool conversations such as planning and troubleshooting.
  if (!user || !answer || (!successful.length && user.length + answer.length < 240)) return null;
  const actions = successful.slice(0, 6).map((result) => text(result.tool || result.label || 'tool')).filter(Boolean);
  return {
    id: `continuity:${text(agentId)}:${text(sessionId)}`,
    agentId, sessionId, runId, source: 'runtime',
    title: bounded(curated?.title || user.replace(/\s+/g, ' '), 180),
    content: curated?.content
      ? `User goal/request:\n${user}\n\nHandoff:\n${text(curated.content)}`
      : `User goal/request:\n${user}\n\nLatest outcome:\n${answer}`,
    sourceRefs: [`session:${text(sessionId)}`, `run:${text(runId)}`],
    evidenceSummary: actions.length ? `Successful runtime actions: ${[...new Set(actions)].join(', ')}` : 'Conversation-backed continuity; verify live state before relying on claims.',
    ttlDays: DEFAULT_TTL_DAYS,
  };
}
