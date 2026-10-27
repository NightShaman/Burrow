import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Chat } from './ChatPage';
import { api } from '../../app/api';
import type { ChatInput } from './chatInputs';
import type { Agent } from '../../app/types';
vi.mock('../../app/api', async original => ({ ...await original<typeof import('../../app/api')>(), api:vi.fn() }));
const agent: Agent = { id:'agent',name:'Hatchet',avatar:'H',activity:'',context:null,provider:'',model:'',effort:'',temperature:1,workspace:'',files:[],subagents:[] };
const input: ChatInput = { id:'side',intent:'side_question',status:'succeeded',agentId:'agent',sessionId:'default',generation:7,targetRunId:'main',runId:'side-run',createdAt:'2026-10-26T12:00:00Z',startedAt:null,completedAt:'2026-10-26T12:01:00Z',message:'What does this mean?',attachments:[],result:{ok:true,answerText:'A snapshot answer.',decision:null,blockers:[]},error:null,snapshot:{id:'snapshot',capturedAt:'2026-10-26T12:00:00Z',originRunId:'main',phase:'working',entryCount:9},promotedFrom:null,position:null };
function fixture(overrides: Partial<Parameters<typeof Chat>[0]> = {}) {
 const props: Parameters<typeof Chat>[0] = {selected:agent,parent:agent,operator:{name:'King',avatar:'K'},draft:'Next message',setDraft:vi.fn(),attached:[],onAttach:vi.fn(),onRemoveAttachment:vi.fn(),isNewSession:false,turns:[],isLoading:false,error:'',isSending:true,steeringReady:true,activeRunId:'main',liveProgress:[],liveAnswer:'Main work continues.',onSend:vi.fn(),onCancel:vi.fn(),selectedAgentId:'agent',resourceAgentId:'agent',sessionId:'default',...overrides};
 return {props,...render(<Chat {...props} />)};
}
beforeEach(() => { vi.mocked(api).mockReset(); vi.mocked(api).mockImplementation(async path => path.includes('/steering?') ? {steering:[]} : path.includes('/api/chat/inputs?') ? {generation:7,inputs:[]} : {} as never); });
afterEach(cleanup);
const posts = () => vi.mocked(api).mock.calls.filter(([,request]) => request?.method === 'POST');
it('busy default queues without steering readiness and resets the chosen intent only after acceptance', async () => {
 const {props} = fixture({steeringReady:false});
 await waitFor(() => expect(screen.getByRole('button',{name:'Queue next'})).toHaveProperty('disabled',false));
 vi.mocked(api).mockResolvedValueOnce({input:{...input,intent:'queue_next',status:'queued',message:'Next message'}});
 fireEvent.click(screen.getByRole('button',{name:'Queue next'}));
 await waitFor(() => expect(screen.getByRole('textbox',{name:'Message'})).toHaveProperty('value',''));
 expect(posts()[0][0]).toBe('/api/chat/inputs');
 expect(JSON.parse(posts()[0][1]!.body as string)).toMatchObject({intent:'queue_next',generation:7,targetRunId:'main'});
 expect(props.onSend).not.toHaveBeenCalled();
});
it('a rejected exact-run steer preserves draft and attachments and never auto-retries normally after completion', async () => {
 const attachment = {name:'note.txt',type:'text/plain',size:1,encoding:'data-url' as const,content:'data:text/plain;base64,YQ=='};
 const {props,rerender} = fixture({attached:[attachment]});
 await waitFor(() => expect(screen.getByRole('button',{name:'Queue next'})).toHaveProperty('disabled',false));
 fireEvent.change(screen.getByRole('combobox',{name:'Delivery intent'}),{target:{value:'steer'}});
 vi.mocked(api).mockRejectedValueOnce(Object.assign(new Error('chat_run_not_found'),{status:404}));
 fireEvent.click(screen.getByRole('button',{name:'Steer'}));
 await screen.findByText(/Could not steer this run/);
 expect(screen.getByRole('textbox',{name:'Message'})).toHaveProperty('value','Next message');
 expect(props.onRemoveAttachment).not.toHaveBeenCalled();
 rerender(<Chat {...props} isSending={false} activeRunId="" />);
 expect(props.onSend).not.toHaveBeenCalled(); expect(posts()).toHaveLength(1);
});
it('side answers are inline snapshots; promotion stages editable text and only explicit submit links into main', async () => {
 vi.mocked(api).mockImplementation(async path => path.includes('/steering?') ? {steering:[]} : path.includes('/api/chat/inputs?') ? {generation:7,inputs:[input]} : {} as never);
 const {props} = fixture({draft:''});
 const promote = await screen.findByRole('button',{name:'Use in main conversation'});
 expect(screen.getByText('Main work continues.')).toBeTruthy();
 expect(screen.getAllByText(/snapshot at/).length).toBe(2);
 fireEvent.click(promote);
 expect(screen.getByRole('textbox',{name:'Message'})).toHaveProperty('value','A snapshot answer.');
 expect(posts()).toHaveLength(0); expect(props.onSend).not.toHaveBeenCalled();
 fireEvent.change(screen.getByRole('textbox',{name:'Message'}),{target:{value:'Edited instruction'}});
 vi.mocked(api).mockResolvedValueOnce({input:{...input,id:'promotion',intent:'queue_next',status:'queued'}});
 fireEvent.keyDown(screen.getByRole('textbox',{name:'Message'}),{key:'Enter'});
 await waitFor(() => expect(posts()).toHaveLength(1));
 expect(JSON.parse(posts()[0][1]!.body as string)).toMatchObject({promotedFrom:'side',message:'Edited instruction',intent:'queue_next'});
});
it('side submission retains native attachments and does not cancel or send main work', async () => {
 const attachment = {name:'sketch.png',type:'image/png',size:2,encoding:'data-url' as const,content:'data:image/png;base64,aGk='};
 const {props} = fixture({attached:[attachment]});
 await waitFor(() => expect(screen.getByRole('button',{name:'Queue next'})).toHaveProperty('disabled',false));
 fireEvent.change(screen.getByRole('combobox',{name:'Delivery intent'}),{target:{value:'side_question'}});
 vi.mocked(api).mockResolvedValueOnce({input:{...input,status:'queued'}});
 fireEvent.click(screen.getByRole('button',{name:'Side question'}));
 await waitFor(() => expect(screen.getByRole('combobox',{name:'Delivery intent'})).toHaveProperty('value','queue_next'));
 expect(JSON.parse(posts()[0][1]!.body as string)).toMatchObject({intent:'side_question',attachments:[attachment],targetRunId:'main'});
 expect(props.onSend).not.toHaveBeenCalled(); expect(props.onCancel).not.toHaveBeenCalled();
});
it('held queue offers explicit resume-all and cancellation', async () => {
 vi.mocked(api).mockImplementation(async path => path.includes('/steering?') ? {steering:[]} : path.includes('/api/chat/inputs?') ? {generation:7,inputs:[{...input,intent:'queue_next',status:'held',result:null}]} : {} as never);
 const {props} = fixture({isSending:false,activeRunId:''});
 const resume = await screen.findByRole('button',{name:'Resume queue'});
 vi.mocked(api).mockResolvedValueOnce({input:{...input,intent:'queue_next',status:'queued'},inputs:[{...input,intent:'queue_next',status:'queued'}]});
 fireEvent.click(resume);
 await waitFor(() => expect(posts()).toHaveLength(1));
 expect(posts()[0][0]).toBe('/api/chat/inputs/side/resume'); expect(props.onSend).not.toHaveBeenCalled();
});
it.each(['steer','side_question'])('never silently retargets selected %s when main ends or is replaced', async intent => {
 const {props,rerender} = fixture();
 await waitFor(() => expect(screen.getByRole('button',{name:'Queue next'})).toHaveProperty('disabled',false));
 fireEvent.change(screen.getByRole('combobox',{name:'Delivery intent'}),{target:{value:intent}});
 rerender(<Chat {...props} activeRunId="replacement" />);
 expect(screen.getByRole('button',{name:intent==='steer'?'Steer':'Side question'})).toHaveProperty('disabled',true);
 fireEvent.keyDown(screen.getByRole('textbox',{name:'Message'}),{key:'Enter'});
 rerender(<Chat {...props} isSending={false} activeRunId="" />);
 fireEvent.keyDown(screen.getByRole('textbox',{name:'Message'}),{key:'Enter'});
 expect(posts()).toHaveLength(0); expect(props.onSend).not.toHaveBeenCalled();
});
it('steering an explicitly staged promotion carries the source link and generation', async () => {
 vi.mocked(api).mockImplementation(async path => path.includes('/steering?') ? {steering:[]} : path.includes('/api/chat/inputs?') ? {generation:7,inputs:[input]} : {} as never);
 fixture({draft:''});
 fireEvent.click(await screen.findByRole('button',{name:'Use in main conversation'}));
 fireEvent.change(screen.getByRole('combobox',{name:'Delivery intent'}),{target:{value:'steer'}});
 vi.mocked(api).mockResolvedValueOnce({steering:{id:'steer',status:'pending',message:'A snapshot answer.',createdAt:input.createdAt}});
 fireEvent.click(screen.getByRole('button',{name:'Steer'}));
 await waitFor(()=>expect(posts()).toHaveLength(1));
 expect(JSON.parse(posts()[0][1]!.body as string)).toMatchObject({promotedFrom:'side',generation:7});
});
it('deduplicates native queued projection against recovered runtime user bubble', async () => {
 const metadata = {id:'queue',intent:'queue_next' as const,status:'running' as const};
 fixture({runtimeUserMessage:'Next message',turns:[{type:'event',role:'user',content:'Next message',metadata:{chatInput:metadata}}, {type:'message',role:'user',content:'Next message',runId:'main',metadata:{chatInput:{...metadata,projection:true}}}]});
 expect(screen.getAllByText('Next message').filter(node=>node.tagName!=='TEXTAREA')).toHaveLength(1);
});
