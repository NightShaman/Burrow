import { RECOVERY_TRANSCRIPT_MAX_MESSAGES, assessInterruptedRunRecovery } from './recovery-resume-policy.mjs';
import { isChatMessage } from './session-entry.mjs';
import { continuityOwner } from './postgres-continuity-owner.mjs';

// Runtime identity is not a PID: independent hosts may reuse the same PID.
const runtimeOwner = 'runtime';
export function postgresContinuity({ store, agentId, ownerId = runtimeOwner, clock = () => new Date().toISOString() }) {
 const owner = continuityOwner(store.pool, ownerId);
 ownerId = owner.id;
 const scope = sessionId => ({agentId,sessionId});
 const matches = (head,args,state='running') => head?.state===state && head.runId===String(args.runId) && Number(head.generation)===Number(args.generation) && head.ownerId===ownerId;
 const updateMetadata = async args => {
  await owner.ready();
  return store.updateMetadata({...args, update: async metadata => {
   await owner.ready();
   return args.update(metadata);
  }});
 };
 return {
  async close() { await owner.close(); },
  async reconcile({sessionId}) {
   const transcript=(await store.projection({...scope(sessionId),visibility:'chat',limit:RECOVERY_TRANSCRIPT_MAX_MESSAGES})).filter(isChatMessage);
   await updateMetadata({...scope(sessionId),update:async metadata=>{
    const head=metadata.continuityHead, queue=metadata.recoveryQueue;
    const abandoned=head && ['running','finalizing'].includes(head.state) && head.ownershipProtocol==='postgres-session-lock-v1' && !(await owner.alive(head.ownerId));
    const abandonedQueue=queue?.status==='running' && queue.ownershipProtocol==='postgres-session-lock-v1' && !(await owner.alive(queue.ownerId));
    if(!abandoned && !abandonedQueue)return metadata;
    // An already durable terminal completion must never schedule a second turn.
    if(abandonedQueue && head?.state==='completed' && head.runId===queue.claimedByRunId) return {...metadata,recoveryQueue:{...queue,status:'completed',completedAt:head.completedAt},interruptedRun:{...metadata.interruptedRun,status:'recovered',recoveredByRunId:head.runId}};
    const manifest=abandoned ? {version:1,sessionId,runId:head.runId,generation:head.generation,status:'interrupted',reason:head.state==='finalizing'?'terminal_finalization_abandoned':'process_lost',interruptedAt:clock(),objective:head.objective || transcript.findLast(entry=>entry.role==='user' || entry.role==='agent')?.content || null,pendingVerification:['Reconcile durable effects and terminal receipts before continuing.']} : metadata.interruptedRun;
    if(!manifest)return metadata;
    const assessment=await assessInterruptedRunRecovery({sessionId,manifest,readChatMessages:async()=>transcript});
    return {...metadata,interruptedRun:manifest,recoveryQueue:{version:1,key:`${manifest.runId}:${manifest.generation}`,status:'pending',decision:assessment.action,decisionReason:assessment.reason,autoResume:assessment.autoResume,transcriptMessages:assessment.transcriptMessages,queuedAt:clock(),attempts:Number(queue?.attempts||0)},...(abandoned?{continuityHead:{...head,state:'interrupted',interruptedAt:clock()}}:{})};
   }});
  },
  async read({sessionId}) {return (await store.getMetadata(scope(sessionId)))?.continuityHead || null;},
  async current(args) {await owner.ready();return matches(await this.read(args),args);},
  async claim({sessionId,runId,objective=null}) {
   await this.reconcile({sessionId});
   let result;
   await updateMetadata({...scope(sessionId),update:metadata=>{
    const prior=metadata.continuityHead;
    // Never infer remote owner death from local PID state. Recovery must explicitly close it.
    const recovery=metadata.recoveryQueue;
    const recoveryBusy=recovery?.status==='running' && (recovery.ownerId!==ownerId || recovery.claimedByRunId!==runId);
    const uncertain=recoveryBusy || prior?.state==='finalizing' || (prior?.state==='running' && prior.ownerId!==ownerId);
    if(uncertain){result={...prior,current:false,reason:'active_or_abandoned_owner_requires_reconciliation'};return metadata;}
    const head={version:1,sessionId,ownerId,ownershipProtocol:'postgres-session-lock-v1',objective,processId:process.pid,generation:Number(prior?.generation||0)+1,runId:String(runId),latestRunId:prior?.latestRunId||metadata.lastRunId||null,state:'running',claimedAt:clock(),completedAt:null};
    result={...head,current:true,recoveryManifest:metadata.interruptedRun||null};
    return {...metadata,continuityHead:head};
   }});return result;
  },
  async interrupt(args) {
   let manifest;
   const assessment=await assessInterruptedRunRecovery({sessionId:args.sessionId,manifest:args,readChatMessages:async({limit})=>(await store.projection({...scope(args.sessionId),visibility:'chat',limit})).filter(isChatMessage)});
   await updateMetadata({...scope(args.sessionId),update:metadata=>{
    const head=metadata.continuityHead;
    manifest={version:1,sessionId:args.sessionId,runId:args.runId,generation:args.generation,status:'interrupted',reason:args.reason,interruptedAt:clock(),objective:args.objective||null,lastCompletedStep:args.lastCompletedStep||null,pendingVerification:args.pendingVerification||[],changedFiles:args.changedFiles||[],traceRef:args.traceRef||null};
    if(!['running','finalizing'].includes(head?.state) || head.ownerId!==ownerId || head?.runId!==String(args.runId) || (args.generation!=null && Number(head.generation)!==Number(args.generation))) return metadata;
    return {...metadata,interruptedRun:manifest,recoveryQueue:{version:1,key:`${args.runId}:${args.generation ?? 'unknown'}`,status:'pending',decision:assessment.action,decisionReason:assessment.reason,transcriptMessages:assessment.transcriptMessages,autoResume:assessment.autoResume,queuedAt:manifest.interruptedAt,attempts:0},continuityHead:{...head,state:'interrupted',interruptedAt:manifest.interruptedAt}};
   }});return manifest;
  },
  async pending({limit=100}={}) {
   let sessions=await store.listSessions({agentId,includeArchived:true});
   for(const session of sessions) await this.reconcile({sessionId:session.sessionId});
   sessions=await store.listSessions({agentId,includeArchived:true});
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
    const continuation={...queue,status:ok?'completed':'failed',completedAt:clock(),result};outcome={ok:true,stale:false,continuation};
    return {...metadata,recoveryQueue:continuation,...(ok&&metadata.interruptedRun?{interruptedRun:{...metadata.interruptedRun,status:'recovered',recoveredByRunId:recoveryRunId,recoveredAt:continuation.completedAt}}:{})};
   }});return outcome;
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
    return {...metadata,continuityHead:head,completedAt:at,retentionEligibleAt:at};
   }});
   return {ok:completed,stale:!completed,head,value};
   });
  },
 };
}
