import pg from 'pg';
import { readSessionRecallReadiness } from './postgres-session-recall-backfill.mjs';
import { createHash } from 'node:crypto';
import { withPostgresTransaction } from './postgres-foundation.mjs';
import { archiveReadBudget, withArchiveRead } from './postgres-archive-read.mjs';
import { BrainEmbeddingProvider, embeddingFailure, embeddingVector } from './brain-embedding-provider.mjs';

// Append after POSTGRES_SESSION_RETRIEVAL_SQL. No history is embedded, scanned,
// or copied by this migration. Consent is a separate parent-owned settings flag.
export const POSTGRES_CONVERSATION_EMBEDDINGS_SQL = `
CREATE TABLE conversation_embedding_state (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), epoch bigint NOT NULL DEFAULT 1,
 signature text NOT NULL DEFAULT '', dimensions integer, cursor jsonb, cleanup_cursor jsonb, backfill_complete boolean NOT NULL DEFAULT false,
 CHECK(dimensions BETWEEN 1 AND 4000)
);
INSERT INTO conversation_embedding_state(singleton) VALUES(true);
CREATE TABLE conversation_embedding_dirty (
 agent_id text NOT NULL,session_id text NOT NULL,source_store text NOT NULL,source_id text NOT NULL,ordinal bigint NOT NULL,
 queue_id bigserial NOT NULL UNIQUE,
 PRIMARY KEY(agent_id,session_id,source_store,source_id,ordinal),
 FOREIGN KEY(agent_id,session_id,source_store,source_id,ordinal)
 REFERENCES conversation_recall_rows ON UPDATE CASCADE ON DELETE CASCADE
);
CREATE TABLE conversation_embedding_documents (
 agent_id text NOT NULL,hash text NOT NULL,text text NOT NULL,
 indexed_epoch bigint NOT NULL DEFAULT 0,attempts integer NOT NULL DEFAULT 0,
 next_attempt_at timestamptz NOT NULL DEFAULT now(),error text,
 PRIMARY KEY(agent_id,hash), CHECK(length(text) BETWEEN 1 AND 1800)
);
CREATE INDEX conversation_embedding_jobs_idx ON conversation_embedding_documents(next_attempt_at,agent_id,hash) WHERE indexed_epoch=0;
CREATE TABLE conversation_embedding_refs (
 agent_id text NOT NULL,session_id text NOT NULL,source_store text NOT NULL,source_id text NOT NULL,ordinal bigint NOT NULL,
 passage integer NOT NULL,hash text NOT NULL,message_at timestamptz,
 PRIMARY KEY(agent_id,session_id,source_store,source_id,ordinal,passage),
 FOREIGN KEY(agent_id,session_id,source_store,source_id,ordinal)
 REFERENCES conversation_recall_rows ON UPDATE CASCADE ON DELETE CASCADE,
 FOREIGN KEY(agent_id,hash) REFERENCES conversation_embedding_documents ON DELETE CASCADE
);
CREATE INDEX conversation_embedding_refs_document_idx ON conversation_embedding_refs(agent_id,hash);
CREATE FUNCTION burrow_conversation_embedding_dirty() RETURNS trigger LANGUAGE plpgsql AS $embedding$
BEGIN
 INSERT INTO conversation_embedding_dirty(agent_id,session_id,source_store,source_id,ordinal)
 VALUES(NEW.agent_id,NEW.session_id,NEW.source_store,NEW.source_id,NEW.ordinal)
 ON CONFLICT(agent_id,session_id,source_store,source_id,ordinal) DO UPDATE SET queue_id=DEFAULT;
 RETURN NULL;
END $embedding$;
CREATE TRIGGER burrow_conversation_embedding_dirty AFTER INSERT OR UPDATE ON conversation_recall_rows
 FOR EACH ROW EXECUTE FUNCTION burrow_conversation_embedding_dirty();
-- Optional external installs must be able to migrate and keep lexical search.
DO $embedding$ BEGIN
 CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
EXCEPTION WHEN undefined_file OR insufficient_privilege OR feature_not_supported THEN NULL;
END $embedding$;
`;

const ident = s => '"' + s.replaceAll('"','""') + '"';
const signature = s => JSON.stringify([String(s.generation),s.connection_id,s.model]);
const enabled = s => s?.conversation_enabled === true && Boolean(s.connection_id && s.model);
const same = (a,b) => enabled(b) && signature(a) === signature(b);
const scope = `NULLIF(s.metadata->'contextIsolation'->>'historySessionId','') IS NULL`;
const key = 'agent_id,session_id,source_store,source_id,ordinal';
const keyValues = r => [r.agent_id,r.session_id,r.source_store,r.source_id,r.ordinal];
const keyWhere = (alias='',start=1) => key.split(',').map((k,i)=>`${alias?alias+'.':''}${k}=$${i+start}`).join(' AND ');
const canonical = r => `(${r}.logical_key IS NULL OR NOT EXISTS (
 SELECT 1 FROM conversation_recall_rows n WHERE n.agent_id=${r}.agent_id AND n.session_id=${r}.session_id AND n.logical_key=${r}.logical_key
 AND (n.source_store>${r}.source_store OR (n.source_store=${r}.source_store AND
 CASE WHEN ${r}.source_store='live' THEN n.ordinal>${r}.ordinal ELSE n.generation>${r}.generation OR
 (n.generation=${r}.generation AND (n.source_id>${r}.source_id OR (n.source_id=${r}.source_id AND n.ordinal<${r}.ordinal))) END)) OFFSET 0))`;
const reset = `COALESCE((r.source_store='archive' AND (r.archive_kind='reset' OR
 r.generation<=COALESCE((SELECT max(a.generation) FROM conversation_archives a WHERE a.agent_id=r.agent_id AND a.session_id=r.session_id AND a.kind='reset'),-1)
 OR r.created_at<=burrow_legacy_instant(s.metadata->>'resetAt'))),false)`;
const hydrate = (alias='r') => `LEFT JOIN LATERAL (SELECT entry FROM conversation_entries l WHERE ${alias}.source_store='live'
 AND l.agent_id=${alias}.agent_id AND l.session_id=${alias}.session_id AND l.sequence=${alias}.ordinal OFFSET 0) l ON true
 LEFT JOIN LATERAL (SELECT entry FROM conversation_archive_entries a WHERE ${alias}.source_store='archive'
 AND a.agent_id=${alias}.agent_id AND a.session_id=${alias}.session_id AND a.source_store='archive'
 AND a.source_id=${alias}.source_id AND a.ordinal=${alias}.ordinal OFFSET 0) a ON true`;
const instant = value => {const n=Date.parse(String(value || '').trim());return Number.isFinite(n)?new Date(n).toISOString():null;};

/** Derived text only; originals are never rewritten. A single enormous message
 * gets bounded, evenly distributed windows, not an unbounded provider request. */
export function conversationPassages(entry,{size=1600,overlap=160,maxPassages=16}={}) {
 if(!Number.isSafeInteger(size)||size<80||size>1800||!Number.isSafeInteger(overlap)||overlap<0||overlap>=size||!Number.isSafeInteger(maxPassages)||maxPassages<1||maxPassages>64) throw new Error('conversation_embedding_chunk_options_invalid');
 let content=entry?.content;
 if(Array.isArray(content)) content=content.filter(x=>x?.type==='text'&&typeof x.text==='string').map(x=>x.text).join('\n');
 if(typeof content!=='string') return [];
 // PostgreSQL text and embedding endpoints cannot represent lone surrogates/NUL.
 const text=content.toWellFormed().replaceAll('\0','\ufffd').replace(/\s+/gu,' ').trim();
 if(text.length<24 || !/[\p{L}\p{N}]/u.test(text)) return [];
 const count=Math.max(1,Math.ceil((text.length-overlap)/(size-overlap)));
 const starts=count<=maxPassages?Array.from({length:count},(_,i)=>i*(size-overlap))
  :Array.from({length:maxPassages},(_,i)=>Math.floor(i*(text.length-size)/Math.max(1,maxPassages-1)));
 const seen=new Set(),out=[];
 for(let start of starts){
  // Never split a UTF-16 pair. Word-boundary trimming is deliberately unnecessary
  // for very long single tokens; every provider input still has a strict bound.
  if(start>0 && /[\uDC00-\uDFFF]/.test(text[start]))start++;
  let end=Math.min(text.length,start+size);if(end<text.length&&/[\uDC00-\uDFFF]/.test(text[end]))end--;
  const passage=text.slice(start,end).trim();if(passage.length<24)continue;
  const hash=createHash('sha256').update(passage).digest('hex');
  if(!seen.has(hash)){seen.add(hash);out.push({hash,text:passage,passage:out.length,start,end});}
 }
 return out;
}

function checkedVector(value,dimensions=null) {
 const v=embeddingVector(value);
 if(v.length>4000 || dimensions!==null&&v.length!==dimensions) throw Object.assign(new Error('conversation_embedding_dimensions_invalid'),{retryable:false});
 // Normalize in double precision before halfvec conversion; avoids overflow and
 // all-zero half-precision underflow, without dropping or truncating dimensions.
 const scale=Math.max(...v.map(Math.abs));
 const norm=Math.sqrt(v.reduce((sum,n)=>sum+(n/scale)**2,0));
 return v.map(n=>(n/scale)/norm);
}
function failure(error) {
 if(error?.message==='conversation_embedding_dimensions_invalid')return {code:error.message,retryable:false};
 return embeddingFailure(error);
}
// Provider implementations should honor AbortSignal (BrainEmbeddingProvider does).
// Still bound the caller if a custom transport/model store ignores cancellation;
// the detached promise cannot persist a vector and rejection stays observed.
function abortable(work,signal) {
 signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};
  signal.addEventListener('abort',abort,{once:true});
  Promise.resolve().then(work).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
 });
}

/** SQL-only vector ranking. The dimension is validated and interpolated so the
 * planner can match the corresponding partial HNSW expression index. */
export function conversationEmbeddingCandidateQuery({agentId,vector,dimensions,epoch,vectorSchema='public',since=null,until=null,sourceSessionId=null,role='any',includeResetHistory=true,limit=12}={}) {
 if(typeof agentId!=='string'||!agentId.trim())throw new Error('conversation_embedding_agent_required');
 if(!Number.isSafeInteger(dimensions)||dimensions<1||dimensions>4000)throw new Error('conversation_embedding_dimensions_invalid');
 const v=checkedVector(vector,dimensions),n=Math.min(200,Math.max(1,Math.floor(Number(limit)||12)));
 const type=`${ident(vectorSchema)}.halfvec(${dimensions})`,distance=`v.embedding::${type} OPERATOR(${ident(vectorSchema)}.<=>) $3::${type}`;
 const filters=`r.agent_id=$1 AND ($4::text IS NULL OR r.session_id=$4) AND r.eligible AND NOT r.summary
 AND ${scope} AND ($5::text IS NULL OR r.role=burrow_history_text($5))
 AND ($6::timestamptz IS NULL OR COALESCE(r.entry_at,f.message_at)>=$6::timestamptz)
 AND ($7::timestamptz IS NULL OR COALESCE(r.entry_at,f.message_at)<=$7::timestamptz)
 ${includeResetHistory===false?`AND NOT (${reset})`:''} AND ${canonical('r')}`;
 const sql=`WITH nearest AS MATERIALIZED (
 SELECT v.agent_id,v.hash,1-(${distance}) AS semantic_score FROM conversation_embedding_vectors v
 WHERE v.agent_id=$1 AND v.epoch=$2 AND v.dimensions=${dimensions} AND EXISTS (
 SELECT 1 FROM conversation_embedding_refs f JOIN conversation_recall_rows r USING(${key})
 JOIN conversation_sessions s USING(agent_id,session_id) WHERE f.agent_id=v.agent_id AND f.hash=v.hash AND ${filters})
 ORDER BY ${distance} LIMIT $8
 ), chosen AS MATERIALIZED (
 SELECT DISTINCT ON (r.agent_id,r.session_id,r.source_store,r.source_id,r.ordinal)
 r.agent_id,r.session_id,r.source_store,r.source_id,r.ordinal,r.entry_key,r.archive_kind,r.generation,r.created_at,r.ts_key,
 ${reset} AS reset_archive,n.semantic_score,n.semantic_score AS score
 FROM nearest n CROSS JOIN LATERAL (
 SELECT r.*,${reset} AS ignored_reset FROM conversation_embedding_refs f JOIN conversation_recall_rows r USING(${key})
 JOIN conversation_sessions s USING(agent_id,session_id)
 WHERE f.agent_id=n.agent_id AND f.hash=n.hash AND ${filters}
 ORDER BY (r.source_store='live') DESC,r.generation DESC NULLS LAST,r.ts_key COLLATE "C" DESC,r.session_id,r.source_id,r.ordinal LIMIT 1
 ) r JOIN conversation_sessions s ON s.agent_id=r.agent_id AND s.session_id=r.session_id
 ORDER BY r.agent_id,r.session_id,r.source_store,r.source_id,r.ordinal,n.semantic_score DESC
 ), selected AS MATERIALIZED (SELECT * FROM chosen ORDER BY semantic_score DESC,ts_key COLLATE "C" DESC,session_id,source_id,ordinal LIMIT $9)
 SELECT r.*,COALESCE(l.entry,a.entry) AS entry FROM selected r ${hydrate()} WHERE COALESCE(l.entry::text,a.entry::text) IS NOT NULL
 ORDER BY r.semantic_score DESC,r.ts_key COLLATE "C" DESC,r.session_id,r.source_id,r.ordinal`;
 return {sql,values:[agentId,String(epoch),JSON.stringify(v),sourceSessionId,role==='any'?null:role,instant(since),instant(until),Math.min(800,Math.max(64,n*4)),n]};
}

export class PostgresConversationEmbeddings {
 constructor({pool,models,settings,provider=new BrainEmbeddingProvider({models}),retryBaseMs=30000,retryMaxMs=3600000,batchSize=64,embeddingBatchSize=8,pollMs=2000,logger=console}={}) {
  if(!pool||typeof settings?.reconcile!=='function')throw new Error('conversation_embedding_settings_required');
  if(!Number.isSafeInteger(retryBaseMs)||retryBaseMs<1||!Number.isSafeInteger(retryMaxMs)||retryMaxMs<retryBaseMs||!Number.isSafeInteger(batchSize)||batchSize<1||batchSize>256||!Number.isSafeInteger(embeddingBatchSize)||embeddingBatchSize<1||embeddingBatchSize>256||!Number.isSafeInteger(pollMs)||pollMs<10)throw new Error('conversation_embedding_options_invalid');
  Object.assign(this,{pool,settings,provider,retryBaseMs,retryMaxMs,batchSize,embeddingBatchSize,pollMs,logger});
  this.running=null;this.timer=null;this.stopped=false;this.active=new Set();this.vectorSchema=null;this.lastError=null;this.settingSignature=null;
 }
 async reconcile() {
  let s=await this.settings.reconcile();
  if(enabled(s))s=await withPostgresTransaction(this.pool,async c=>{
   // Shared settings always precedes local state in the lock order. Do not let
   // a stale read roll the local signature backwards after concurrent configure.
   const shared=(await c.query('SELECT * FROM brain_embedding_settings WHERE singleton FOR SHARE')).rows[0];
   if(!same(s,shared))return shared;
   const state=(await c.query('SELECT * FROM conversation_embedding_state WHERE singleton FOR UPDATE')).rows[0];
   if(state.signature!==signature(s)){
    await c.query('UPDATE conversation_embedding_state SET signature=$1,epoch=epoch+1,dimensions=NULL WHERE singleton',[signature(s)]);
    await c.query("UPDATE conversation_embedding_documents SET indexed_epoch=0,attempts=0,next_attempt_at=now(),error=NULL");
    if(this.vectorSchema)await c.query('DELETE FROM conversation_embedding_vectors');
   }
   return s;
  });
  const sig=JSON.stringify([enabled(s),signature(s)]);
  if(this.settingSignature!==null&&this.settingSignature!==sig)for(const c of this.active)c.abort(new Error('conversation_embedding_settings_changed'));
  this.settingSignature=sig;
  return s;
 }
 async ensureStorage() {
  const ext=(await this.pool.query("SELECT n.nspname,to_regclass('conversation_embedding_vectors') IS NOT NULL AS present FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector' AND EXISTS (SELECT 1 FROM pg_type t WHERE t.typnamespace=n.oid AND t.typname='halfvec')")).rows[0];
  if(!ext){this.vectorSchema=null;this.lastError='conversation_embedding_pgvector_unavailable';return false;}
  if(this.vectorSchema===ext.nspname&&ext.present)return true;
  try{
   await withPostgresTransaction(this.pool,async c=>{
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended(current_schema() || ':conversation-embedding-storage',0))");
    const present=(await c.query("SELECT to_regclass('conversation_embedding_vectors') IS NOT NULL AS present")).rows[0].present;
    if(!present){
     await c.query(`CREATE TABLE conversation_embedding_vectors (
      agent_id text NOT NULL,hash text NOT NULL,epoch bigint NOT NULL,dimensions int NOT NULL CHECK(dimensions BETWEEN 1 AND 4000),
      embedding ${ident(ext.nspname)}.halfvec NOT NULL,PRIMARY KEY(agent_id,hash),
      FOREIGN KEY(agent_id,hash) REFERENCES conversation_embedding_documents ON DELETE CASCADE)`);
     // Recovery after an extension/table loss cannot trust old indexed markers.
     await c.query('UPDATE conversation_embedding_state SET epoch=epoch+1,dimensions=NULL WHERE singleton');
     await c.query('UPDATE conversation_embedding_documents SET indexed_epoch=0,attempts=0,next_attempt_at=now(),error=NULL');
    }
   });
   this.vectorSchema=ext.nspname;
   if(['conversation_embedding_pgvector_unavailable','conversation_embedding_storage_unavailable'].includes(this.lastError))this.lastError=null;
   return true;
  }catch{this.lastError='conversation_embedding_storage_unavailable';return false;}
 }
 async ensureIndex(client,dimensions) {
  const type=`${ident(this.vectorSchema)}.halfvec(${dimensions})`;
  await client.query(`CREATE INDEX IF NOT EXISTS conversation_embedding_hnsw_${dimensions} ON conversation_embedding_vectors
   USING hnsw ((embedding::${type}) ${ident(this.vectorSchema)}.halfvec_cosine_ops) WHERE dimensions=${dimensions}`);
 }
 async state(client=this.pool) {return (await client.query('SELECT * FROM conversation_embedding_state WHERE singleton')).rows[0];}
 async fence(client,s,epoch) {
  const shared=(await client.query('SELECT * FROM brain_embedding_settings WHERE singleton FOR SHARE')).rows[0];
  if(!same(s,shared))return false;
  const st=(await client.query('SELECT * FROM conversation_embedding_state WHERE singleton FOR UPDATE')).rows[0];
  return st.signature===signature(s)&&String(st.epoch)===String(epoch);
 }
 async backfillPage() {
  return withPostgresTransaction(this.pool,async c=>{
   const state=(await c.query('SELECT * FROM conversation_embedding_state WHERE singleton FOR UPDATE')).rows[0];
   if(state.backfill_complete)return 0;
   const values=state.cursor || ['','','','',-1];
   const rows=(await c.query(`SELECT ${key} FROM conversation_recall_rows WHERE (${key})>($1,$2,$3,$4,$5::bigint)
    ORDER BY ${key} LIMIT $6`,[...values,this.batchSize])).rows;
   for(const row of rows)await c.query(`INSERT INTO conversation_embedding_dirty(${key}) VALUES($1,$2,$3,$4,$5)
    ON CONFLICT(${key}) DO NOTHING`,keyValues(row));
   await c.query('UPDATE conversation_embedding_state SET cursor=$1::jsonb,backfill_complete=$2 WHERE singleton',[rows.length?JSON.stringify(keyValues(rows.at(-1))):JSON.stringify(state.cursor),rows.length<this.batchSize]);
   return rows.length;
  });
 }
 async projectDirty() {
  return withPostgresTransaction(this.pool,async c=>{
   const rows=(await c.query(`SELECT * FROM conversation_embedding_dirty ORDER BY queue_id LIMIT $1`,[this.batchSize])).rows;
   for(const dirty of rows){
    // Native writes lock recall before cascading to dirty/refs. Match that order
    // instead of row-locking a dirty JOIN first (which can deadlock an append/edit).
    await c.query(`SELECT r.ordinal FROM conversation_recall_rows r WHERE ${keyWhere('r')} FOR SHARE OF r`,keyValues(dirty));
    // Lock in one statement, hydrate in the next READ COMMITTED snapshot: if an
    // edit committed while acquisition waited, both projection and original now
    // describe that same committed payload, never an old MVCC original version.
    const r=(await c.query(`SELECT r.*,COALESCE(l.entry,a.entry) AS entry,${scope} AS visible
     FROM conversation_recall_rows r JOIN conversation_sessions s USING(agent_id,session_id) ${hydrate()}
     WHERE ${keyWhere('r')}`,keyValues(dirty))).rows[0];
    if(!r)continue;
    const queued=(await c.query('SELECT queue_id FROM conversation_embedding_dirty WHERE queue_id=$1 FOR UPDATE',[dirty.queue_id])).rows[0];
    if(!queued)continue;
    await c.query(`DELETE FROM conversation_embedding_refs WHERE ${keyWhere()}`,keyValues(r));
    if(r.visible&&r.eligible&&!r.summary&&r.entry){
     for(const p of conversationPassages(r.entry)){
      await c.query(`INSERT INTO conversation_embedding_documents(agent_id,hash,text) VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[r.agent_id,p.hash,p.text]);
      await c.query(`INSERT INTO conversation_embedding_refs(${key},passage,hash,message_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[...keyValues(r),p.passage,p.hash,instant(r.entry.ts)]);
     }
    }
    await c.query('DELETE FROM conversation_embedding_dirty WHERE queue_id=$1',[dirty.queue_id]);
   }
   return rows.length;
  });
 }
 async cleanup() {
  await withPostgresTransaction(this.pool,async c=>{
   const state=(await c.query('SELECT * FROM conversation_embedding_state WHERE singleton FOR UPDATE')).rows[0];
   const cursor=state.cleanup_cursor || ['',''];
   // LIMIT the inspected documents, not only the number of deleted orphans.
   // Otherwise an idle worker would anti-join the complete retained corpus.
   const page=(await c.query(`SELECT agent_id,hash FROM conversation_embedding_documents
    WHERE (agent_id,hash)>($1,$2) ORDER BY agent_id,hash LIMIT $3`,[...cursor,this.batchSize])).rows;
   for(const d of page)await c.query(`DELETE FROM conversation_embedding_documents d WHERE d.agent_id=$1 AND d.hash=$2
    AND NOT EXISTS(SELECT 1 FROM conversation_embedding_dirty)
    AND NOT EXISTS(SELECT 1 FROM conversation_embedding_refs f WHERE f.agent_id=d.agent_id AND f.hash=d.hash)`,[d.agent_id,d.hash]);
   await c.query('UPDATE conversation_embedding_state SET cleanup_cursor=$1::jsonb WHERE singleton',[
    page.length===this.batchSize?JSON.stringify([page.at(-1).agent_id,page.at(-1).hash]):null]);
  });
 }
 async indexOne(s,signal) {
  const st=await this.state();
  const row=(await this.pool.query(`SELECT d.* FROM conversation_embedding_documents d WHERE d.indexed_epoch=0 AND d.next_attempt_at<=now()
   AND EXISTS(SELECT 1 FROM conversation_embedding_refs f JOIN conversation_recall_rows r USING(${key}) JOIN conversation_sessions s USING(agent_id,session_id)
    WHERE f.agent_id=d.agent_id AND f.hash=d.hash AND r.eligible AND NOT r.summary AND ${scope})
   ORDER BY d.next_attempt_at,d.agent_id,d.hash LIMIT 1`)).rows[0];
  if(!row)return false;
  let phase='provider';
  try{
   const vector=checkedVector(await abortable(()=>this.provider.embed({connectionId:s.connection_id,model:s.model,text:row.text,signal}),signal),st.dimensions);
   signal.throwIfAborted();
   const current=await this.reconcile();if(!same(s,current)||signal.aborted)return false;
   phase='storage';
   await withPostgresTransaction(this.pool,async c=>{
    if(signal.aborted||!await this.fence(c,s,st.epoch))return;
    const doc=(await c.query('SELECT * FROM conversation_embedding_documents WHERE agent_id=$1 AND hash=$2 FOR UPDATE',[row.agent_id,row.hash])).rows[0];
    if(!doc)return;
    if(!(await c.query(`SELECT EXISTS(SELECT 1 FROM conversation_embedding_refs WHERE agent_id=$1 AND hash=$2) AS present`,[row.agent_id,row.hash])).rows[0].present)return;
    const state=await this.state(c);checkedVector(vector,state.dimensions);
    if(state.dimensions===null){await this.ensureIndex(c,vector.length);await c.query('UPDATE conversation_embedding_state SET dimensions=$1 WHERE singleton',[vector.length]);}
    await c.query(`INSERT INTO conversation_embedding_vectors(agent_id,hash,epoch,dimensions,embedding) VALUES($1,$2,$3,$4,$5::${ident(this.vectorSchema)}.halfvec)
     ON CONFLICT(agent_id,hash) DO UPDATE SET epoch=EXCLUDED.epoch,dimensions=EXCLUDED.dimensions,embedding=EXCLUDED.embedding`,[row.agent_id,row.hash,st.epoch,vector.length,JSON.stringify(vector)]);
    await c.query('UPDATE conversation_embedding_documents SET indexed_epoch=$3,attempts=0,error=NULL WHERE agent_id=$1 AND hash=$2',[row.agent_id,row.hash,st.epoch]);
   },{signal});
   this.lastError=null;
  }catch(error){
   if(signal.aborted)return false;
   const f=error?.message==='conversation_embedding_dimensions_invalid'||phase==='provider'?failure(error):{code:'conversation_embedding_storage_unavailable',retryable:true};
   const delay=Math.min(this.retryMaxMs,this.retryBaseMs*2**Math.min(row.attempts,30));this.lastError=f.code;
   await withPostgresTransaction(this.pool,async c=>{
    if(!await this.fence(c,s,st.epoch))return;
    await c.query(`UPDATE conversation_embedding_documents SET attempts=attempts+1,error=$3,
     next_attempt_at=CASE WHEN $4 THEN now()+($5*interval '1 millisecond') ELSE 'infinity'::timestamptz END
     WHERE agent_id=$1 AND hash=$2 AND indexed_epoch<>$6`,[row.agent_id,row.hash,f.code,f.retryable,delay,st.epoch]);
   },{signal});
  }
  return true;
 }
 start() {if(this.timer)return;this.stopped=false;this.timer=setInterval(()=>this.wake(),this.pollMs);this.timer.unref();this.wake();}
 wake() {if(!this.stopped&&!this.running)this.running=this.drain().catch(()=>{this.lastError='conversation_embedding_worker_unavailable';}).finally(()=>{this.running=null;});}
 async close() {this.stopped=true;clearInterval(this.timer);this.timer=null;for(const c of this.active)c.abort();if(this.running)await this.running;}
 async drain() {
  // Separate ownership session prevents max=1 pool deadlock during provider auth.
  const owner=new pg.Client({...this.pool.options,connectionTimeoutMillis:this.pool.options.connectionTimeoutMillis||10000});
  const controller=new AbortController();this.active.add(controller);let locked=false;
  const lost=()=>controller.abort();owner.on('error',lost);
  try{
   await owner.connect();locked=(await owner.query("SELECT pg_try_advisory_lock(hashtextextended(current_schema() || ':conversation-embedding-worker',0)) AS locked")).rows[0].locked;
   if(!locked||controller.signal.aborted)return;
   const s=await this.reconcile();
   if(!enabled(s)){
    // Clear/prune existing derived state without any provider calls. A pristine
    // disabled install only records durable dirty keys, never projects history.
    const existing=(await this.pool.query('SELECT EXISTS(SELECT 1 FROM conversation_embedding_documents) AS present')).rows[0].present;
    if(existing)await this.projectDirty();
    await this.cleanup();return;
   }
   if(!await this.ensureStorage())return;
   await this.backfillPage();await this.projectDirty();await this.cleanup();
   for(let i=0;i<this.embeddingBatchSize&&!controller.signal.aborted;i++){
    const current=await this.reconcile();if(!same(s,current))return;
    if(!await this.indexOne(s,controller.signal))break;
   }
  }finally{
   if(locked)await owner.query("SELECT pg_advisory_unlock(hashtextextended(current_schema() || ':conversation-embedding-worker',0))").catch(()=>{});
   await owner.end().catch(()=>{});this.active.delete(controller);
  }
 }
 async reindex() {
  await withPostgresTransaction(this.pool,async c=>{
   await c.query('UPDATE conversation_embedding_state SET epoch=epoch+1,dimensions=NULL,cursor=NULL,cleanup_cursor=NULL,backfill_complete=false WHERE singleton');
   await c.query('UPDATE conversation_embedding_documents SET indexed_epoch=0,attempts=0,next_attempt_at=now(),error=NULL');
   if(this.vectorSchema)await c.query('DELETE FROM conversation_embedding_vectors');
  });
  for(const c of this.active)c.abort(new Error('conversation_embedding_reindex'));this.wake();return this.status();
 }
 async status() {
  const s=await this.reconcile(),available=await this.ensureStorage(),state=await this.state();
  const lexical=await readSessionRecallReadiness(this.pool);
  const counts=(await this.pool.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE indexed_epoch=$1)::int AS indexed,
   count(*) FILTER(WHERE indexed_epoch<>$1)::int AS jobs,count(*) FILTER(WHERE error IS NOT NULL)::int AS failed,
   (SELECT count(*)::int FROM conversation_embedding_dirty) AS dirty,
   (SELECT error FROM conversation_embedding_documents WHERE error IS NOT NULL ORDER BY next_attempt_at LIMIT 1) AS error
   FROM conversation_embedding_documents`,[state.epoch])).rows[0];
  return {enabled:enabled(s),total:counts.total,indexed:counts.indexed,pending:counts.jobs+counts.dirty,failed:counts.failed,
   lastError:this.lastError||counts.error||null,storage:available?'postgres_pgvector_halfvec_hnsw':'unavailable',
   dimensions:state.dimensions,generation:String(s.generation),epoch:String(state.epoch),backfillComplete:state.backfill_complete && lexical.ready,dirty:counts.dirty};
 }
 async candidates(input={}) {
  if(typeof input.agentId!=='string'||!input.agentId.trim())throw new Error('conversation_embedding_agent_required');
  if(!input.query||typeof input.query!=='string')return [];
  const budget=archiveReadBudget(input),controller=new AbortController();this.active.add(controller);
  const signal=AbortSignal.any([budget.signal,controller.signal]);
  try{
   const s=await abortable(()=>this.reconcile(),signal);signal.throwIfAborted();
   if(!enabled(s)||!await abortable(()=>this.ensureStorage(),signal))return [];
   const state=await abortable(()=>this.state(),signal);if(!state.dimensions)return [];
   const vector=checkedVector(await abortable(()=>this.provider.embed({connectionId:s.connection_id,model:s.model,text:input.query,query:true,signal}),signal),state.dimensions);
   signal.throwIfAborted();const current=await abortable(()=>this.reconcile(),signal);if(!same(s,current)||signal.aborted)return [];
   const query=conversationEmbeddingCandidateQuery({...input,vector,dimensions:state.dimensions,epoch:state.epoch,vectorSchema:this.vectorSchema});
   return await withArchiveRead(this.pool,async c=>{
    // A settings share lock fences the entire bounded native read against config
    // updates. Local epoch additionally fences an explicit conversation reindex.
    const shared=(await c.query('SELECT * FROM brain_embedding_settings WHERE singleton FOR SHARE')).rows[0];
    const now=(await c.query('SELECT * FROM conversation_embedding_state WHERE singleton FOR SHARE')).rows[0];
    if(!same(s,shared)||String(now.epoch)!==String(state.epoch))return [];
    await c.query("SET LOCAL hnsw.ef_search=200; SET LOCAL hnsw.iterative_scan='strict_order'");
    return (await c.query(query.sql,query.values)).rows;
   },{signal,deadline:budget.deadline,readOnly:false});
  }catch(error){
   if(budget.signal.aborted)throw budget.signal.reason;
   if(controller.signal.aborted)return [];
   this.lastError=error?.message==='archive_query_timeout'?'conversation_embedding_query_timeout':failure(error).code;
   return [];
  }finally{this.active.delete(controller);budget.dispose();}
 }
}

export const __test__={checkedVector,canonical,signature};
