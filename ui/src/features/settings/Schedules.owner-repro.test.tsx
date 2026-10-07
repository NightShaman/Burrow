import {act,cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import {afterEach,expect,it,vi} from 'vitest';
import {api} from '../../app/api';
import {ConfirmProvider} from '../../app/ConfirmDialog';
import {AgentSchedules} from './AgentSchedules';
vi.mock('../../app/api',async original=>({...await original<typeof import('../../app/api')>(),api:vi.fn()}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
it('audit: late save of agent A must not replace agent B schedule inventory',async()=>{
 const job=(id:string)=>({id:`job-${id}`,agentId:id,name:`Job ${id}`,prompt:`Prompt ${id}`,cron:'0 9 * * *',timezone:'UTC',enabled:true});
 let resolveSave!:(value:unknown)=>void;
 const pendingSave=new Promise(r=>resolveSave=r);
 vi.mocked(api).mockImplementation(async(path,init)=>{
  if(init?.method==='PATCH')return pendingSave;
  if(path==='/api/settings/timezone')return {timezone:'UTC'};
  return {jobs:[job(path.includes('agentId=b')?'b':'a')]};
 });
 const view=(id:string)=><ConfirmProvider><AgentSchedules agentId={id} savedProviders={[]}/></ConfirmProvider>;
 const {rerender}=render(view('a'));
 fireEvent.click(await screen.findByRole('button',{name:/Job a/}));
 fireEvent.click(screen.getByRole('button',{name:'Save job'}));
 await waitFor(()=>expect(vi.mocked(api).mock.calls.some(([,init])=>init?.method==='PATCH')).toBe(true));
 rerender(view('b'));
 await screen.findByRole('button',{name:/Job b/});
 await act(async()=>{resolveSave({});await pendingSave;});
 expect(screen.queryByRole('button',{name:/Job a/})).toBeNull();
 expect(screen.getByRole('button',{name:/Job b/})).toBeTruthy();
});

it('audit: actions after switching to B must not edit agent A jobs',async()=>{
 const job=(id:string)=>({id:`job-${id}`,agentId:id,name:`Job ${id}`,prompt:`Prompt ${id}`,cron:'0 9 * * *',timezone:'UTC',enabled:true});
 let resolveSave!:(value:unknown)=>void;
 const pendingSave=new Promise(r=>resolveSave=r);
 vi.mocked(api).mockImplementation(async(path,init)=>{
  if(init?.method==='PATCH')return pendingSave;
  if(path==='/api/settings/timezone')return {timezone:'UTC'};
  return {jobs:[job(path.includes('agentId=b')?'b':'a')]};
 });
 const view=(id:string)=><ConfirmProvider><AgentSchedules agentId={id} savedProviders={[]}/></ConfirmProvider>;
 const {rerender}=render(view('a'));
 fireEvent.click(await screen.findByRole('button',{name:/Job a/}));
 fireEvent.click(screen.getByRole('button',{name:'Save job'}));
 await waitFor(()=>expect(vi.mocked(api).mock.calls.some(([,init])=>init?.method==='PATCH')).toBe(true));
 rerender(view('b'));
 await screen.findByRole('button',{name:/Job b/});
 await act(async()=>{resolveSave({});await pendingSave;});
 fireEvent.click(screen.getByRole('button',{name:/Job b/}));
 fireEvent.change(screen.getByLabelText('Prompt'),{target:{value:'Intended for selected agent B'}});
 fireEvent.click(screen.getByRole('button',{name:'Save job'}));
 await waitFor(()=>expect(vi.mocked(api).mock.calls.filter(([,init])=>init?.method==='PATCH')).toHaveLength(2));
 const [path,init]=vi.mocked(api).mock.calls.filter(([,init])=>init?.method==='PATCH')[1];
 expect(JSON.parse(init!.body as string).prompt).toBe('Intended for selected agent B');
 expect(path).toBe('/api/scheduled-jobs/job-b');
});
