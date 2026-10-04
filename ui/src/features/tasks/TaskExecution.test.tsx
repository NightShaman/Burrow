import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Tasks } from './TasksPage';
import { ConfirmProvider } from '../../app/ConfirmDialog';
import { setActiveApiTarget } from '../../app/api';
const task = { id: 't', projectId: 'p', title: 'Original', description: '', status: 'todo', priority: 'normal', assignedAgentId: 'a', metadata: {}, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
function fixture(delayed = false) {
 let resolve!: (value: Response) => void;
 const terminal = new Promise<Response>(r => { resolve = r; });
 const calls: Array<{ url: string; init?: RequestInit }> = [];
 vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input); calls.push({ url, init });
  if (url.includes('/projects')) return response({ projects: [{ id: 'p', name: 'Project' }] });
  if (url.endsWith('/execute')) return response({ task: { ...task, title: 'Running title', status: 'in_progress' }, execution: delayed ? { runId: 'r', agentId: 'a', sessionId: 's' } : undefined });
  if (url.includes('/runs/active')) return response({ runs: [] });
  if (url.endsWith('/tasks/t') && init?.method === 'PATCH') return response({ task: { ...task, ...JSON.parse(String(init.body)) } });
  if (url.endsWith('/tasks/t')) return delayed ? terminal : response({ task });
  return response({ tasks: [task] });
 }));
 render(<ConfirmProvider><Tasks agents={[]} /></ConfirmProvider>);
 return { calls, resolve };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setActiveApiTarget(undefined); });
it('FE032 commits a delayed terminal refresh before retiring execution, on its captured node', async () => {
 const f = fixture(true); fireEvent.click(await screen.findByText('Original'));
 fireEvent.click(screen.getByRole('button', { name: /Execute/ }));
 await waitFor(() => expect(f.calls.some(c => c.url.endsWith('/tasks/t'))).toBe(true));
 setActiveApiTarget({ id: 'other', name: 'Other', enabled: true, baseUrl: 'https://other.invalid' });
 await act(async () => { f.resolve(response({ task: { ...task, title: 'Terminal title', status: 'done' } })); });
 await screen.findByText('Terminal title');
 expect(screen.queryByLabelText('Task execution progress')).toBeNull();
 expect(f.calls.every(c => !c.url.includes('other.invalid'))).toBe(true);
});
it('FE033 rehydrates visible fields after execute rather than saving stale defaults', async () => {
 const f = fixture(); fireEvent.click(await screen.findByText('Original'));
 fireEvent.click(screen.getByRole('button', { name: /Execute/ }));
 await screen.findByText('Running title');
 expect((screen.getByRole('textbox', { name: /Title/ }) as HTMLInputElement).value).toBe('Running title');
 expect((screen.getByRole('combobox', { name: 'Status' }) as HTMLSelectElement).value).toBe('in_progress');
 fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
 await waitFor(() => expect(f.calls.some(c => c.init?.method === 'PATCH')).toBe(true));
 const saved = JSON.parse(String(f.calls.find(c => c.init?.method === 'PATCH')!.init!.body));
 expect(saved.title).toBe('Running title'); expect(saved.status).toBe('in_progress');
});
it('FE033 refuses to execute a saved task while a different unsaved draft is visible', async () => {
 const f = fixture(); fireEvent.click(await screen.findByText('Original'));
 fireEvent.change(screen.getByRole('textbox', { name: /Title/ }), { target: { value: 'Unsaved' } });
 fireEvent.click(screen.getByRole('button', { name: /Execute/ }));
 expect(f.calls.filter(c => c.url.endsWith('/execute'))).toHaveLength(0);
 expect((screen.getByRole('textbox', { name: /Title/ }) as HTMLInputElement).value).toBe('Unsaved');
});
it('preserves unsaved fields during a delayed terminal response while adopting untouched server fields', async () => {
 const f = fixture(true); fireEvent.click(await screen.findByText('Original'));
 fireEvent.click(screen.getByRole('button', { name: /Execute/ }));
 await waitFor(() => expect(f.calls.some(c => c.url.endsWith('/tasks/t'))).toBe(true));
 fireEvent.change(screen.getByRole('textbox', { name: 'Description' }), { target: { value: 'Keep my notes' } });
 await act(async () => { f.resolve(response({ task: { ...task, title: 'Terminal title', status: 'done' } })); });
 expect((screen.getByRole('textbox', { name: 'Description' }) as HTMLTextAreaElement).value).toBe('Keep my notes');
 expect((screen.getByRole('combobox', { name: 'Status' }) as HTMLSelectElement).value).toBe('done');
});

it('FE032 retries transient terminal failure without retiring the execution panel',async()=>{
 const f=fixture(true); fireEvent.click(await screen.findByText('Original'));
 fireEvent.click(screen.getByRole('button',{name:/Execute/}));
 await waitFor(()=>expect(f.calls.some(c=>c.url.endsWith('/tasks/t'))).toBe(true));
 const base=vi.mocked(fetch).getMockImplementation()!;
 let terminalAttempts=0;
 vi.mocked(fetch).mockImplementation(async(input,init)=>{
  if(String(input).endsWith('/tasks/t')) { terminalAttempts++; return response({task:{...task,title:'Recovered terminal',status:'done'}}); }
  return base(input,init);
 });
 await act(async()=>{f.resolve(new Response('temporary',{status:503}));});
 expect(screen.getByLabelText('Task execution progress')).toBeTruthy();
 await screen.findByText('Recovered terminal',{}, {timeout:2500});
 expect(terminalAttempts).toBe(1);
 expect(screen.queryByLabelText('Task execution progress')).toBeNull();
});

it('FE032 ignores an older terminal response after a newer execution starts', async () => {
 const f = fixture(true);
 fireEvent.click(await screen.findByText('Original'));
 fireEvent.click(screen.getByRole('button', { name: /Execute/ }));
 await waitFor(() => expect(f.calls.some(c => c.url.endsWith('/tasks/t'))).toBe(true));
 const base = vi.mocked(fetch).getMockImplementation()!;
 vi.mocked(fetch).mockImplementation(async (input, init) => {
  if (String(input).endsWith('/execute')) return response({ task: {...task, title:'New run title', status:'in_progress'}, execution:{runId:'new-run',agentId:'a',sessionId:'new-session'} });
  if (String(input).includes('/runs/active')) return response({runs:[{runId:'new-run',phase:'thinking'}]});
  return base(input, init);
 });
 fireEvent.click(screen.getByRole('button', { name: /Execute/ }));
 await screen.findByText('New run title');
 await act(async () => { f.resolve(response({task:{...task,title:'Obsolete terminal',status:'done'}})); });
 expect(screen.queryByText('Obsolete terminal')).toBeNull();
 expect(screen.getByLabelText('Task execution progress')).toBeTruthy();
});
