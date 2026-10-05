import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { render, renderHook, fireEvent, screen, waitFor, act, cleanup } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentMcpTools } from '../../src/features/settings/AgentMcpTools';
import { useModelSelectionWriter } from '../../src/app/useModelSelectionWriter';
import { ConfirmProvider } from '../../src/app/ConfirmDialog';
import { useModelConnectionEditor } from '../../src/features/settings/useModelConnectionEditor';
import { useChatSession } from '../../src/features/chat/useChatSession';
import type { Agent } from '../../src/app/types';
const targets=[{id:'local',name:'Fixture',baseUrl:'',enabled:true,kind:'local'}] as any;
async function bridge(data:object):Promise<any> {
 const dir=process.env.UI_PERSISTED_BRIDGE; if(!dir) throw new Error('owned bridge required');
 const name=randomUUID()+'.request'; await fs.writeFile(join(dir,name+'.tmp'),JSON.stringify(data));await fs.rename(join(dir,name+'.tmp'),join(dir,name));
 const deadline=Date.now()+15000;
 while(Date.now()<deadline) {try {const response=JSON.parse(await fs.readFile(join(dir,name+'.response'),'utf8'));if(response.error)throw new Error(response.error);return response.value;}catch(error:any){if(error.code!=='ENOENT')throw error;}await new Promise(r=>setTimeout(r,5));}throw new Error('bridge timeout');
}
vi.mock('../../src/app/api',()=>({api:async(path:string,init:any={})=>{if(path!=='/api/settings/model-connections')throw new Error('unowned global request '+path);const r=await bridge({kind:'connections',method:init.method||'GET',body:init.body?JSON.parse(init.body):undefined});if(r.status!==200)throw new Error(r.body.error);return r.body;},apiForTarget:async (_target:any,path:string,init:any={})=>{
 if(path.startsWith('/api/sessions')) {const r=await bridge({kind:'session',method:init.method||'GET',path,body:init.body?JSON.parse(init.body):undefined});if(r.status!==200)throw new Error(r.body.error);return r.body;}
 if(path==='/api/settings/mcp-connections') return {connections:[{id:'c',name:'Fixture',transport:'http',tools:[{name:'one'},{name:'two'}]}]};
 const match=path.match(/^\/api\/agents\/(a|b)\/(mcp-tools|model-selection)$/);if(!match)throw new Error('unowned request '+path);
 const res=await bridge({method:init.method||'GET',id:match[1],kind:match[2],body:init.body?JSON.parse(init.body):undefined});if(res.status!==200)throw new Error(res.body?.error||'load failed');return res.body;
}}));
afterEach(cleanup);
it('FE005: failed owner read cannot Save; retry saves through actual grants route and reloads PG',async()=>{
 const grant=(toolName:string)=>({connectionId:'c',toolName,enabled:true});
 await bridge({method:'PUT',id:'a',kind:'mcp-tools',body:{tools:[grant('one')]}});
 await bridge({method:'PUT',id:'b',kind:'mcp-tools',body:{tools:[grant('two')]}});
 const view=render(<AgentMcpTools agentId="a" targets={targets}/>);
 await waitFor(()=>expect((screen.getByRole('button',{name:'Save MCP tools'}) as HTMLButtonElement).disabled).toBe(false));
 await bridge({control:'failure',enabled:true});const before=(await bridge({control:'writes'})).writes.length;
 view.rerender(<AgentMcpTools agentId="b" targets={targets}/>);
 await screen.findByRole('alert');const save=screen.getByRole('button',{name:'Save MCP tools'});expect((save as HTMLButtonElement).disabled).toBe(true);fireEvent.click(save);
 expect((await bridge({control:'writes'})).writes.length).toBe(before);
 await bridge({control:'failure',enabled:false});fireEvent.click(screen.getByRole('button',{name:'Retry loading'}));
 await screen.findByText('two');await waitFor(()=>expect((save as HTMLButtonElement).disabled).toBe(false));
 fireEvent.click(screen.getByLabelText('one'));fireEvent.click(save);
 await waitFor(async()=>expect((await bridge({method:'GET',id:'b',kind:'mcp-tools'})).body.tools.length).toBe(2));
 view.unmount();render(<AgentMcpTools agentId="b" targets={targets}/>);
 await waitFor(()=>expect((screen.getByLabelText('one') as HTMLInputElement).checked).toBe(true));expect((screen.getByLabelText('two') as HTMLInputElement).checked).toBe(true);
 expect((await bridge({method:'GET',id:'a',kind:'mcp-tools'})).body.tools.map((t:any)=>t.toolName)).toEqual(['one']);
});
it('FE051: held older write then rapid latest intent persists latest and reloads through actual route',async()=>{
 const agent={id:'a',provider:'Fixture',model:'one',effort:'medium',temperature:0.5} as Agent;
 const commit=vi.fn(),report=vi.fn();const providers=[{id:'p',provider:'Fixture',models:['one','two']}] as any;
 const h=renderHook(()=>useModelSelectionWriter(targets,providers,commit,report));
 await bridge({control:'hold'});let pending:Promise<void>;
 act(()=>{pending=h.result.current(agent,{temperature:0.1});});
 await waitFor(async()=>expect((await bridge({control:'held'})).entered).toBe(true));
 await act(async()=>{await h.result.current(agent,{temperature:0.9});await h.result.current(agent,{model:'two'});});
 await bridge({control:'release'});await act(async()=>{await pending!;});
 expect(report).not.toHaveBeenCalled();expect(commit).toHaveBeenCalledTimes(1);expect(commit.mock.calls[0][1]).toMatchObject({model:'two',temperature:0.9});
 h.unmount();const reloaded=await bridge({method:'GET',id:'a',kind:'model-selection'});expect(reloaded.body.selection).toMatchObject({model:'two',temperature:0.9});
 expect((await bridge({method:'GET',id:'b',kind:'model-selection'})).body.selection).toBeNull();
});

it('FE009: actual editor preserves unchecked/manual metadata through real routes and PG reload',async()=>{
 const models=[{id:'disabled',selected:false,manual:true,displayName:'Disabled fixture',discoveredContextWindow:64000,contextWindowOverride:32000,outputTokens:4096,discoveredInput:['text','image'],acceptedInputOverride:['text'],discoveredOutput:['text'],reasoningEfforts:['low','high'],defaultReasoningEffort:'low',supportsTemperature:false},{id:'enabled',selected:true,manual:true,acceptedInputOverride:['text']}];
 const h=renderHook(()=>useModelConnectionEditor({onModelConnectionsChanged:async()=>{}}),{wrapper:ConfirmProvider});
 act(()=>h.result.current.editProvider({id:'p',provider:'Fixture',apiType:'openai',url:'http://127.0.0.1:1/v1',models:['enabled'],connectionModels:models} as any));
 await act(async()=>{await h.result.current.saveProvider();});
 expect(h.result.current.requestError).toBe('');h.unmount();
 const read=await bridge({kind:'connections',method:'GET'});expect(read.status).toBe(200);
 const saved=read.body.connections.find((c:any)=>c.id==='p');
 for(const model of models) expect(saved.models.find((m:any)=>m.id===model.id)).toMatchObject(model);
 const reload=renderHook(()=>useModelConnectionEditor({onModelConnectionsChanged:async()=>{}}),{wrapper:ConfirmProvider});
 act(()=>reload.result.current.editProvider({...saved,url:saved.baseUrl,connectionModels:saved.models}));
 expect(reload.result.current.availableModels.find(m=>m.id==='disabled')).toMatchObject(models[0]);
 await act(async()=>{await reload.result.current.saveProvider();});
 expect((await bridge({kind:'connections',method:'GET'})).body.connections.find((c:any)=>c.id==='p').models).toEqual(saved.models);
});
it('FE012: actual session hook reset retains named next-send identity and real runtime excludes old context',async()=>{
 localStorage.clear();await bridge({control:'seedSessions'});
 const h=renderHook(()=>useChatSession('a',targets));
 await waitFor(()=>expect(h.result.current.sessions.length).toBeGreaterThan(0));
 act(()=>h.result.current.selectSession('named'));
 await waitFor(()=>expect(h.result.current.sessionId).toBe('named'));
 const before=await bridge({control:'sessionEvidence'});
 await act(async()=>{expect(await h.result.current.resetSession()).toBe(true);});
 expect(h.result.current.sessionId).toBe('named');expect(h.result.current.turns).toEqual([]);
 act(()=>h.result.current.leaveNewSessionForMessage());
 const sent=await bridge({kind:'chat',body:{agentId:'a',sessionId:h.result.current.sessionId,message:'after-reset'}});
 expect(sent.status).toBe(200);
 const evidence=await bridge({control:'sessionEvidence'});
 expect(evidence.default).toEqual(before.default);
 expect(JSON.stringify(evidence.prompts)).toContain('after-reset');
 expect(JSON.stringify(evidence.prompts)).not.toContain('before-named');
 expect(JSON.stringify(evidence.prompts)).not.toContain('before-default');
 expect(JSON.stringify(evidence.named)).toContain('after-reset');
});
