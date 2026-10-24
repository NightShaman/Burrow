import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Tasks } from './TasksPage';
import { ConfirmProvider } from '../../app/ConfirmDialog';
const a = { id:'a',projectId:'p',title:'Task A',description:'',status:'todo',priority:'normal',assignedAgentId:'agent',metadata:{},createdAt:'2026-01-01',updatedAt:'2026-01-01' };
const b = {...a,id:'b',title:'Task B'};
const response=(body:unknown)=>new Response(JSON.stringify(body),{headers:{'content-type':'application/json'}});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
it.each(['save', 'delete', 'execute', 'failure', 'reopen'])('late %s completion preserves the newer task editor',async(operation)=>{
 let finish!: (v:Response)=>void;
 const pending=new Promise<Response>(r=>finish=r);
 vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const url=String(input);
  if(url.endsWith('/projects')) return response({projects:[{id:'p',name:'Project'}]});
  if ((url.endsWith('/tasks/a') && ['PATCH', 'DELETE'].includes(init?.method ?? '')) || url.endsWith('/tasks/a/execute')) return pending;
  if(url.includes('/tasks/a/')) return response({activities:[],attachments:[]});
  if(url.includes('/tasks/b/')) return response({activities:[],attachments:[]});
  return response({tasks:[a,b]});
 }));
 const onDispatch = vi.fn();
 render(<ConfirmProvider><Tasks agents={[]} onDispatch={onDispatch}/></ConfirmProvider>);
 fireEvent.click(await screen.findByText('Task A'));
 fireEvent.click(screen.getByRole('button',{name: operation === 'delete' ? /⌫ Delete/ : operation === 'execute' ? /Execute/ : 'Save changes'}));
 if (operation === 'delete') { fireEvent.click(await screen.findByRole('button', {name:'Delete task'})); await act(async()=>{}); }
 fireEvent.click(screen.getByRole('button',{name:'Close task editor'}));
 fireEvent.click(screen.getByText(operation === 'reopen' ? 'Task A' : 'Task B'));
 fireEvent.change(screen.getByRole('textbox',{name:/Title/}),{target:{value:'B unsaved valuable edit'}});
 expect((screen.getByRole('textbox',{name:/Title/}) as HTMLInputElement).value).toBe('B unsaved valuable edit');
 expect((screen.getByRole('button', {name:'Save changes'}) as HTMLButtonElement).disabled).toBe(false);
 await act(async()=>{finish(operation === 'failure' ? new Response('failure', {status:500}) : response({task:a, execution:{sessionId:'s',agentId:'agent'}}));await pending;});
 expect(screen.getByRole('dialog',{name:'Edit task'})).toBeTruthy();
 expect(screen.getByDisplayValue('B unsaved valuable edit')).toBeTruthy();
 expect(screen.queryByRole('alert')).toBeNull();
 expect((screen.getByRole('button', {name:'Save changes'}) as HTMLButtonElement).disabled).toBe(false);
 expect(onDispatch).not.toHaveBeenCalled();
});

it.each(['success', 'failure'])('late project save %s preserves a newly opened project draft', async outcome => {
 let finish!: (value: Response) => void;
 const pending = new Promise<Response>(resolve => { finish = resolve; });
 vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  if (init?.method === 'PATCH') return pending;
  if (String(input).endsWith('/projects')) return response({projects:[{id:'p',name:'Project'}]});
  return response({tasks:[a,b]});
 }));
 render(<ConfirmProvider><Tasks agents={[]}/></ConfirmProvider>);
 await screen.findByText('Task A');
 fireEvent.click(screen.getByRole('button', {name:'Manage projects'}));
 fireEvent.click(screen.getByRole('button', {name:'Edit'}));
 fireEvent.click(screen.getByRole('button', {name:'Save project'}));
 fireEvent.click(screen.getByRole('button', {name:'Cancel'}));
 fireEvent.click(screen.getByRole('button', {name:'Edit'}));
 fireEvent.change(screen.getByRole('textbox', {name:/Project name/}), {target:{value:'New project draft'}});
 await act(async () => { finish(outcome === 'success' ? response({project:{id:'p',name:'Saved project'}}) : new Response('failure', {status:500})); await pending; });
 expect(screen.getByDisplayValue('New project draft')).toBeTruthy();
 expect((screen.getByRole('button', {name:'Save project'}) as HTMLButtonElement).disabled).toBe(false);
 expect(screen.queryByRole('alert')).toBeNull();
});

it.each([false, true])('queues documents and retries upload failures without recreating the task (%s)', async fail => {
 let creates = 0;
 const uploads: string[] = [];
 vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith('/projects')) return response({ projects: [{ id: 'p', name: 'Project' }] });
  if (url.endsWith('/attachments') && init?.method === 'POST') {
   uploads.push(JSON.parse(String(init.body)).name);
   if (fail && uploads.length === 2) return new Response('Upload failed', { status: 500 });
   return response({});
  }
  if (url.endsWith('/tasks') && init?.method === 'POST') { creates++; return response({ task: a }); }
  if (url.endsWith('/tasks/a') && init?.method === 'PATCH') return response({ task: a });
  if (url.includes('/tasks/a/')) return response({ attachments: [], events: [] });
  return response({ tasks: [] });
 }));
 render(<ConfirmProvider><Tasks agents={[]} /></ConfirmProvider>);
 fireEvent.click(await screen.findByRole('button', { name: /New task/ }));
 fireEvent.change(screen.getByRole('textbox', { name: /Title/ }), { target: { value: 'Task A' } });
 fireEvent.change(screen.getByLabelText('Attach document'), { target: { files: [new File(['a'], 'first.txt'), new File(['b'], 'second.txt')] } });
 expect(screen.getByRole('button', { name: 'Remove first.txt' })).toBeTruthy();
 fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
 if (fail) {
  await screen.findByText(/Task saved, but a document/);
  expect(screen.queryByRole('button', { name: 'Remove first.txt' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Remove second.txt' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
 }
 await vi.waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
 expect(creates).toBe(1);
 expect(uploads).toEqual(fail ? ['first.txt', 'second.txt', 'second.txt'] : ['first.txt', 'second.txt']);
});
