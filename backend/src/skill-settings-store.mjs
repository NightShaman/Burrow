import { createHash } from 'node:crypto';
import { openSettingsDatabase } from './settings-database.mjs';

function timestamp() { return new Date().toISOString(); }
function text(value) { return String(value ?? ''); }
function hash(content) { return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`; }
function id(value) {
  const normalized = text(value).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(normalized)) throw Object.assign(new Error('skill_id_invalid'), { statusCode: 400 });
  return normalized;
}
function lifecycle(value = 'available') {
  const normalized = text(value || 'available');
  if (!['available', 'experimental', 'deprecated', 'disabled'].includes(normalized)) throw Object.assign(new Error('skill_lifecycle_invalid'), { statusCode: 400 });
  return normalized;
}
function record(row) {
  if (!row) return null;
  return { id: row.id, name: row.name, description: row.description, content: row.content, version: hash(row.content), bytes: Buffer.byteLength(row.content, 'utf8'), lifecycle: row.lifecycle, available: row.lifecycle !== 'disabled', global: Boolean(row.global_assignment), createdAt: row.created_at, updatedAt: row.updated_at, source: 'sqlite' };
}

export class SkillSettingsStore {
  constructor({ databasePath, db = null } = {}) { this.db = db || openSettingsDatabase({ databasePath }); this.ownsDb = !db; }
  close() { if (this.ownsDb) this.db.close(); }
  list() { return this.db.prepare(`SELECT s.*, EXISTS(SELECT 1 FROM skill_global_assignments g WHERE g.skill_id=s.id) global_assignment FROM skills s ORDER BY s.id`).all().map(record); }
  get(skillId) { return record(this.db.prepare(`SELECT s.*, EXISTS(SELECT 1 FROM skill_global_assignments g WHERE g.skill_id=s.id) global_assignment FROM skills s WHERE s.id=?`).get(text(skillId))); }
  create(input = {}) {
    const skillId = id(input.id); const name = text(input.name || skillId).trim(); const content = text(input.content); const description = text(input.description); const state = lifecycle(input.lifecycle); const now = timestamp();
    if (!name) throw Object.assign(new Error('skill_name_required'), { statusCode: 400 });
    try { this.db.prepare('INSERT INTO skills(id,name,description,content,lifecycle,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(skillId, name, description, content, state, now, now); }
    catch (error) { if (/UNIQUE|PRIMARY KEY/.test(error.message)) throw Object.assign(new Error('skill_already_exists'), { statusCode: 409 }); throw error; }
    if (input.global === true) this.db.prepare('INSERT INTO skill_global_assignments(skill_id,created_at) VALUES(?,?)').run(skillId, now);
    return this.get(skillId);
  }
  update(skillId, input = {}) {
    const existing = this.get(skillId); if (!existing) return null;
    const name = input.name === undefined ? existing.name : text(input.name).trim();
    if (!name) throw Object.assign(new Error('skill_name_required'), { statusCode: 400 });
    this.db.prepare('UPDATE skills SET name=?,description=?,content=?,lifecycle=?,updated_at=? WHERE id=?').run(name, input.description === undefined ? existing.description : text(input.description), input.content === undefined ? existing.content : text(input.content), input.lifecycle === undefined ? existing.lifecycle : lifecycle(input.lifecycle), timestamp(), existing.id);
    if (input.global !== undefined) this.setGlobal(existing.id, input.global === true);
    return this.get(existing.id);
  }
  delete(skillId) { return this.db.prepare('DELETE FROM skills WHERE id=?').run(text(skillId)).changes > 0; }
  setGlobal(skillId, enabled) { if (!this.get(skillId)) throw Object.assign(new Error('skill_not_found'), { statusCode: 404 }); if (enabled) this.db.prepare('INSERT INTO skill_global_assignments(skill_id,created_at) VALUES(?,?) ON CONFLICT(skill_id) DO NOTHING').run(text(skillId), timestamp()); else this.db.prepare('DELETE FROM skill_global_assignments WHERE skill_id=?').run(text(skillId)); }
  assignments(agentId) {
    const assigned = new Set(this.db.prepare('SELECT skill_id FROM agent_skill_assignments WHERE agent_id=? ORDER BY skill_id').all(text(agentId)).map(row => row.skill_id));
    const global = new Set(this.db.prepare('SELECT skill_id FROM skill_global_assignments').all().map(row => row.skill_id));
    return { agentId: text(agentId), assignedSkillIds: [...assigned], globalSkillIds: [...global], effectiveSkillIds: [...new Set([...global, ...assigned])].sort() };
  }
  replaceAssignments(agentId, skillIds = []) {
    const agent = text(agentId).trim(); if (!agent) throw Object.assign(new Error('agent_id_required'), { statusCode: 400 });
    const ids = [...new Set((Array.isArray(skillIds) ? skillIds : []).map(id))];
    if (!this.db.prepare('SELECT 1 FROM agents WHERE id=?').get(agent)) throw Object.assign(new Error('agent_not_found'), { statusCode: 404 });
    const known = new Set(this.list().map(skill => skill.id));
    const missing = ids.filter(skillId => !known.has(skillId)); if (missing.length) throw Object.assign(new Error(`skill_not_found:${missing.join(',')}`), { statusCode: 400 });
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('DELETE FROM agent_skill_assignments WHERE agent_id=?').run(agent); const insert = this.db.prepare('INSERT INTO agent_skill_assignments(agent_id,skill_id,created_at) VALUES(?,?,?)'); for (const skillId of ids) insert.run(agent, skillId, timestamp()); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.assignments(agent);
  }
  effective(agentId) {
    return this.db.prepare(`SELECT s.*, EXISTS(SELECT 1 FROM skill_global_assignments g WHERE g.skill_id=s.id) global_assignment FROM skills s WHERE EXISTS(SELECT 1 FROM skill_global_assignments g WHERE g.skill_id=s.id) OR EXISTS(SELECT 1 FROM agent_skill_assignments a WHERE a.skill_id=s.id AND a.agent_id=?) ORDER BY s.id`).all(text(agentId)).map(record);
  }
}
