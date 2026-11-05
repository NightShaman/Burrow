import { normalizePostgresPool, withPostgresTransaction } from './postgres-foundation.mjs';
import { withArchiveRead } from './postgres-archive-read.mjs';

// Included by POSTGRES_SESSION_RETRIEVAL_SQL. No source scan, counting or source
// index build belongs here: the migration runs while source DDL locks are held.
export const POSTGRES_SESSION_RECALL_BACKFILL_SQL = `
CREATE TABLE conversation_recall_backfill (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 phase text NOT NULL DEFAULT 'live' CHECK(phase IN ('live','archive','complete')),
 after_agent text,after_session text,after_source text,after_ordinal bigint,
 processed_rows bigint NOT NULL DEFAULT 0,pages bigint NOT NULL DEFAULT 0,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),completed_at timestamptz
);
INSERT INTO conversation_recall_backfill(singleton) VALUES(true);
`;

const readinessOf = row => ({ready:row.phase==='complete',state:row.phase==='complete'?'ready':'backfilling',
 phase:row.phase,processedRows:Number(row.processed_rows),pages:Number(row.pages),
 checkpoint:row.after_agent===null?null:{agentId:row.after_agent,sessionId:row.after_session,sourceId:row.after_source,ordinal:row.after_ordinal},
 updatedAt:row.updated_at,completedAt:row.completed_at});
export async function sessionRecallReadinessInTransaction(client) {
 const {rows}=await client.query('SELECT * FROM conversation_recall_backfill WHERE singleton');
 if(!rows[0]) throw new Error('session_recall_checkpoint_missing');
 return readinessOf(rows[0]);
}
export function readSessionRecallReadiness(pool,options={}) {
 return withArchiveRead(pool,sessionRecallReadinessInTransaction,options);
}
export const sessionRecallNotReady = readiness => Object.assign(new Error('session_recall_not_ready'),
 {code:'session_recall_not_ready',status:503,readiness});

/** Durable native-keyset worker; one bounded transaction/checkpoint per page.
 * No SKIP LOCKED: advancing past a locked source would permanently omit history.
 * Source row locks and a native re-read in the INSERT serialize edits/deletes;
 * existing trigger projections always win (ON CONFLICT DO NOTHING).
 */
export function createSessionRecallBackfillWorker({pool:rawPool,pageSize=16,pollIntervalMs=100,
 statementTimeoutMs=15000,lockTimeoutMs=1000,onError=()=>{}}={}) {
 const pool=normalizePostgresPool(rawPool);
 if(!Number.isInteger(pageSize)||pageSize<1||pageSize>256)throw new Error('session_recall_page_size_invalid');
 for(const n of [pollIntervalMs,statementTimeoutMs,lockTimeoutMs])if(!Number.isFinite(n)||n<1)throw new Error('session_recall_worker_timeout_invalid');
 let closed=false,started=false,timer=null,inflight=null,controller=null,lastError=null,notifiedError=null;
 const status=async()=>({...await readSessionRecallReadiness(pool),lastError:lastError ? (['55P03','57014'].includes(lastError.code)?'session_recall_backfill_retrying':'session_recall_backfill_failed') : null});
 function runPage(){
  if(closed)return Promise.reject(new Error('session_recall_worker_closed'));
  if(inflight)return inflight;
  controller=new AbortController();
  const pageController=controller;
  const timeout=setTimeout(()=>pageController.abort(new Error('session_recall_page_timeout')),statementTimeoutMs);timeout.unref?.();
  inflight=withPostgresTransaction(pool,async client=>{
   await client.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
   await client.query("SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$2,true),set_config('jit','off',true)",
    [String(statementTimeoutMs),String(lockTimeoutMs)]);
   const checkpoint=(await client.query('SELECT * FROM conversation_recall_backfill WHERE singleton FOR UPDATE')).rows[0];
   if(!checkpoint)throw new Error('session_recall_checkpoint_missing');
   if(checkpoint.phase==='complete')return readinessOf(checkpoint);
   const live=checkpoint.phase==='live';
   // Both order and predicate use the EXISTING native primary key, not the
   // original_rows union or an OFFSET. Returned keys contain no original bodies.
   const table=live?'conversation_entries':'conversation_archive_entries';
   const tuple=live?'(agent_id,session_id,sequence)':"(agent_id,session_id,source_store,source_id,ordinal)";
   const bind=live?'($1::text,$2::text,$4::bigint)':"($1::text,$2::text,'archive'::text,$3::text,$4::bigint)";
   const values=[checkpoint.after_agent,checkpoint.after_session,checkpoint.after_source,checkpoint.after_ordinal,pageSize];
   const keys=(await client.query(`SELECT agent_id,session_id,${live?"sequence::text AS source_id,sequence AS ordinal":"source_id,ordinal"}
    FROM ${table} WHERE ($3::text IS NULL OR $3::text IS NOT NULL) AND ($1::text IS NULL OR ${tuple}>${bind})
    ORDER BY ${live?'agent_id,session_id,sequence':'agent_id,session_id,source_store,source_id,ordinal'} LIMIT $5`,values)).rows;
   // Acquire parent FK locks BEFORE source locks, matching reset/rename/delete
   // ownership. Otherwise reset's parent FOR UPDATE + source DELETE can deadlock
   // against backfill's source FOR UPDATE + recall FK KEY SHARE.
   const sessions=[...new Map(keys.map(key=>[JSON.stringify([key.agent_id,key.session_id]),key])).values()];
   for(const key of sessions)await client.query('SELECT 1 FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR KEY SHARE',[key.agent_id,key.session_id]);
   for(const key of keys){
    // Recheck the native key after parent locking. Concurrent deletion/key move
    // can remove it; its trigger has already removed/moved the projection.
    const locked=await client.query(`SELECT 1 FROM ${table} WHERE ($3::text IS NULL OR $3::text IS NOT NULL)
     AND agent_id=$1 AND session_id=$2 AND ${live?'sequence=$4::bigint':"source_store='archive' AND source_id=$3 AND ordinal=$4::bigint"} FOR UPDATE`,
     [key.agent_id,key.session_id,key.source_id,key.ordinal]);
    if(!locked.rows.length)continue;
    await client.query(`INSERT INTO conversation_recall_rows
     SELECT r.agent_id,r.session_id,'${live?'live':'archive'}',${live?'r.sequence::text,r.sequence':'r.source_id,r.ordinal'},r.entry_key,p.logical_key,
      ${live?'NULL,NULL':'r.archive_kind,r.generation'},r.created_at::timestamptz,
      p.haystack,p.content_key,p.grams,p.rank_weight,p.role,p.summary,p.eligible,p.ts_key,p.entry_at,p.ts_fallback
     FROM ${table} r CROSS JOIN LATERAL burrow_recall_project_cached(r.agent_id,r.session_id,r.entry_id,r.entry_key,r.entry) p
     WHERE ($3::text IS NULL OR $3::text IS NOT NULL) AND r.agent_id=$1 AND r.session_id=$2 AND ${live?'r.sequence=$4::bigint':"r.source_store='archive' AND r.source_id=$3 AND r.ordinal=$4::bigint"}
      AND NOT EXISTS(SELECT 1 FROM conversation_recall_rows x WHERE x.agent_id=r.agent_id AND x.session_id=r.session_id
       AND x.source_store='${live?'live':'archive'}' AND x.source_id=${live?'r.sequence::text':'r.source_id'} AND x.ordinal=${live?'r.sequence':'r.ordinal'})
     ON CONFLICT DO NOTHING`,[key.agent_id,key.session_id,key.source_id,key.ordinal]);
   }
   // An empty page, not a short one, terminates a phase. A concurrent trigger
   // covers inserts behind the cursor and all inserts after completion.
   const last=keys.at(-1);
   const next=last?checkpoint.phase:(live?'archive':'complete');
   const result=await client.query(`UPDATE conversation_recall_backfill SET phase=$1,after_agent=$2,after_session=$3,after_source=$4,after_ordinal=$5,
    processed_rows=processed_rows+$6,pages=pages+1,updated_at=clock_timestamp(),
    completed_at=CASE WHEN $1='complete' THEN clock_timestamp() ELSE NULL END WHERE singleton RETURNING *`,
    [next,last?.agent_id??null,last?.session_id??null,last?.source_id??null,last?.ordinal??null,keys.length]);
   return readinessOf(result.rows[0]);
  },{signal:controller.signal}).then(result=>{lastError=null;return result;}).catch(error=>{lastError=error;throw error;})
   .finally(()=>{clearTimeout(timeout);inflight=null;controller=null;});
  return inflight;
 }
 function schedule(){
  if(closed||!started||timer)return;
  timer=setTimeout(async()=>{
   timer=null;
   try{const result=await runPage();notifiedError=null;if(result.ready){started=false;return;}}
   catch(error){const code=error.code||'session_recall_backfill_failed';if(!closed&&code!==notifiedError){notifiedError=code;try{onError({code});}catch{ /* diagnostic only */ }}}
   schedule();
  },pollIntervalMs);timer.unref?.();
 }
 function start(){if(closed)throw new Error('session_recall_worker_closed');started=true;schedule();}
 async function drain(){
  while(!closed){const result=await runPage();if(result.ready)return result;}
  throw lastError||new Error('session_recall_worker_closed');
 }
 async function close(){closed=true;started=false;clearTimeout(timer);timer=null;
  controller?.abort(new Error('session_recall_worker_closed'));
  try{await inflight;}catch{ /* owned transaction has rolled back before release */ }
 }
 return {start,runPage,drain,status,close};
}
