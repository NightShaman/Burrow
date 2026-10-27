import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Chat } from '../../src/features/chat/ChatPage';
import { ChatArchiveReader } from '../../src/features/tasks/ArchiveReaders';
import { projectChatActivity } from '../../src/features/chat/chatActivityProjection';
import { reconcileChatInputs, type ChatInput } from '../../src/features/chat/chatInputs';
import type { Agent } from '../../src/app/types';
import type { ChatAttachment } from '../../src/app/api';
import '../../src/app.css';
const at = new Date().toISOString();
const base: ChatInput = { id:'side-1',intent:'side_question',status:'succeeded',agentId:'fixture',sessionId:'default',generation:3,targetRunId:'main',runId:'side-run',createdAt:at,startedAt:at,completedAt:at,message:'Does this snapshot include the latest deployment, or only the work that was already visible?',attachments:[],result:{ok:true,answerText:'Only the captured work is included. The deployment was not verified by this snapshot.\n\nKeep the main run working; ask it to verify deployment explicitly if that becomes necessary.',decision:null,blockers:[]},error:null,snapshot:{id:'snapshot-fixture',capturedAt:at,originRunId:'main',phase:'tool-running',entryCount:24},promotedFrom:null,position:null };
let inputs: ChatInput[] = [base,{...base,id:'queue-1',intent:'queue_next',status:'held',runId:'queued-run',message:'After the current work, check keyboard navigation with long realistic conversation text and narrow desktop columns.',snapshot:null,result:null,position:1}];
let failNext = false;
const requests: string[] = [];
window.fetch = async (url, init) => {
 const path = String(url); const method = init?.method ?? 'GET';
 if (!path.startsWith('/api/')) throw new Error('Fixture blocks non-API fetch');
 let response: unknown = {};
 if (method === 'POST') { requests.push(`${method} ${path}`); document.getElementById('requests')!.textContent = requests.join(' | '); }
 if (failNext && method === 'POST') { failNext=false; return new Response(JSON.stringify({error:'chat_run_not_found'}),{status:404}); }
 if (path.includes('/api/chat/inputs?')) response = {generation:3,inputs};
 else if (path === '/api/chat/inputs') { const body=JSON.parse(String(init?.body)); const input={...base,...body,id:`input-${inputs.length}`,runId:`run-${inputs.length}`,createdAt:new Date().toISOString(),completedAt:null,status:body.intent==='side_question'?'succeeded':'queued',snapshot:body.intent==='side_question'?base.snapshot:null,result:body.intent==='side_question'?base.result:null,position:inputs.length}; inputs=[...inputs,input]; response={input}; }
 else if (path.endsWith('/resume')) {inputs=inputs.map(i=>i.status==='held'?{...i,status:'queued'}:i);response={input:inputs[1],inputs};}
 else if (path.endsWith('/cancel')) {const id=path.split('/').at(-2);inputs=inputs.map(i=>i.id===id?{...i,status:'cancelled'}:i);response={input:inputs.find(i=>i.id===id)};}
 else if (path.endsWith('/steer')) { const body=JSON.parse(String(init?.body)); response={steering:{id:`steer-${requests.length}`,status:'pending',message:body.message,createdAt:new Date().toISOString()}}; }
 else if (path.includes('/steering?')) response={steering:[]};
 else if (path.includes('/conversation-project?')) response={project:null};
 else throw new Error(`Unexpected fixture request: ${method} ${path}`);
 return new Response(JSON.stringify(response),{headers:{'content-type':'application/json'}});
};
const agent: Agent = {id:'fixture',name:'Hatchet',avatar:'H',activity:'',context:null,provider:'',model:'',effort:'',temperature:1,workspace:'',files:[],subagents:[]};
function Fixture() {
 const [draft,setDraft]=useState('Keep the main task running; this is a follow-up.');
 const [attached,setAttached]=useState<ChatAttachment[]>([]);
 const [busy,setBusy]=useState(true),[archive,setArchive]=useState(false),[reset,setReset]=useState(0);
 const runtime=projectChatActivity({ok:true,runs:[{runId:'side-run',lane:'side_question',agentId:'fixture',sessionId:'default',status:'running'},{runId:'main',lane:'main',agentId:'fixture',sessionId:'default',status:busy?'running':'completed',steeringReady:true}]},{agentId:'fixture',sessionId:'default',isChildSession:false,hadRuns:false,now:0}).runtimeRun;
 return <><header style={{display:'flex',gap:10,padding:12,flexWrap:'wrap'}}><strong>Local fixture · no runtime reads/writes</strong><button onClick={()=>setBusy(!busy)}>{busy?'Finish main':'Start main'}</button><button onClick={()=>{failNext=true;}}>Reject next submission</button><button onClick={()=>setArchive(!archive)}>Toggle archive</button><button onClick={()=>{inputs=[];setDraft('');setReset(v=>v+1);}}>Reset generation</button><output id="requests" aria-label="Fixture requests" /></header><main style={{height:'calc(100dvh - 100px)',maxWidth:1100,margin:'auto',display:'flex',flexDirection:'column'}}>{archive?<ChatArchiveReader session={{agentId:'fixture',agentName:'Hatchet',sessionId:'default',title:'Snapshot proof'}} detail={{turns:reconcileChatInputs([],inputs)}} loading={false} error="" earlierLoading={false} earlierError="" historyUnavailable={false} onLoadEarlier={()=>{}} onRestart={()=>{}} operatorName="Goblin King" />:<Chat selected={agent} parent={agent} operator={{name:'Goblin King',avatar:'G'}} draft={draft} setDraft={setDraft} attached={attached} onAttach={files=>files.forEach(file=>{const reader=new FileReader();reader.onload=()=>setAttached(old=>[...old,{name:file.name,type:file.type,size:file.size,encoding:'data-url',content:String(reader.result)}]);reader.readAsDataURL(file);})} onRemoveAttachment={index=>setAttached(old=>old.filter((_,i)=>i!==index))} isNewSession={false} turns={[]} isLoading={false} error="" isSending={Boolean(runtime)} steeringReady={Boolean(runtime)} activeRunId={runtime?.runId??''} liveProgress={[]} liveAnswer={runtime?'Main work continues independently. The side answer has not been injected into this run.':''} onSend={(value,accepted)=>{requests.push(`ordinary Send: ${value}`);accepted?.();setBusy(true);}} onCancel={()=>{inputs=inputs.map(i=>i.intent==='queue_next'&&i.status==='queued'?{...i,status:'held'}:i);setBusy(false);}} selectedAgentId="fixture" resourceAgentId="fixture" sessionId="default" composerResetGeneration={reset} />}</main></>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
