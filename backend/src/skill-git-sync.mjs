import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fetchGitSkill, skillFilesHash } from './git-skill-fetch.mjs';
import { withPostgresTransaction, postgresTransactionContext } from './postgres-foundation.mjs';
import { PostgresSkillSources, skillLock, skillSourceError, normalizeSkillSource } from './postgres-skill-sources.mjs';
import { PostgresSkillSettingsStore } from './postgres-skill-settings-store.mjs';
import { nextCronOccurrence } from './scheduled-job-store.mjs';

export async function installedSkillFiles(root) {
 const files=[];
 if((await fs.lstat(root)).isSymbolicLink())throw skillSourceError('skill_local_changes',409);
 async function walk(dir,prefix='') {
  for(const name of (await fs.readdir(dir)).sort()) {
   const absolute=path.join(dir,name),relative=prefix?prefix+'/'+name:name;
   const stat=await fs.lstat(absolute);
   if(stat.isSymbolicLink() || (!stat.isFile()&&!stat.isDirectory()))throw skillSourceError('skill_local_changes',409);
   if(stat.isDirectory())await walk(absolute,relative);
   else files.push({path:relative,bytes:await fs.readFile(absolute),mode:stat.mode&0o111?0o755:0o644});
  }
 }
 await walk(root);return files;
}
export class SkillGitSync {
 constructor({pool,skills,sources,packageRoot,fetchSkill=fetchGitSkill,clock=()=>new Date().toISOString(),intervalMs=30000,packageGraceMs=86400000,onError=()=>{}}={}) {
  this.pool=pool;this.skills=skills;this.sources=sources;this.packageRoot=path.resolve(packageRoot);this.fetchSkill=fetchSkill;this.clock=clock;this.intervalMs=intervalMs;this.packageGraceMs=packageGraceMs;this.onError=onError;this.active=new Set();this.timer=null;this.ticking=null;
 }
 async sync(id,{scheduled=false}={}) {
  const promise=this.perform(id,{scheduled});this.active.add(promise);try{return await promise;}finally{this.active.delete(promise);}
 }
 async perform(id,{scheduled}) {
  const token=randomUUID(),started=this.clock();
  const source=await withPostgresTransaction(this.pool,async c=>{
   await skillLock(c,id,{tryOnly:true});
   await new PostgresSkillSources({pool:c,clock:this.clock}).reconcile(id,c);
   const row=(await c.query('SELECT * FROM skill_git_sources WHERE skill_id=$1 FOR UPDATE',[id])).rows[0];
   if(!row)throw skillSourceError('skill_source_not_found',404);
   if(row.sync_token && Date.parse(row.sync_expires_at)>Date.parse(this.clock()))throw skillSourceError('skill_sync_running',409);
   const sources=new PostgresSkillSources({pool:c,clock:this.clock});
   const current=await sources.get(id);
   if(scheduled&&(!current.enabled||!current.nextSyncAt||Date.parse(current.nextSyncAt)>Date.parse(this.clock())))return null;
   // A durable lease releases the connection before network I/O. Crashed fetches
   // are retryable after their aggregate deadline plus publication/drain allowance.
   await c.query('UPDATE skill_git_sources SET sync_token=$2,sync_expires_at=$3 WHERE skill_id=$1',[id,token,new Date(Date.parse(this.clock())+current.fetchTimeoutMs+60000).toISOString()]);
   return current;
  });
  if(!source)return {ok:true,status:'not_due'};
  let fetched=null,fetchError=null;
  try {fetched=await this.fetchSkill({repository:source.repository,ref:source.ref,path:source.path,timeoutMs:source.fetchTimeoutMs});}catch(e){fetchError=e;}
  return withPostgresTransaction(this.pool,async c=>{
   await skillLock(c,id,{tryOnly:true});
   const row=(await c.query('SELECT * FROM skill_git_sources WHERE skill_id=$1 FOR UPDATE',[id])).rows[0];
   if(!row || row.sync_token!==token)throw skillSourceError('skill_source_changed',409);
   const sources=new PostgresSkillSources({pool:c,clock:this.clock});
   const old=(await c.query('SELECT * FROM skills WHERE id=$1 FOR UPDATE',[id])).rows[0];
   let status='failed',revision=fetched?.revision??null,hash=null,error=null,publishedPath=null,createdPath=null;
   await c.query('SAVEPOINT skill_publication');
   try {
    if(fetchError)throw fetchError;
    if(old.content_owner==='git') {
     const files=old.storage==='filesystem'?await installedSkillFiles(old.installed_path):[{path:'SKILL.md',bytes:Buffer.from(old.content),mode:0o644}];
     if(skillFilesHash(files)!==old.installed_hash)throw skillSourceError('skill_local_changes',409);
    }
    ({hash,status,publishedPath}=await this.publish(c,id,old,fetched,p=>{createdPath=p;}));
   }catch(e){
    await c.query('ROLLBACK TO SAVEPOINT skill_publication');
    error=e.message==='skill_local_changes'?'skill_local_changes':e.message?.includes('timed out')?'skill_sync_timeout':'skill_sync_failed';
    if(createdPath)await fs.rm(createdPath,{recursive:true,force:true}).catch(()=>this.onError(skillSourceError('skill_package_cleanup_failed')));
   }
   await c.query('RELEASE SAVEPOINT skill_publication');
   const zone=await sources.zone(c);
   const next=source.enabled?nextCronOccurrence(source.cron,zone,new Date(this.clock())):null;
   await c.query('UPDATE skill_git_sources SET timezone=$2,effective_timezone=$2 WHERE skill_id=$1',[id,zone]);
   await c.query(`UPDATE skill_git_sources SET sync_token=NULL,sync_expires_at=NULL,last_checked_at=$2,observed_revision=COALESCE($3,observed_revision),last_error=$4,next_sync_at=$5,
    last_success_at=CASE WHEN $6 THEN $2 ELSE last_success_at END,installed_revision=CASE WHEN $6 THEN $3 ELSE installed_revision END,updated_at=$2 WHERE skill_id=$1`,[id,this.clock(),revision,error,next,status!=='failed']);
   const {rows}=await c.query('INSERT INTO skill_sync_history(skill_id,status,revision,content_hash,error,installed_path,started_at) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING sequence',[id,status,revision,hash,error,publishedPath,started]);
   return {ok:status!=='failed',status,...(error?{error}:{}),receiptId:String(rows[0].sequence),source:await sources.get(id)};
  });
 }
 async fetchImport(input={}) {
  const options=normalizeSkillSource(input,null,this.clock,await this.sources.zone());
  let fetched;
  try {fetched=await this.fetchSkill({...options.value,timeoutMs:options.timeout});}
  catch(e){throw skillSourceError(e.message?.includes('timed out')?'skill_sync_timeout':'skill_git_invalid',400);}
  if(!fetched.content.trim())throw skillSourceError('skill_git_invalid');
  if(input.expectedRevision!==undefined && input.expectedRevision!==fetched.revision)throw skillSourceError('skill_revision_changed',409);
  return {fetched,options};
 }
 previewRecord(fetched,options) {
  const suggestedId=fetched.name.normalize('NFKD').replace(/[^A-Za-z0-9._-]+/g,'-').replace(/^[^A-Za-z0-9]+|[-.]+$/g,'').slice(0,128)||'skill';
  return {name:fetched.name,description:fetched.description,content:fetched.content,suggestedId,
   storage:fetched.storage,revision:fetched.revision,contentHash:fetched.contentHash,
   files:fetched.files.map(f=>({path:f.path,bytes:f.bytes.length,executable:f.mode===0o755})),
   source:{...options.value,enabled:options.enabled,cron:options.cron,timezone:options.timezone,fetchTimeoutMs:options.timeout}};
 }
 async preview(input={}) {
  const {fetched,options}=await this.fetchImport(input);
  return {ok:true,preview:this.previewRecord(fetched,options)};
 }
 async import(input={}) {
  // All network/object validation precedes any persistent mutation. Preview is not trusted.
  const {fetched,options}=await this.fetchImport(input);
  const id=String(input.id??this.previewRecord(fetched,options).suggestedId).trim();
  if(!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id))throw skillSourceError('skill_id_invalid');
  let createdPath=null;
  return withPostgresTransaction(this.pool,async c=>{
   // Hold the ID lock through rollback compensation: another importer cannot reuse
   // the tree while a failed publication is removing its own newly created copy.
   await skillLock(c,id);
   await c.query('SAVEPOINT skill_import');
   try {
    const context=postgresTransactionContext(c);
    const skills=new PostgresSkillSettingsStore({pool:context,clock:this.clock});
    const sources=new PostgresSkillSources({pool:context,clock:this.clock});
    await skills.create({id,name:fetched.name,description:fetched.description,content:fetched.content,lifecycle:input.lifecycle,global:input.global});
    await sources.save(id,input);
    const {hash,publishedPath}=await this.publish(c,id,{},fetched,p=>{createdPath=p;});
    await c.query('UPDATE skill_git_sources SET installed_revision=$2,observed_revision=$2,last_checked_at=$3,last_success_at=$3 WHERE skill_id=$1',[id,fetched.revision,this.clock()]);
    const {rows}=await c.query("INSERT INTO skill_sync_history(skill_id,status,revision,content_hash,installed_path,started_at) VALUES($1,'updated',$2,$3,$4,$5) RETURNING sequence",[id,fetched.revision,hash,publishedPath,this.clock()]);
    const result={ok:true,status:'updated',receiptId:String(rows[0].sequence),skill:await skills.get(id),source:await sources.get(id)};
    await c.query('RELEASE SAVEPOINT skill_import');
    return result;
   } catch(e) {
    await c.query('ROLLBACK TO SAVEPOINT skill_import');
    if(createdPath)await fs.rm(createdPath,{recursive:true,force:true});
    await c.query('RELEASE SAVEPOINT skill_import');
    throw e;
   }
  });
 }
 async publish(c,id,old,fetched,onCreated=()=>{}) {
    const hash=fetched.storage==='postgres'?skillFilesHash([{path:'SKILL.md',bytes:Buffer.from(fetched.content),mode:0o644}]):fetched.contentHash;
    let status, publishedPath=null;
    if(old.content_owner==='git'&&old.installed_hash===hash)status='unchanged';
    else {
     if(fetched.storage==='filesystem') {
      const staging=path.join(this.packageRoot,'.staging-'+id+'-'+randomUUID());
      publishedPath=path.join(this.packageRoot,id,hash.replace('sha256:',''));
      await fs.mkdir(staging,{recursive:true});
      try {
       for(const file of fetched.files){const destination=path.join(staging,file.path);await fs.mkdir(path.dirname(destination),{recursive:true});await fs.writeFile(destination,file.bytes,{mode:file.mode});await fs.chmod(destination,file.mode);}
       await fs.mkdir(path.dirname(publishedPath),{recursive:true});
       try {await fs.rename(staging,publishedPath);onCreated(publishedPath);}catch(e){if(!['EEXIST','ENOTEMPTY'].includes(e.code))throw e;if(skillFilesHash(await installedSkillFiles(publishedPath))!==hash)throw skillSourceError('skill_local_changes',409);}
      } finally {await fs.rm(staging,{recursive:true,force:true}).catch(()=>this.onError(skillSourceError('skill_package_cleanup_failed')));}
     }
     await c.query('DELETE FROM skill_package_files WHERE skill_id=$1',[id]);
     if(fetched.storage==='filesystem')for(const file of fetched.files)await c.query('INSERT INTO skill_package_files(skill_id,file_path,bytes,executable) VALUES($1,$2,$3,$4)',[id,file.path,file.bytes.length,file.mode===0o755]);
     await c.query("UPDATE skills SET name=$2,description=$3,content=$4,storage=$5,content_owner='git',installed_path=$6,installed_hash=$7,updated_at=$8 WHERE id=$1",[id,fetched.name||id,fetched.description,fetched.content,fetched.storage,publishedPath,hash,this.clock()]);
     if(old.installed_path && old.installed_path!==publishedPath) await fs.utimes(old.installed_path,new Date(this.clock()),new Date(this.clock())).catch(()=>{});
     status='updated';
    }
    return {hash,status,publishedPath};
 }
 async cleanupPackages() {
  // Grace covers catalogs already returned to an in-flight turn. History records
  // preserve revisions; obsolete extracted trees are not an unbounded archive.
  await fs.mkdir(this.packageRoot,{recursive:true});
  const ids=await fs.readdir(this.packageRoot,{withFileTypes:true});
  for(const item of ids) {
   if(!item.isDirectory())continue;
   if(item.name.startsWith('.staging-')) {
    const match=/^\.staging-(.+)-[0-9a-f-]{36}$/.exec(item.name);if(!match)continue;
    await withPostgresTransaction(this.pool,async c=>{try {await skillLock(c,match[1],{tryOnly:true});}catch(e){if(e.message==='skill_sync_running')return;throw e;}const target=path.join(this.packageRoot,item.name);if(Date.parse(this.clock())-(await fs.stat(target)).mtimeMs>=this.packageGraceMs)await fs.rm(target,{recursive:true,force:true});});continue;
   }
   await withPostgresTransaction(this.pool,async c=>{
    try {await skillLock(c,item.name,{tryOnly:true});}catch(e){if(e.message==='skill_sync_running')return;throw e;}
    const installed=(await c.query('SELECT installed_path FROM skills WHERE id=$1',[item.name])).rows[0]?.installed_path;
    const root=path.join(this.packageRoot,item.name);
    for(const entry of await fs.readdir(root,{withFileTypes:true})) {
     if(!entry.isDirectory()||! /^[0-9a-f]{64}$/.test(entry.name))continue;
     const target=path.join(root,entry.name);
     if(target===installed)continue;
     if(Date.parse(this.clock())-(await fs.stat(target)).mtimeMs>=this.packageGraceMs)await fs.rm(target,{recursive:true,force:true});
    }
    if(!(await fs.readdir(root)).length)await fs.rmdir(root);
   });
  }
 }
 async tick() {
  if(this.ticking)return this.ticking;
  this.ticking=(async()=>{const results=[];for(const id of await this.sources.due()){try{results.push(await this.sync(id,{scheduled:true}));}catch(e){if(e.message!=='skill_sync_running')this.onError(e);}}await this.cleanupPackages();return results;})();
  try{return await this.ticking;}finally{this.ticking=null;}
 }
 start(){if(!this.timer){this.timer=setInterval(()=>void this.tick().catch(this.onError),this.intervalMs);this.timer.unref?.();}return this.tick();}
 async close(){if(this.timer)clearInterval(this.timer);this.timer=null;await this.ticking;await Promise.allSettled([...this.active]);}
}
