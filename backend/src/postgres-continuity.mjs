import { classifyRuntimeOutcome } from './runtime-outcome.mjs';
import { migrationLockKey } from './postgres-foundation.mjs';
import { RECOVERY_TRANSCRIPT_MAX_MESSAGES, assessInterruptedRunRecovery } from './recovery-resume-policy.mjs';
import { isChatMessage } from './session-entry.mjs';
import { continuityStateStore } from './postgres-continuity-state-store.mjs';
import { continuityOwner } from './postgres-continuity-owner.mjs';

// Runtime identity is not a PID: independent hosts may reuse the same PID.
const runtimeOwner = 'runtime';
export function postgresContinuity({ store, agentId, ownerId = runtimeOwner, clock = () => new Date().toISOString() }) {
 const state = continuityStateStore(store, agentId, clock);
 const owner = continuityOwner(store.pool, ownerId);
 ownerId = owner.id;
 const scope = sessionId => ({agentId,sessionId});
 const matches = (head,args,state='running') => head?.state===state && head.runId===String(args.runId) && Number(head.generation)===Number(args.generation) && head.ownerId===ownerId;
 const updateMetadata = async args => {
  await owner.ready();
  return state.update({...args, update: async (metadata,client) => {
   await owner.ready();
   return args.update(metadata,client);
  }});
 };
 return {
  async close() { await owner.close(); },
  async reconcile({sessionId}) {
   const transcript=(await store.projection({...scope(sessionId),visibility:'chat',limit:RECOVERY_TRANSCRIPT_MAX_MESSAGES,predicate:isChatMessage})).filter(isChatMessage);
   await updateMetadata({...scope(sessionId),update:async metadata=>{
    const head=metadata.continuityHead, queue=metadata.recoveryQueue;
    const abandoned=head && ['running','finalizing'].includes(head.state) && head.ownershipProtocol==='postgres-session-lock-v1' && !(await owner.alive(head.ownerId));
    const abandonedQueue=queue?.status==='running' && queue.ownershipProtocol==='postgres-session-lock-v1' && !(await owner.alive(queue.ownerId));
    if(!abandoned && !abandonedQueue)return metadata;
    // A recovery attempt is never promoted into a fresh interrupted objective.
    // If its owner disappears, preserve the original manifest and terminate the
    // same queue lineage instead of creating recovery-of-recovery work.
    if(abandonedQueue){
     if(head?.state==='completed' && head.runId===queue.claimedByRunId) return {...metadata,recoveryQueue:{...queue,status:'completed',autoResume:false,completedAt:head.completedAt},interruptedRun:{...metadata.interruptedRun,status:'recovered',recoveredByRunId:head.runId}};
     const at=clock();
     return {...metadata,recoveryQueue:{...queue,status:'failed',autoResume:false,completedAt:at,result:'recovery_owner_lost'},...(head?.runId===queue.claimedByRunId && ['running','finalizing'].includes(head.state)?{continuityHead:{...head,state:'retired',retiredAt:at,reason:'recovery_owner_lost'}}:{})};
    }
    const manifest=abandoned ? {version:1,sessionId,runId:head.runId,generation:head.generation,status:'interrupted',reason:head.state==='finalizing'?'terminal_finalization_abandoned':'process_lost',interruptedAt:clock(),objective:head.objective || transcript.findLast(entry=>entry.role==='user' || entry.role==='agent')?.content || null,pendingVerification:['Reconcile durable effects and terminal receipts before continuing.']} : metadata.interruptedRun;
    if(!manifest)return metadata;
    const assessment=await assessInterruptedRunRecovery({sessionId,manifest,readChatMessages:async()=>transcript});
    return {...metadata,interruptedRun:manifest,recoveryQueue:{version:1,key:`${manifest.runId}:${manifest.generation}`,status:'pending',decision:assessment.action,decisionReason:assessment.reason,autoResume:assessment.autoResume,transcriptMessages:assessment.transcriptMessages,queuedAt:clock(),attempts:Number(queue?.attempts||0)},...(abandoned?{continuityHead:{...head,state:'interrupted',interruptedAt:clock()}}:{})};
   }});
  },
  async read({sessionId}) {return (await state.read(sessionId))?.continuityHead || null;},
  async current(args) {await owner.ready();return matches(await this.read(args),args);},
  async claim({sessionId,runId,objective=null,expectedResetGeneration,chatInputId}) {
   await this.reconcile({sessionId});
   let result;
   await updateMetadata({...scope(sessionId),update:async (metadata,client)=>{
    if(expectedResetGeneration!==undefined && Number(metadata.resetGeneration||0)!==expectedResetGeneration) throw Object.assign(new Error('chat_input_generation_conflict'),{statusCode:409});
    if(chatInputId){
     const input=await client.query("SELECT i.status,i.generation,i.cancel_requested,(h.held AND h.generation=i.generation) AS held FROM chat_inputs i LEFT JOIN chat_input_sessions h USING(agent_id,session_id) WHERE i.id=$1 AND i.agent_id=$2 AND i.session_id=$3 AND i.run_id=$4",[chatInputId,agentId,sessionId,runId]);
     if(!input.rows[0] || input.rows[0].status!=='running' || Number(input.rows[0].generation)!==Number(metadata.resetGeneration||0) || input.rows[0].held || input.rows[0].cancel_requested) throw Object.assign(new Error('chat_input_not_admitted'),{statusCode:409});
    }
    const prior=metadata.continuityHead;
    // Never infer remote owner death from local PID state. Recovery must explicitly close it.
    const recovery=metadata.recoveryQueue;
    const recoveryBusy=recovery?.status==='running' && (recovery.ownerId!==ownerId || recovery.claimedByRunId!==runId);
    const uncertain=recoveryBusy || prior?.state==='finalizing' || (prior?.state==='running' && prior.ownerId!==ownerId);
    if(uncertain){result={...prior,current:false,reason:'active_or_abandoned_owner_requires_reconciliation'};return metadata;}
    const head={version:1,sessionId,ownerId,ownershipProtocol:'postgres-session-lock-v1',objective,processId:process.pid,generation:Number(prior?.generation||0)+1,runId:String(runId),latestRunId:prior?.latestRunId||metadata.lastRunId||null,state:'running',claimedAt:clock(),completedAt:null};
    result={...head,current:true,recoveryManifest:metadata.interruptedRun||null};
    return {...metadata,continuityHead:head,...(chatInputId && recovery?.status==='pending' && !recovery.autoResume ? {recoveryQueue:{...recovery,status:'running',claimedByRunId:String(runId),manualInputId:chatInputId,ownerId,ownershipProtocol:'postgres-session-lock-v1',autoResume:false}} : {})};
   }});return result;
  },
  async interrupt(args) {
   let manifest;
   const assessment=await assessInterruptedRunRecovery({sessionId:args.sessionId,manifest:args,readChatMessages:async({limit})=>(await store.projection({...scope(args.sessionId),visibility:'chat',limit,predicate:isChatMessage})).filter(isChatMessage)});
   await updateMetadata({...scope(args.sessionId),update:metadata=>{
    const head=metadata.continuityHead;
    manifest={version:1,sessionId:args.sessionId,runId:args.runId,generation:args.generation,status:'interrupted',reason:args.reason,interruptedAt:clock(),objective:args.objective||null,lastCompletedStep:args.lastCompletedStep||null,pendingVerification:args.pendingVerification||[],changedFiles:args.changedFiles||[],traceRef:args.traceRef||null};
    if(!['running','finalizing'].includes(head?.state) || head.ownerId!==ownerId || head?.runId!==String(args.runId) || (args.generation!=null && Number(head.generation)!==Number(args.generation))) return metadata;
    return {...metadata,interruptedRun:manifest,recoveryQueue:{version:1,key:`${args.runId}:${args.generation ?? 'unknown'}`,status:'pending',decision:assessment.action,decisionReason:assessment.reason,transcriptMessages:assessment.transcriptMessages,autoResume:assessment.autoResume,queuedAt:manifest.interruptedAt,attempts:0},continuityHead:{...head,state:'interrupted',interruptedAt:manifest.interruptedAt}};
   }});return manifest;
  },
  async pending({limit=100}={}) {
   let sessions=await state.sessions();
   for(const session of sessions) await this.reconcile({sessionId:session.sessionId});
   sessions=await state.sessions({pending:true,limit});
   return sessions.map(session=>({sessionId:session.sessionId,manifest:session.interruptedRun,continuation:session.recoveryQueue})).filter(item=>item.manifest?.status==='interrupted' && item.continuation?.autoResume && item.continuation.status==='pending').sort((a,b)=>String(a.continuation.queuedAt).localeCompare(String(b.continuation.queuedAt))).slice(0,limit);
  },
  async claimRecovery({sessionId,recoveryRunId}) {
   let result={ok:false};
   await updateMetadata({...scope(sessionId),update:metadata=>{
    const queue=metadata.recoveryQueue,manifest=metadata.interruptedRun;
    if(['running','finalizing'].includes(metadata.continuityHead?.state) || !manifest || !queue?.autoResume || queue.status!=='pending')return metadata;
    const continuation={...queue,status:'running',ownershipProtocol:'postgres-session-lock-v1',claimedAt:clock(),claimedByRunId:recoveryRunId,ownerId,attempts:Number(queue.attempts||0)+1};
    result={ok:true,manifest,continuation};return {...metadata,recoveryQueue:continuation};
   }});return result;
  },
  async completeRecovery({sessionId,recoveryRunId,ok,result}) {
   let outcome={ok:false,stale:true};
   await updateMetadata({...scope(sessionId),update:metadata=>{
    const queue=metadata.recoveryQueue;
    if(queue?.status!=='running' || queue.claimedByRunId!==recoveryRunId || queue.ownerId!==ownerId)return metadata;
    const continuation={...queue,status:ok?'completed':'failed',autoResume:false,completedAt:clock(),result};outcome={ok:true,stale:false,continuation};
    return {...metadata,recoveryQueue:continuation,...(ok&&metadata.interruptedRun?{interruptedRun:{...metadata.interruptedRun,status:'recovered',recoveredByRunId:recoveryRunId,recoveredAt:continuation.completedAt}}:{})};
   }});return outcome;
  },
  async retire({sessionId,runId,generation=null,reason='cancellation_deadline_exceeded',objective=null,recovery=false}) {
   return owner.guard(async () => {
    let outcome={ok:false,stale:true};
    await updateMetadata({...scope(sessionId),update:metadata=>{
     const head=metadata.continuityHead;
     if(head?.state!=='running' || head.ownerId!==ownerId || head.runId!==String(runId) || (generation!=null && Number(head.generation)!==Number(generation))) return metadata;
     const at=clock();
     if(recovery){
      const queue=metadata.recoveryQueue;
      const continuation=queue?.status==='running' && queue.claimedByRunId===String(runId) && queue.ownerId===ownerId
       ? {...queue,status:'failed',autoResume:false,completedAt:at,result:reason}
       : queue;
      outcome={ok:true,stale:false,head:{...head,state:'retired',retiredAt:at,reason},continuation};
      return {...metadata,continuityHead:outcome.head,recoveryQueue:continuation};
     }
     const manifest={version:1,sessionId,runId:String(runId),generation:head.generation,status:'interrupted',reason,interruptedAt:at,objective:objective||head.objective||null,lastCompletedStep:null,pendingVerification:['Reconcile durable effects and terminal receipts before continuing.'],changedFiles:[],traceRef:null};
     const continuation={version:1,key:`${manifest.runId}:${manifest.generation}`,status:'pending',decision:'needs_user_input',decisionReason:reason,transcriptMessages:0,autoResume:false,queuedAt:at,attempts:0};
     outcome={ok:true,stale:false,head:{...head,state:'retired',retiredAt:at,reason},manifest,continuation};
     return {...metadata,continuityHead:outcome.head,interruptedRun:manifest,recoveryQueue:continuation};
    }});
    return outcome;
   }, migrationLockKey(`burrow-session-boundary:${JSON.stringify([agentId,sessionId])}`));
  },
  async commit(args) {
   return owner.guard(async () => {
   let head,claimed=false;
   await updateMetadata({...scope(args.sessionId),update:metadata=>{
    head=metadata.continuityHead;
    if(!matches(head,args))return metadata;
    claimed=true;head={...head,state:'finalizing',finalizationStartedAt:clock()};return {...metadata,continuityHead:head};
   }});
   if(!claimed)return {ok:false,stale:true,head,value:null};
   let value;
   try {value=typeof args.commit==='function'?await args.commit(head):null;}
   catch(error){await this.interrupt({...args,reason:'terminal_finalization_failed'});throw error;}
   let completed=false;
   await updateMetadata({...scope(args.sessionId),update:metadata=>{
    if(!matches(metadata.continuityHead,args,'finalizing')){head=metadata.continuityHead;return metadata;}
    const at=clock();head={...metadata.continuityHead,state:'completed',latestRunId:String(args.runId),completedAt:at};completed=true;
    const manualRecovery=metadata.recoveryQueue?.manualInputId && metadata.recoveryQueue.claimedByRunId===String(args.runId);
    const recovered=classifyRuntimeOutcome(value || {}).ok;
    return {...metadata,continuityHead:head,completedAt:at,retentionEligibleAt:at,...(manualRecovery ? {
      recoveryQueue:{...metadata.recoveryQueue,status:recovered?'completed':'failed',autoResume:false,completedAt:at,result:value?.decision || (recovered?'completed':'failed')},
      ...(recovered && metadata.interruptedRun ? {interruptedRun:{...metadata.interruptedRun,status:'recovered',recoveredByRunId:String(args.runId)}} : {})} : {})};
   }});
   return {ok:completed,stale:!completed,head,value};
   }, migrationLockKey(`burrow-session-boundary:${JSON.stringify([agentId,args.sessionId])}`));
  },
 };
}
