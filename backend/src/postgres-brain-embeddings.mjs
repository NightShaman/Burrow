import pg from 'pg';
import { createHash } from 'node:crypto';
import { withPostgresTransaction } from './postgres-foundation.mjs';
import { BrainEmbeddingProvider, embeddingVector, embeddingFailure } from './brain-embedding-provider.mjs';

export const POSTGRES_BRAIN_EMBEDDINGS_SQL = `
CREATE TABLE brain_embedding_settings (
 singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton), enabled BOOLEAN NOT NULL DEFAULT FALSE,
 connection_id TEXT, model TEXT, generation BIGINT NOT NULL DEFAULT 1, connection_fingerprint TEXT NOT NULL DEFAULT ''
);
INSERT INTO brain_embedding_settings(singleton) VALUES(TRUE);
CREATE TABLE brain_embedding_vectors (
 agent_id TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,generation BIGINT NOT NULL,
 vector DOUBLE PRECISION[] NOT NULL, PRIMARY KEY(agent_id,id),
 FOREIGN KEY(agent_id,id) REFERENCES brain_memories(agent_id,id) ON DELETE CASCADE
);
CREATE TABLE brain_embedding_jobs (
 agent_id TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,
 next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(), error TEXT,
 PRIMARY KEY(agent_id,id), FOREIGN KEY(agent_id,id) REFERENCES brain_memories(agent_id,id) ON DELETE CASCADE
);
CREATE FUNCTION brain_embedding_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM brain_embedding_vectors WHERE agent_id=NEW.agent_id AND id=NEW.id;
 IF NEW.deleted_at IS NOT NULL THEN
  DELETE FROM brain_embedding_jobs WHERE agent_id=NEW.agent_id AND id=NEW.id;
 ELSE
  INSERT INTO brain_embedding_jobs(agent_id,id,revision) VALUES(NEW.agent_id,NEW.id,NEW.revision)
  ON CONFLICT(agent_id,id) DO UPDATE SET revision=EXCLUDED.revision,attempts=0,next_attempt_at=now(),error=NULL;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER brain_embedding_changed AFTER INSERT OR UPDATE ON brain_memories FOR EACH ROW EXECUTE FUNCTION brain_embedding_changed();
INSERT INTO brain_embedding_jobs(agent_id,id,revision) SELECT agent_id,id,revision FROM brain_memories WHERE deleted_at IS NULL;
`;
const fingerprint=c=>createHash('sha256').update(JSON.stringify(c ? [c.id,c.apiType,c.baseUrl,c.updatedAt] : null)).digest('hex');
const publicSettings=r=>({enabled:r.enabled,connectionId:r.connection_id,model:r.model,generation:String(r.generation)});
export function cosine(a,b) {
 if(a.length!==b.length) return null;
 let dot=0,aa=0,bb=0; for(let i=0;i<a.length;i++){dot+=a[i]*b[i];aa+=a[i]*a[i];bb+=b[i]*b[i];}
 return aa&&bb ? dot/Math.sqrt(aa)/Math.sqrt(bb) : null;
}
export class PostgresBrainEmbeddings {
 constructor({pool,models,provider=new BrainEmbeddingProvider({models}),retryBaseMs=30000,retryMaxMs=3600000}) { this.pool=pool;this.models=models;this.provider=provider;this.running=null;this.timer=null;this.stopped=false;this.active=new Set();
  if(!Number.isSafeInteger(retryBaseMs)||retryBaseMs<1||!Number.isSafeInteger(retryMaxMs)||retryMaxMs<retryBaseMs) throw new Error('brain_embedding_retry_invalid');
  this.retryBaseMs=retryBaseMs;this.retryMaxMs=retryMaxMs; }
 async settings(client=this.pool) { return (await client.query('SELECT * FROM brain_embedding_settings WHERE singleton')).rows[0]; }
 async reset(client) {
  await client.query('DELETE FROM brain_embedding_vectors');
  await client.query(`INSERT INTO brain_embedding_jobs(agent_id,id,revision) SELECT agent_id,id,revision FROM brain_memories WHERE deleted_at IS NULL
   ON CONFLICT(agent_id,id) DO UPDATE SET revision=EXCLUDED.revision,attempts=0,next_attempt_at=now(),error=NULL`);
 }
 async reconcile() {
  const s=await this.settings(); const f=fingerprint(s.connection_id ? await this.models.get(s.connection_id) : null);
  if(f===s.connection_fingerprint) return s;
  return withPostgresTransaction(this.pool,async c=>{
   const locked=(await c.query('SELECT * FROM brain_embedding_settings WHERE singleton FOR UPDATE')).rows[0];
   if(locked.generation!==s.generation) return locked;
   if(locked.connection_fingerprint!==f) {
    await c.query('UPDATE brain_embedding_settings SET generation=generation+1,connection_fingerprint=$1 WHERE singleton',[f]);await this.reset(c);
   }
   return this.settings(c);
  });
 }
 async configure(input) {
  if(typeof input.enabled!=='boolean') throw new Error('brain_embedding_enabled_required');
  const connectionId=input.connectionId || null,model=input.model || null;
  if(connectionId!==null && typeof connectionId!=='string' || model!==null && typeof model!=='string') throw new Error('brain_embedding_selection_invalid');
  let f=fingerprint(null);
  if(input.enabled || connectionId || model) {
   if(!connectionId || !model) throw new Error('brain_embedding_selection_required');
   await this.provider.context(connectionId);
   f=fingerprint(await this.models.get(connectionId));
  }
  await withPostgresTransaction(this.pool,async c=>{
   const old=(await c.query('SELECT * FROM brain_embedding_settings WHERE singleton FOR UPDATE')).rows[0];
   if(old.enabled===input.enabled && old.connection_id===connectionId && old.model===model && old.connection_fingerprint===f) return;
   await c.query('UPDATE brain_embedding_settings SET enabled=$1,connection_id=$2,model=$3,generation=generation+1,connection_fingerprint=$4 WHERE singleton',[input.enabled,connectionId,model,f]);
   await this.reset(c);
  });
  if(!input.enabled) for(const controller of this.active) controller.abort();
  this.wake();return this.status();
 }
 async status() {
  const s=await this.reconcile();
  const r=(await this.pool.query(`SELECT (SELECT count(*) FROM brain_memories WHERE deleted_at IS NULL)::text AS total,
   (SELECT count(*) FROM brain_embedding_vectors WHERE generation=$1)::text AS indexed,
   (SELECT count(*) FROM brain_embedding_jobs)::text AS pending,
   (SELECT count(*) FROM brain_embedding_jobs WHERE error IS NOT NULL)::text AS failed`,[s.generation])).rows[0];
  return {...publicSettings(s),...r,storage:'postgres_float8_exact_cosine',lastError:r.failed!=='0'?'brain_embedding_index_failed':null};
 }
 async test(input) { const v=await this.provider.embed({...input,text:'Burrow saved memory embedding capability test.'});return {ok:true,dimensions:v.length}; }
 async reindex() { await withPostgresTransaction(this.pool,async c=>{await c.query('UPDATE brain_embedding_settings SET generation=generation+1 WHERE singleton');await this.reset(c);});this.wake();return this.status(); }
 start() { this.stopped=false;this.timer=setInterval(()=>this.wake(),2000);this.timer.unref();this.wake(); }
 wake() { if(!this.stopped && !this.running) this.running=this.drain().catch(()=>{}).finally(()=>{this.running=null;}); }
 async close() { this.stopped=true;clearInterval(this.timer);for(const controller of this.active) controller.abort();if(this.running) await this.running; }
 async drain() {
  // Independent session: never reserve a pool slot while provider/model operations
  // need that same pool (including max=1). Session loss releases ownership.
  const client=new pg.Client({...this.pool.options,connectionTimeoutMillis:this.pool.options.connectionTimeoutMillis || 10000});
  const controller=new AbortController();this.active.add(controller);
  const lost=()=>controller.abort();client.on('error',lost);
  let locked=false;
  try {
   await client.connect();
   locked=(await client.query("SELECT pg_try_advisory_lock(hashtextextended(current_schema() || ':brain-embedding-worker',0)) AS locked")).rows[0].locked;
   if(!locked || controller.signal.aborted) return;
   await this.drainOwned(controller.signal);
  } finally {
   if(locked) await client.query("SELECT pg_advisory_unlock(hashtextextended(current_schema() || ':brain-embedding-worker',0))").catch(()=>{});
   await client.end().catch(()=>{});this.active.delete(controller);
  }
 }
 async drainOwned(signal) {
  // Persistent jobs are authoritative. No total batch cap; next-attempt time
  // supplies durable retry/backoff and process restart recovery.
  while(!signal.aborted) {
   const s=await this.reconcile();if(!s.enabled) return;
   const row=(await this.pool.query(`SELECT m.*,j.attempts FROM brain_embedding_jobs j JOIN brain_memories m USING(agent_id,id)
    WHERE m.deleted_at IS NULL AND j.next_attempt_at<=now() ORDER BY j.next_attempt_at,j.agent_id,j.id LIMIT 1`)).rows[0];
   if(!row) return;
   try {
    const vector=embeddingVector(await this.provider.embed({connectionId:s.connection_id,model:s.model,text:row.title+'\n'+row.content,signal}));
    if(signal.aborted) return;
    await this.reconcile();
    await withPostgresTransaction(this.pool,async c=>{
     // Lock settings then memory: edit/delete cannot race the fenced vector write.
     const current=(await c.query('SELECT * FROM brain_embedding_settings WHERE singleton FOR SHARE')).rows[0];
     const memory=(await c.query('SELECT revision,deleted_at FROM brain_memories WHERE agent_id=$1 AND id=$2 FOR SHARE',[row.agent_id,row.id])).rows[0];
     if(signal.aborted || !current.enabled || current.generation!==s.generation || !memory || memory.deleted_at || memory.revision!==row.revision) return;
     await c.query(`INSERT INTO brain_embedding_vectors(agent_id,id,revision,generation,vector) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(agent_id,id) DO UPDATE SET revision=EXCLUDED.revision,generation=EXCLUDED.generation,vector=EXCLUDED.vector`,[row.agent_id,row.id,row.revision,s.generation,vector]);
     await c.query('DELETE FROM brain_embedding_jobs WHERE agent_id=$1 AND id=$2 AND revision=$3',[row.agent_id,row.id,row.revision]);
    });
   } catch(error) {
    if(signal.aborted) return; // Cancellation leaves the durable job ready.
    const failure=embeddingFailure(error);
    const delay=Math.min(this.retryMaxMs,this.retryBaseMs*2**Math.min(row.attempts,30));
    await withPostgresTransaction(this.pool,async c=>{
     const current=(await c.query('SELECT * FROM brain_embedding_settings WHERE singleton FOR SHARE')).rows[0];
     if(!current.enabled || current.generation!==s.generation) return;
     await c.query(`UPDATE brain_embedding_jobs SET attempts=attempts+1,error=$4,
      next_attempt_at=CASE WHEN $5 THEN now()+($6 * interval '1 millisecond') ELSE 'infinity'::timestamptz END
      WHERE agent_id=$1 AND id=$2 AND revision=$3`,[row.agent_id,row.id,row.revision,failure.code,failure.retryable,delay]);
    });
   }
  }
 }
 async search(input,store) {
  if(input.query!==undefined && input.query!==null && typeof input.query!=='string') throw new Error('brain_invalid_query');
  const s=await this.reconcile();if(!s.enabled || !input.query) return store.list(input);
  let vector;
  try { vector=await this.provider.embed({connectionId:s.connection_id,model:s.model,text:input.query,query:true}); }
  catch { return {...await store.list(input),retrieval:{mode:'lexical',fallback:'embedding_unavailable'}}; }
  const current=await this.reconcile();
  if(current.generation!==s.generation || !current.enabled) return store.list(input);
  // Complete corpus scan, exact similarity, small curated Brains only. A ranked
  // cursor carries a corpus digest; changes fail explicitly, never silently skip.
  const rows=(await this.pool.query(`SELECT m.*,v.vector FROM brain_memories m LEFT JOIN brain_embedding_vectors v ON v.agent_id=m.agent_id AND v.id=m.id AND v.revision=m.revision AND v.generation=$2
   WHERE m.agent_id=$1 AND m.deleted_at IS NULL ORDER BY m.id COLLATE "C"`,[input.agentId,s.generation])).rows;
  const digest=createHash('sha256').update(JSON.stringify([s.generation,rows.map(r=>[r.id,r.revision,r.vector])])).digest('hex');
  let offset=0;
  if(input.cursor) {
   let c;try{c=JSON.parse(Buffer.from(input.cursor,'base64url').toString());}catch{throw new Error('brain_invalid_cursor');}
   if(c.v!==2 || c.agentId!==input.agentId || c.query!==input.query || c.digest!==digest || !Number.isSafeInteger(c.offset) || c.offset<0) throw new Error('brain_invalid_cursor');offset=c.offset;
  }
  const n=input.limit ?? 50;if(!Number.isSafeInteger(n)||n<1) throw new Error('brain_invalid_limit');
  const q=input.query.toLowerCase();
  const ranked=rows.map(r=>({r,lexical:(r.title+'\n'+r.content).toLowerCase().includes(q),semantic:r.vector?cosine(vector,r.vector):null}))
   .filter(x=>x.lexical || x.semantic!==null).map(x=>({...x,score:(x.lexical?1:0)+(x.semantic===null?0:(x.semantic+1)/2)}))
   .sort((a,b)=>b.score-a.score || (a.r.id<b.r.id?-1:1));
  const items=ranked.slice(offset,offset+n).map(x=>({...store.record(x.r),score:x.score,semanticScore:x.semantic}));
  return {items,nextCursor:offset+n<ranked.length?Buffer.from(JSON.stringify({v:2,agentId:input.agentId,query:input.query,digest,offset:offset+n})).toString('base64url'):null,retrieval:{mode:'hybrid',indexed:rows.filter(r=>r.vector).length,total:rows.length}};
 }
}
