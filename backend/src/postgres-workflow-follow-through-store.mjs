import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { withPostgresTransaction } from './postgres-foundation.mjs';
import { normalizeWaitTarget, waitText, waitId, lockWaitIdentity } from './task-workflow-wait.mjs';
import { buildSessionEntry } from './session-entry.mjs';

function row(r) {
  if (!r) return null;
  return { id:r.id, agentId:r.agent_id, sessionId:r.session_id, conversationId:r.conversation_id, resetIdentity:r.reset_identity,
    repository:r.repository, workflow:r.workflow, runId:r.run_id, runAttempt:r.run_attempt, headSha:r.head_sha, checkpoint:r.checkpoint,
    source:r.source, status:r.status, completion:r.completion, result:r.result, error:r.error,
    modReturnId:r.mod_return_id,
    executionSessionId:r.execution_session_id, executionRunId:r.execution_run_id,
    registeredAt:r.registered_at, matchedAt:r.matched_at, claimedAt:r.claimed_at, finishedAt:r.finished_at };
}

/** Durable board-free waits for exact GitHub workflows or passive mod receipts. Public API: register(target, owner), getOwned({id,agentId}),
 * subscribe(fn)/publish(), claim(), finish(id,{status,result,error}), reconcile(). Checkpoints must
 * contain no credentials. claim is one-shot: claimed rows are never replayed after restart. */
export class PostgresWorkflowFollowThroughStore {
  constructor({ pool, maxAnswerChars = 12000 } = {}) {
    if (!pool?.query || !pool?.connect) throw new Error('workflow_follow_through_postgres_pool_required');
    this.pool=pool; this.listeners=new Set(); this.maxAnswerChars=maxAnswerChars;
  }
  subscribe(fn) { if (typeof fn!=='function') throw new Error('workflow_follow_through_invalid_subscriber'); this.listeners.add(fn); return () => this.listeners.delete(fn); }
  publish() { for (const fn of this.listeners) { try { fn(); } catch {} } }
  boundAnswer(answer) {
    return answer.replaceAll('\u0000', '').slice(0, this.maxAnswerChars).replace(/[\uD800-\uDBFF]$/, '').toWellFormed();
  }
  async register(input={}, owner={}) {
    const target=normalizeWaitTarget(input);
    const checkpoint=waitText(input.checkpoint,'checkpoint',20000);
    const agentId=waitText(owner.agentId,'agentId'), sessionId=waitText(owner.sessionId,'sessionId'), conversationId=waitText(owner.conversationId,'conversationId'), resetIdentity=waitText(owner.resetIdentity,'resetIdentity');
    const originRunId=waitText(owner.runId,'originRunId'), executionRunId=owner.executionRunId==null?null:waitText(owner.executionRunId,'executionRunId'), executionSessionId=owner.executionSessionId==null?null:waitText(owner.executionSessionId,'executionSessionId');
    const source={agentId,sessionId,conversationId,resetIdentity,runId:originRunId,...(executionSessionId?{executionSessionId}:{}),...(executionRunId?{executionRunId}:{}),...(owner.handoffId?{handoffId:waitText(owner.handoffId,'handoffId')}: {})};
    const id=await withPostgresTransaction(this.pool,async c=>{
      await lockWaitIdentity(c,target.repository,target.runId,target.runAttempt);
      if (owner.handoffId) {
        const { rows: ancestor } = await c.query(`WITH RECURSIVE chain AS (
          SELECT * FROM workflow_follow_through_waits WHERE id=$1 AND agent_id=$2
          UNION ALL SELECT w.* FROM workflow_follow_through_waits w JOIN chain x ON w.id::text=x.source->>'handoffId' WHERE w.agent_id=$2
        ) SELECT id FROM chain WHERE repository=$3 AND workflow=$4 AND run_id=$5 AND run_attempt=$6 AND head_sha=$7 LIMIT 1`,
        [waitId(owner.handoffId),agentId,target.repository,target.workflow,target.runId,target.runAttempt,target.headSha]);
        if (ancestor.length) throw new Error('workflow_follow_through_cycle');
      }
      const prior=(await c.query(`SELECT * FROM workflow_follow_through_waits WHERE agent_id=$1 AND session_id=$2 AND conversation_id=$3 AND reset_identity=$4 AND source=$5::jsonb AND repository=$6 AND workflow=$7 AND run_id=$8 AND run_attempt=$9 AND head_sha=$10`,[agentId,sessionId,conversationId,resetIdentity,JSON.stringify(source),target.repository,target.workflow,target.runId,target.runAttempt,target.headSha])).rows[0];
      if(prior){ if(prior.checkpoint!==checkpoint) throw new Error('workflow_follow_through_registration_conflict'); return prior.id; }
      const id=randomUUID();
      await c.query(`INSERT INTO workflow_follow_through_waits(id,agent_id,session_id,conversation_id,reset_identity,repository,workflow,run_id,run_attempt,head_sha,checkpoint,source)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,[id,agentId,sessionId,conversationId,resetIdentity,target.repository,target.workflow,target.runId,target.runAttempt,target.headSha,checkpoint,JSON.stringify(source)]);
      const early=(await c.query('SELECT completion FROM github_completion_inbox WHERE repository=$1 AND run_id=$2 AND run_attempt=$3',[target.repository,target.runId,target.runAttempt])).rows[0]?.completion;
      if(early) await matchWorkflowFollowThrough(c,early);
      return id;
    });
    this.publish(); return this.getOwned({id,agentId});
  }
  async registerModWait({ id, checkpoint }, owner = {}) {
    id=waitId(id); checkpoint=waitText(checkpoint,'checkpoint',20000);
    const agentId=waitText(owner.agentId,'agentId'), sessionId=waitText(owner.sessionId,'sessionId'), conversationId=waitText(owner.conversationId,'conversationId'), resetIdentity=waitText(owner.resetIdentity,'resetIdentity');
    const originRunId=waitText(owner.runId,'originRunId'), executionRunId=owner.executionRunId==null?null:waitText(owner.executionRunId,'executionRunId'), executionSessionId=owner.executionSessionId==null?null:waitText(owner.executionSessionId,'executionSessionId');
    const source={agentId,sessionId,conversationId,resetIdentity,runId:originRunId,...(executionSessionId?{executionSessionId}:{}),...(executionRunId?{executionRunId}:{}),...(owner.handoffId?{handoffId:waitText(owner.handoffId,'handoffId')}: {})};
    const found=await withPostgresTransaction(this.pool,async c=>{
      const receipt=(await c.query('SELECT * FROM mod_follow_through_returns WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if(!receipt || !receipt.wait_only) throw new Error('workflow_follow_through_mod_receipt_unavailable');
      const expectedSession=executionSessionId||sessionId;
      if(receipt.agent_id!==agentId || receipt.session_id!==expectedSession || receipt.origin_run_id!==(executionRunId||originRunId)) throw new Error('workflow_follow_through_owner_mismatch');
      if(!executionSessionId && (receipt.conversation_id!==conversationId || receipt.reset_identity!==resetIdentity)) throw new Error('workflow_follow_through_owner_mismatch');
      const prior=(await c.query('SELECT * FROM workflow_follow_through_waits WHERE mod_return_id=$1',[id])).rows[0];
      if(prior) { if(prior.checkpoint!==checkpoint || prior.agent_id!==agentId || prior.session_id!==sessionId || !isDeepStrictEqual(prior.source,source)) throw new Error('workflow_follow_through_registration_conflict'); return prior.id; }
      const waitIdValue=randomUUID();
      await c.query(`INSERT INTO workflow_follow_through_waits(id,agent_id,session_id,conversation_id,reset_identity,repository,workflow,run_id,run_attempt,head_sha,checkpoint,source,mod_return_id)
        VALUES($1,$2,$3,$4,$5,NULL,NULL,NULL,NULL,NULL,$6,$7::jsonb,$8)`,[waitIdValue,agentId,sessionId,conversationId,resetIdentity,checkpoint,JSON.stringify(source),id]);
      if(receipt.state==='ready') {
        const completion={modId:receipt.owner_mod_id,receiptId:receipt.id,result:receipt.result};
        await c.query(`UPDATE workflow_follow_through_waits SET status='matched',completion=$2::jsonb,matched_at=now() WHERE id=$1 AND status='waiting'`,[waitIdValue,JSON.stringify(completion)]);
      }
      return waitIdValue;
    });
    this.publish(); return this.getOwned({id:found,agentId});
  }
  async getOwned({id,agentId}={}) {
    id=waitId(id); agentId=waitText(agentId,'agentId');
    return row((await this.pool.query('SELECT * FROM workflow_follow_through_waits WHERE id=$1 AND agent_id=$2',[id,agentId])).rows[0]);
  }
  async claim() {
    return withPostgresTransaction(this.pool,async c=>{
      const r=(await c.query(`SELECT w.* FROM workflow_follow_through_waits w WHERE w.status='matched'
        AND (w.mod_return_id IS NULL OR NOT EXISTS (SELECT 1 FROM continuity_state s WHERE s.agent_id=w.agent_id
          AND s.session_id=COALESCE(w.source->>'executionSessionId',w.session_id) AND s.head_state IN ('running','finalizing')))
        ORDER BY w.matched_at,w.id FOR UPDATE OF w SKIP LOCKED LIMIT 1`)).rows[0];
      if(!r) return null;
      const session=`workflow-follow-through-${r.id}`, run=`workflow-follow-through-${r.id}`;
      return row((await c.query(`UPDATE workflow_follow_through_waits SET status='claimed',claimed_at=now(),execution_session_id=$2,execution_run_id=$3 WHERE id=$1 AND status='matched' RETURNING *`,[r.id,session,run])).rows[0]);
    });
  }
  async finish(id, outcome = {}) { return this.settle(id, outcome); }
  async settle(id,{status,result=null,error=null}={}) {
    id=waitId(id); if(!['report_ready','continued','failed','fenced'].includes(status)) throw new Error('workflow_follow_through_invalid_outcome');
    if(status==='report_ready') {
      const answer=result?.answerText;
      if(typeof answer!=='string'||!answer.trim()||answer.length>this.maxAnswerChars||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\u0000/.test(answer)) throw new Error('workflow_follow_through_answer_invalid');
      try { if(Buffer.byteLength(JSON.stringify(result),'utf8')>this.maxAnswerChars*4+4000) throw new Error(); } catch { throw new Error('workflow_follow_through_result_invalid'); }
    }
    if(error!=null) error=waitText(error,'error',4000);
    return withPostgresTransaction(this.pool,async c=>{
      const current=(await c.query('SELECT * FROM workflow_follow_through_waits WHERE id=$1 FOR UPDATE',[id])).rows[0];
      if (!current) throw new Error('workflow_follow_through_claim_not_active');
      if (current.status !== 'claimed') return row(current); // Terminal acknowledgment replay, not another run.
      if (status === 'report_ready') {
        const next = (await c.query(`SELECT id FROM workflow_follow_through_waits WHERE agent_id=$1 AND source->>'handoffId'=$2 ORDER BY registered_at,id`,[current.agent_id,id])).rows;
        if (next.length) { status='continued'; result={ nextWaitIds: next.map(x=>x.id) }; error=null; }
      }
      return row((await c.query(`UPDATE workflow_follow_through_waits SET status=$2,result=$3::jsonb,error=$4,finished_at=CASE WHEN $2='report_ready' THEN NULL ELSE now() END WHERE id=$1 RETURNING *`,[id,status,result==null?null:JSON.stringify(result),error])).rows[0]);
    });
  }
  async flushDeliveries({ conversations, limit=16 }={}) {
    if (!conversations?.appendLocked) throw new Error('workflow_follow_through_conversation_authority_required');
    if (!Number.isInteger(limit) || limit<1 || limit>100) throw new Error('workflow_follow_through_invalid_limit');
    const done=[];
    for (let i=0;i<limit;i++) {
      const outcome=await withPostgresTransaction(this.pool,async c=>{
        const selected=(await c.query(`SELECT w.* FROM workflow_follow_through_waits w WHERE w.status='report_ready' AND NOT (w.id = ANY($1::uuid[]))
          AND NOT EXISTS (SELECT 1 FROM continuity_state s WHERE s.agent_id=w.agent_id AND s.session_id=w.session_id AND s.head_state IN ('running','finalizing'))
          ORDER BY w.registered_at,w.id FOR UPDATE OF w SKIP LOCKED LIMIT 1`,[done.map(x=>x.id)])).rows[0];
        if(!selected) return null;
        const conv=(await c.query(`SELECT metadata,created_at,updated_at FROM conversation_sessions WHERE agent_id=$1 AND session_id=$2 FOR UPDATE`,[selected.agent_id,selected.session_id])).rows[0];
        if(!conv) { await c.query(`UPDATE workflow_follow_through_waits SET status='fenced',error='origin_conversation_missing',finished_at=now() WHERE id=$1`,[selected.id]); return {id:selected.id,status:'fenced'}; }
        const metadata=conv.metadata||{};
        const resetIdentity=`${Number(metadata.resetGeneration||0)}:${new Date(conv.created_at).toISOString()}`;
        const conversationId=String(metadata.conversationId||selected.session_id);
        if(metadata.archived||metadata.deleted||conversationId!==selected.conversation_id||resetIdentity!==selected.reset_identity) {
          await c.query(`UPDATE workflow_follow_through_waits SET status='fenced',error='origin_conversation_identity_changed',finished_at=now() WHERE id=$1`,[selected.id]); return {id:selected.id,status:'fenced'};
        }
        const durable=(await c.query('SELECT head_state,head FROM continuity_state WHERE agent_id=$1 AND session_id=$2',[selected.agent_id,selected.session_id])).rows[0];
        const head=durable?.head || metadata.continuityHead || null;
        if(['running','finalizing'].includes(durable?.head_state||head?.state)) return {id:selected.id,status:'pending'};
        const answer=selected.result?.answerText;
        if(typeof answer!=='string'||!answer.trim()||answer.length>this.maxAnswerChars||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|\u0000/.test(answer)) {
          await c.query(`UPDATE workflow_follow_through_waits SET status='fenced',error='workflow_follow_through_answer_invalid',finished_at=now() WHERE id=$1`,[selected.id]); return {id:selected.id,status:'fenced'};
        }
        // The existing chat revalidation cursor is millisecond-resolution.
        // Publish a strictly newer revision even when two writes share a tick.
        const now=new Date(Math.max(Date.now(), new Date(conv.updated_at).getTime()+1)).toISOString();
        const entry=buildSessionEntry({sessionId:selected.session_id,type:'message',role:'assistant',content:answer,runId:`${selected.execution_run_id}-report`,clock:()=>now,metadata:{source:'workflow-follow-through',workflowFollowThrough:{waitId:selected.id,originRunId:selected.source?.runId,completion:selected.mod_return_id ? { modId:selected.completion?.modId,receiptId:selected.mod_return_id } : selected.completion,isolatedExecutionSessionId:selected.execution_session_id,isolatedExecutionRunId:selected.execution_run_id}}});
        await conversations.appendLocked(c,{agentId:selected.agent_id,sid:selected.session_id,entry,idempotencyKey:`workflow-follow-through:${selected.id}`,now});
        await c.query(`UPDATE workflow_follow_through_waits SET status='delivered',finished_at=$2 WHERE id=$1 AND status='report_ready'`,[selected.id,now]);
        return {id:selected.id,status:'delivered'};
      });
      if(!outcome) break;
      done.push(outcome);
    }
    return {processed:done.length,results:done};
  }
  async reconcile() {
    // The singleton Core producer owns this queue. Never replay an ambiguous
    // claim. A successor checkpoint remains valid even if its parent crashed.
    const claimed=(await this.pool.query("SELECT id FROM workflow_follow_through_waits WHERE status='claimed' ORDER BY claimed_at,id")).rows;
    for (const {id} of claimed) await this.settle(id,{ status:'report_ready', error:'workflow_follow_through_interrupted',
      result:{ok:false,answerText:'Background workflow follow-through was interrupted by a restart. The work may have partially executed; check its recorded run before retrying.'} });
    return { interrupted:claimed.map(r=>r.id) };
  }
}

export async function matchWorkflowFollowThrough(client, completion) {
  const target=normalizeWaitTarget(completion);
  const {rows}=await client.query(`SELECT * FROM workflow_follow_through_waits WHERE status='waiting' AND repository=$1 AND workflow=$2 AND run_id=$3 AND run_attempt=$4 AND head_sha=$5 FOR UPDATE`,[target.repository,target.workflow,target.runId,target.runAttempt,target.headSha]);
  for(const r of rows) await client.query(`UPDATE workflow_follow_through_waits SET status='matched',completion=$2::jsonb,matched_at=now() WHERE id=$1`,[r.id,JSON.stringify(completion)]);
  return rows.map(r=>r.id);
}
