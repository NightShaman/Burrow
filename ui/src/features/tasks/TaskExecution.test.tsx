import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { Tasks } from './TasksPage';
import { ConfirmProvider } from '../../app/ConfirmDialog';
const task = { id: 't', projectId: 'p', title: 'Original', description: '', status: 'todo', priority: 'normal', assignedAgentId: 'a', metadata: {}, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
const response = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
function fixture(delayed = false, onDispatch = vi.fn()) {
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
 render(<ConfirmProvider><Tasks agents={[]} onDispatch={onDispatch} /></ConfirmProvider>);
 return { calls, resolve };
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
it('dispatches the returned agent/session without board polling or progress', async () => {
 const onDispatch = vi.fn(); const f = fixture(true, onDispatch);
 fireEvent.click(await screen.findByText('Original'));
 fireEvent.click(screen.getByRole('button', { name: /Execute/ }));
 await waitFor(() => expect(onDispatch).toHaveBeenCalledWith('s', 'a'));
 await act(async () => { await new Promise(resolve => setTimeout(resolve, 1100)); });
 expect(f.calls.some(c => c.url.includes('/runs/active') || c.url.endsWith('/tasks/t'))).toBe(false);
 expect(screen.queryByLabelText('Task execution progress')).toBeNull();
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
