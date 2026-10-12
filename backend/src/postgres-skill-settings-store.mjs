import {promises as fs} from 'node:fs';
import { PostgresSkillSources, skillLock, skillSourceError } from './postgres-skill-sources.mjs';
import { normalizePostgresPool, withPostgresTransaction, postgresTransactionContext } from './postgres-foundation.mjs';
import { createHash } from 'node:crypto';
export const POSTGRES_OFFICIAL_SKILL_DEFAULT_SQL = `CREATE TABLE official_skill_default_adoptions (skill_id TEXT PRIMARY KEY, adopted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP);`;
export const POSTGRES_SKILL_SETTINGS_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',content TEXT NOT NULL,lifecycle TEXT NOT NULL DEFAULT 'available',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS skill_global_assignments (skill_id TEXT PRIMARY KEY REFERENCES skills(id) ON DELETE CASCADE,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS agent_skill_assignments (agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,created_at TEXT NOT NULL,PRIMARY KEY(agent_id,skill_id));`;
const text = (v) => String(v ?? '');
const stamp = () => new Date().toISOString();
const digest = (v) => `sha256:${createHash('sha256').update(v, 'utf8').digest('hex')}`;
const validId = (v) => { const x = text(v).trim(); if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(x)) throw Object.assign(new Error('skill_id_invalid'), { statusCode: 400 }); return x; };
const life = (v) => { const x = text(v || 'available'); if (!['available', 'experimental', 'deprecated', 'disabled'].includes(x)) throw Object.assign(new Error('skill_lifecycle_invalid'), { statusCode: 400 }); return x; };
const rec = (r) => !r ? null : ({ id: r.id, name: r.name, description: r.description, content: r.content, version: digest(r.content), bytes: Buffer.byteLength(r.content, 'utf8'), lifecycle: r.lifecycle, available: r.lifecycle !== 'disabled', global: Boolean(r.global_assignment), createdAt: r.created_at, updatedAt: r.updated_at, source: r.storage || 'postgres', storage: r.storage || 'postgres', contentOwner: r.content_owner || 'operator', installedPath: r.installed_path || null, installedHash: r.installed_hash || null });
const select = `SELECT s.*, EXISTS(SELECT 1 FROM skill_global_assignments g WHERE g.skill_id=s.id) global_assignment FROM skills s`;
export class PostgresSkillSettingsStore {
 constructor({ pool, clock = stamp } = {}) { if (!pool) throw new Error('pool_required'); this.pool = normalizePostgresPool(pool); this.clock = clock; }
 async list() { const { rows } = await this.pool.query(`${select} ORDER BY s.id`); return rows.map(rec); }
 async get(id) { const { rows } = await this.pool.query(`${select} WHERE s.id=$1`, [text(id)]); return rec(rows[0]); }
 async create(i = {}) { const id = validId(i.id), name = text(i.name || id).trim(), content = text(i.content), description = text(i.description), state = life(i.lifecycle), ts = this.clock(); if (!name) throw Object.assign(new Error('skill_name_required'), { statusCode: 400 }); try { await withPostgresTransaction(this.pool, async (c) => { await c.query('INSERT INTO skills(id,name,description,content,lifecycle,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6)', [id, name, description, content, state, ts]); if (i.global === true) await c.query('INSERT INTO skill_global_assignments(skill_id,created_at) VALUES($1,$2)', [id, ts]); }); } catch (e) { if (e.code === '23505') throw Object.assign(new Error('skill_already_exists'), { statusCode: 409 }); throw e; } return this.get(id); }
 async update(id, i = {}) { const result = await withPostgresTransaction(this.pool, async (c) => { await skillLock(c,text(id)); const { rows } = await c.query(`${select} WHERE s.id=$1 FOR UPDATE`, [text(id)]); const old = rec(rows[0]); if (!old) return null; if (['content','name','description'].some(key => i[key] !== undefined && text(i[key]) !== text(old[key])) && (old.contentOwner !== 'operator' || (await c.query('SELECT 1 FROM skill_git_sources WHERE skill_id=$1',[old.id])).rowCount)) throw skillSourceError('skill_content_upstream_managed',409); const name = i.name === undefined ? old.name : text(i.name).trim(); if (!name) throw Object.assign(new Error('skill_name_required'), { statusCode: 400 }); await c.query('UPDATE skills SET name=$1,description=$2,content=$3,lifecycle=$4,updated_at=$5 WHERE id=$6', [name, i.description === undefined ? old.description : text(i.description), i.content === undefined ? old.content : text(i.content), i.lifecycle === undefined ? old.lifecycle : life(i.lifecycle), this.clock(), old.id]); if (i.global !== undefined) { if (i.global === true) await c.query('INSERT INTO skill_global_assignments(skill_id,created_at) VALUES($1,$2) ON CONFLICT DO NOTHING', [old.id, this.clock()]); else await c.query('DELETE FROM skill_global_assignments WHERE skill_id=$1', [old.id]); } return old.id; }); return result === null ? null : this.get(result); }
 async publishBundled(id,i) { return withPostgresTransaction(this.pool,async c=>{await skillLock(c,id);if((await c.query('SELECT 1 FROM skill_git_sources WHERE skill_id=$1',[id])).rowCount)return false;await c.query("UPDATE skills SET content_owner='bundled',name=$2,description=$3,content=$4,updated_at=$5 WHERE id=$1",[id,i.name,i.description,i.content,this.clock()]);return true;}); }
 /** One-time, offline adoption of the official runtime source. The fallback and source
  * are committed together; an operator detach is never silently undone on reboot. */
 async adoptOfficialRuntime(i) {
  const id='burrow-runtime', ts=this.clock();
  return withPostgresTransaction(this.pool, async c=>{
   await skillLock(c,id);
   if ((await c.query('SELECT 1 FROM official_skill_default_adoptions WHERE skill_id=$1',[id])).rowCount) return false;
   const old=(await c.query('SELECT id,content_owner FROM skills WHERE id=$1 FOR UPDATE',[id])).rows[0];
   const source=(await c.query('SELECT 1 FROM skill_git_sources WHERE skill_id=$1',[id])).rowCount>0;
   if (!old) {
    await c.query('INSERT INTO skills(id,name,description,content,lifecycle,content_owner,created_at,updated_at) VALUES($1,$2,$3,$4,\'available\',\'bundled\',$5,$5)',[id,i.name,i.description,i.content,ts]);
    await c.query('INSERT INTO skill_global_assignments(skill_id,created_at) VALUES($1,$2)',[id,ts]);
   } else if (old.content_owner==='bundled' && !source) {
    await c.query('UPDATE skills SET name=$2,description=$3,content=$4,updated_at=$5 WHERE id=$1',[id,i.name,i.description,i.content,ts]);
   }
   // Operator-owned IDs are not converted into upstream-managed instructions.
   if (!source && (!old || old.content_owner==='bundled')) {
    await new PostgresSkillSources({pool:postgresTransactionContext(c),clock:this.clock}).save(id,{repository:'https://github.com/NightShaman/Burrow-Skills.git',ref:'main',path:'burrow-runtime/SKILL.md',enabled:true,cron:'0 */6 * * *'});
   }
   // An already configured source (including disabled) is intentionally untouched.
   await c.query('INSERT INTO official_skill_default_adoptions(skill_id) VALUES($1)',[id]);
   return true;
  });
 }
 async delete(id) { return withPostgresTransaction(this.pool,async c=>{await skillLock(c,text(id));const installed=(await c.query('SELECT installed_path FROM skills WHERE id=$1',[text(id)])).rows[0]?.installed_path;if(installed)await fs.utimes(installed,new Date(this.clock()),new Date(this.clock())).catch(()=>{});const r=await c.query('DELETE FROM skills WHERE id=$1',[text(id)]);return r.rowCount>0;}); }
 async setGlobal(id, on) { if (!await this.get(id)) throw Object.assign(new Error('skill_not_found'), { statusCode: 404 }); if (on) await this.pool.query('INSERT INTO skill_global_assignments(skill_id,created_at) VALUES($1,$2) ON CONFLICT DO NOTHING', [text(id), this.clock()]); else await this.pool.query('DELETE FROM skill_global_assignments WHERE skill_id=$1', [text(id)]); }
 async assignments(agentId) { const [a, g] = await Promise.all([this.pool.query('SELECT skill_id FROM agent_skill_assignments WHERE agent_id=$1 ORDER BY skill_id', [text(agentId)]), this.pool.query('SELECT skill_id FROM skill_global_assignments')]); const assigned = a.rows.map(r => r.skill_id), global = g.rows.map(r => r.skill_id); return { agentId: text(agentId), assignedSkillIds: assigned, globalSkillIds: global, effectiveSkillIds: [...new Set([...global, ...assigned])].sort() }; }
 async effective(agentId) { const { rows } = await this.pool.query(`${select} WHERE EXISTS (SELECT 1 FROM skill_global_assignments g WHERE g.skill_id=s.id) OR EXISTS (SELECT 1 FROM agent_skill_assignments a WHERE a.skill_id=s.id AND a.agent_id=$1) ORDER BY s.id`, [text(agentId)]); return rows.map(rec); }
 async replaceAssignments(agentId, ids = []) { const agent = text(agentId).trim(); if (!agent) throw Object.assign(new Error('agent_id_required'), { statusCode: 400 }); const skills = [...new Set((Array.isArray(ids) ? ids : []).map(validId))]; await withPostgresTransaction(this.pool, async (c) => { const { rows: agents } = await c.query('SELECT 1 FROM agents WHERE id=$1 FOR UPDATE', [agent]); if (!agents.length) throw Object.assign(new Error('agent_not_found'), { statusCode: 404 }); const { rows: knownRows } = await c.query('SELECT id FROM skills'); const known = new Set(knownRows.map(row => row.id)); const missing = skills.filter(x => !known.has(x)); if (missing.length) throw Object.assign(new Error(`skill_not_found:${missing.join(',')}`), { statusCode: 400 }); await c.query('DELETE FROM agent_skill_assignments WHERE agent_id=$1', [agent]); for (const skillId of skills) await c.query('INSERT INTO agent_skill_assignments(agent_id,skill_id,created_at) VALUES($1,$2,$3)', [agent, skillId, this.clock()]); }); return this.assignments(agent); }
}
export default PostgresSkillSettingsStore;
