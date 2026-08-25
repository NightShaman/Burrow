import { openSettingsDatabase, settingsDatabasePath } from './settings-database.mjs';

export const AGENT_PROFILE_KINDS = Object.freeze(['SOUL', 'RULES', 'ORIENTATION', 'TOOLS', 'DREAM_MEMORY']);
const PROFILE_KIND_NAMES = Object.freeze({ DREAMMEMORY: 'DREAM_MEMORY' });
const MAX_DOCUMENT_CHARS = 48_000;
const text = (value) => String(value ?? '').trim();
const now = () => new Date().toISOString();

function agentId(value) {
  const result = text(value);
  if (!/^[A-Za-z0-9._-]{1,96}$/.test(result)) throw new Error('agent_id_invalid');
  return result;
}

function kind(value) {
  const result = PROFILE_KIND_NAMES[text(value).toUpperCase()] || text(value).toUpperCase();
  if (!AGENT_PROFILE_KINDS.includes(result)) throw new Error('agent_profile_kind_invalid');
  return result;
}

function markdown(value) {
  if (typeof value !== 'string') throw new Error('agent_profile_markdown_required');
  if (value.length > MAX_DOCUMENT_CHARS) throw new Error('agent_profile_markdown_too_large');
  return value.trim();
}

function document(row) {
  return row && {
    kind: row.kind,
    markdown: row.markdown,
    format: 'markdown',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class AgentProfileStore {
  constructor({ databasePath } = {}) {
    this.databasePath = databasePath || settingsDatabasePath();
    this.db = openSettingsDatabase({ databasePath: this.databasePath });
  }
  close() { this.db.close(); }
  list(agent) {
    const id = agentId(agent);
    if (!this.db.prepare('SELECT id FROM agents WHERE id=?').get(id)) throw new Error('agent_not_found');
    return this.db.prepare(`SELECT kind,markdown,created_at,updated_at FROM agent_profile_documents
      WHERE agent_id=? ORDER BY CASE kind WHEN 'SOUL' THEN 0 WHEN 'RULES' THEN 1 WHEN 'ORIENTATION' THEN 2 WHEN 'TOOLS' THEN 3 WHEN 'DREAM_MEMORY' THEN 4 END`).all(id).map(document);
  }
  get(agent, documentKind) {
    return document(this.db.prepare('SELECT kind,markdown,created_at,updated_at FROM agent_profile_documents WHERE agent_id=? AND kind=?').get(agentId(agent), kind(documentKind)));
  }
  replace(agent, documents = []) {
    const id = agentId(agent);
    const normalized = (Array.isArray(documents) ? documents : []).map((item) => ({ kind: kind(item?.kind), markdown: markdown(item?.markdown) }));
    if (normalized.length !== AGENT_PROFILE_KINDS.length || new Set(normalized.map((item) => item.kind)).size !== AGENT_PROFILE_KINDS.length) throw new Error('agent_profile_documents_complete_set_required');
    if (!this.db.prepare('SELECT id FROM agents WHERE id=?').get(id)) throw new Error('agent_not_found');
    const timestamp = now();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const upsert = this.db.prepare(`INSERT INTO agent_profile_documents (agent_id,kind,markdown,created_at,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(agent_id,kind) DO UPDATE SET markdown=excluded.markdown,updated_at=excluded.updated_at`);
      for (const item of normalized) upsert.run(id, item.kind, item.markdown, timestamp, timestamp);
      this.db.exec('COMMIT');
      return this.list(id);
    } catch (error) { try { this.db.exec('ROLLBACK'); } catch {} throw error; }
  }
  ensure(agent, documents = []) {
    const id = agentId(agent);
    if (this.list(id).length === AGENT_PROFILE_KINDS.length) return this.list(id);
    const byKind = new Map((Array.isArray(documents) ? documents : []).map((item) => [String(item?.kind || '').toUpperCase(), String(item?.markdown || '')]));
    return this.replace(id, AGENT_PROFILE_KINDS.map((documentKind) => ({ kind: documentKind, markdown: byKind.get(documentKind) || '' })));
  }
  replaceTools(agent, value) {
    return this.replaceSingle(agent, 'TOOLS', value);
  }
  replaceDreamMemory(agent, value) {
    return this.replaceSingle(agent, 'DREAM_MEMORY', value);
  }
  replaceSingle(agent, documentKind, value) {
    const id = agentId(agent);
    const normalizedKind = kind(documentKind);
    const content = markdown(value);
    if (!this.db.prepare('SELECT id FROM agents WHERE id=?').get(id)) throw new Error('agent_not_found');
    const timestamp = now();
    this.db.prepare(`INSERT INTO agent_profile_documents (agent_id,kind,markdown,created_at,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(agent_id,kind) DO UPDATE SET markdown=excluded.markdown,updated_at=excluded.updated_at`).run(id, normalizedKind, content, timestamp, timestamp);
    return this.get(id, normalizedKind);
  }
}

export function profileFilesFromDocuments(documents = [], { agentId: owningAgentId = null } = {}) {
  const byKind = new Map((Array.isArray(documents) ? documents : []).map((item) => [item.kind, item]));
  const files = AGENT_PROFILE_KINDS.map((documentKind) => byKind.get(documentKind)).filter(Boolean).map((item) => {
    const displayName = item.kind === 'DREAM_MEMORY' ? 'DreamMemory' : item.kind;
    return { id: displayName.toLowerCase(), name: `${displayName}.md`, path: `sqlite:agent_profile_documents/${owningAgentId || 'agent'}/${item.kind}`, content: item.markdown, chars: item.markdown.length };
  });
  return { profileDir: 'sqlite:agent_profile_documents', files, chars: files.reduce((total, file) => total + file.chars, 0) };
}

export const __agentProfileStore = Object.freeze({ MAX_DOCUMENT_CHARS });
