import { normalizePostgresPool, withPostgresTransaction } from './postgres-foundation.mjs';
import { parseCron, nextCronOccurrence } from './scheduled-job-store.mjs';
import { validateGitSkillSource } from './git-skill-fetch.mjs';

export const POSTGRES_SKILL_SOURCES_SQL = `
ALTER TABLE skills ADD COLUMN storage TEXT NOT NULL DEFAULT 'postgres' CHECK(storage IN ('postgres','filesystem'));
ALTER TABLE skills ADD COLUMN content_owner TEXT NOT NULL DEFAULT 'operator' CHECK(content_owner IN ('operator','bundled','git'));
ALTER TABLE skills ADD COLUMN installed_path TEXT;
ALTER TABLE skills ADD COLUMN installed_hash TEXT;
CREATE TABLE skill_package_files (
 skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE, file_path TEXT NOT NULL, bytes BIGINT NOT NULL, executable BOOLEAN NOT NULL DEFAULT FALSE, PRIMARY KEY(skill_id,file_path)
);
CREATE TABLE skill_git_sources (
 skill_id TEXT PRIMARY KEY REFERENCES skills(id) ON DELETE CASCADE,
 repository TEXT NOT NULL, git_ref TEXT NOT NULL, skill_path TEXT NOT NULL,
 enabled BOOLEAN NOT NULL DEFAULT FALSE, cron_expression TEXT, timezone TEXT NOT NULL DEFAULT 'UTC',
 fetch_timeout_ms INTEGER NOT NULL DEFAULT 120000 CHECK(fetch_timeout_ms > 0),
 next_sync_at TIMESTAMPTZ, last_checked_at TIMESTAMPTZ, last_success_at TIMESTAMPTZ,
 installed_revision TEXT, observed_revision TEXT, last_error TEXT,
 sync_token TEXT, sync_expires_at TIMESTAMPTZ,
 created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE skill_sync_history (
 sequence BIGSERIAL PRIMARY KEY, skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
 status TEXT NOT NULL CHECK(status IN ('updated','unchanged','failed')),
 revision TEXT, content_hash TEXT, error TEXT, installed_path TEXT,
 started_at TIMESTAMPTZ NOT NULL, completed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX skill_sync_history_skill_sequence ON skill_sync_history(skill_id,sequence DESC);
CREATE INDEX skill_git_sources_due ON skill_git_sources(next_sync_at) WHERE enabled;
`;
export function skillSourceRow(r) { return r ? {
 skillId:r.skill_id, type:'git', repository:r.repository, ref:r.git_ref, path:r.skill_path,
 enabled:r.enabled, cron:r.cron_expression, timezone:r.timezone, fetchTimeoutMs:r.fetch_timeout_ms,
 nextSyncAt:r.next_sync_at, lastCheckedAt:r.last_checked_at, lastSuccessAt:r.last_success_at,
 installedRevision:r.installed_revision, observedRevision:r.observed_revision, lastError:r.last_error,
 syncing:Boolean(r.sync_token && Date.parse(r.sync_expires_at)>Date.now()), syncExpiresAt:r.sync_expires_at,
 createdAt:r.created_at, updatedAt:r.updated_at,
} : null; }
export const skillSourceError = (code, statusCode = 400) => Object.assign(new Error(code), {statusCode});
export async function skillLock(client,id,{tryOnly=false}={}) {
 const {rows}=await client.query(`SELECT ${tryOnly?'pg_try_advisory_xact_lock':'pg_advisory_xact_lock'}(hashtextextended($1,0)) AS locked`,['skill:'+id]);
 if(tryOnly && !rows[0].locked) throw skillSourceError('skill_sync_running',409);
}
export class PostgresSkillSources {
 constructor({pool,clock=()=>new Date().toISOString()}={}) {this.pool=normalizePostgresPool(pool);this.clock=clock;}
 async get(id,client=this.pool) {return skillSourceRow((await client.query('SELECT * FROM skill_git_sources WHERE skill_id=$1',[id])).rows[0]);}
 async list() {return (await this.pool.query('SELECT * FROM skill_git_sources ORDER BY skill_id')).rows.map(skillSourceRow);}
 async save(id,input={}) {
  return withPostgresTransaction(this.pool,async c=>{
   await skillLock(c,id);
   const old=await this.get(id,c);
   const value={repository:input.repository??old?.repository,ref:input.ref??old?.ref??'HEAD',path:input.path??old?.path};
   try {validateGitSkillSource(value);} catch {throw skillSourceError('skill_source_invalid');}
   const enabled=input.enabled??old?.enabled??false;
   if(typeof enabled!=='boolean') throw skillSourceError('skill_source_enabled_invalid');
   const cron=input.cron===undefined?(old?.cron??null):input.cron;
   const timezone=input.timezone??old?.timezone??'UTC';
   let next=null;
   try {new Intl.DateTimeFormat('en',{timeZone:timezone});if(cron!==null) parseCron(cron);if(enabled){if(!cron)throw Error();next=nextCronOccurrence(cron,timezone,new Date(this.clock()));}} catch {throw skillSourceError('skill_source_schedule_invalid');}
   const timeout=input.fetchTimeoutMs??old?.fetchTimeoutMs??120000;
   if(!Number.isSafeInteger(timeout)||timeout<=0||timeout>2147483647) throw skillSourceError('skill_source_timeout_invalid');
   const skill=(await c.query('SELECT id FROM skills WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!skill) throw skillSourceError('skill_not_found',404);
   // Attaching a source does not replace the installed copy. Publication is explicit sync.
   await c.query(`INSERT INTO skill_git_sources(skill_id,repository,git_ref,skill_path,enabled,cron_expression,timezone,fetch_timeout_ms,next_sync_at)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(skill_id) DO UPDATE SET repository=$2,git_ref=$3,skill_path=$4,enabled=$5,cron_expression=$6,timezone=$7,fetch_timeout_ms=$8,next_sync_at=$9,sync_token=NULL,sync_expires_at=NULL,updated_at=CURRENT_TIMESTAMP`,[id,value.repository,value.ref,value.path,enabled,cron,timezone,timeout,next]);
   return this.get(id,c);
  });
 }
 async remove(id) {return withPostgresTransaction(this.pool,async c=>{await skillLock(c,id);const skill=(await c.query('SELECT storage FROM skills WHERE id=$1 FOR UPDATE',[id])).rows[0];if(!skill)throw skillSourceError('skill_not_found',404);if(skill.storage==='filesystem')throw skillSourceError('skill_package_detach_requires_copy',409);await c.query('DELETE FROM skill_git_sources WHERE skill_id=$1',[id]);await c.query("UPDATE skills SET content_owner='operator' WHERE id=$1",[id]);return true;});}
 async history(id,{before=null,limit=50}={}) {
  if(!Number.isSafeInteger(limit)||limit<1|| (before!==null&&!/^\d+$/.test(String(before))))throw skillSourceError('skill_history_query_invalid');
  const {rows}=await this.pool.query('SELECT * FROM skill_sync_history WHERE skill_id=$1 AND ($2::bigint IS NULL OR sequence<$2) ORDER BY sequence DESC LIMIT $3',[id,before,limit]);
  return {history:rows.map(r=>({id:String(r.sequence),skillId:r.skill_id,status:r.status,revision:r.revision,contentHash:r.content_hash,error:r.error,startedAt:r.started_at,completedAt:r.completed_at})),nextCursor:rows.length===limit?String(rows.at(-1).sequence):null};
 }
 async due(at=this.clock()) {return (await this.pool.query('SELECT skill_id FROM skill_git_sources WHERE enabled AND next_sync_at<=$1 ORDER BY next_sync_at',[at])).rows.map(r=>r.skill_id);}
}
